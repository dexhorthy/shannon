// Shannon-backed support worker HTTP server. Paired with the Python supervisor
// over a docker network; the supervisor POSTs /invoke/stream per turn and the
// server runs Shannon's tmux-mode query() and pipes the result back as SSE.
//
// Contract (matches src/agents/shannon/support_agent.py in idoneachat-ai-agent):
//   GET  /health         → 200 { ok: true }   (after Shannon is importable)
//   POST /invoke/stream  → text/event-stream of:
//     event: thinking | status | response | result
//
// Run: bun /app/support-server.mjs
//
// Design notes
//  - Pure helpers (sseFrame, processShannonStream, rewriteCwd) are exported so
//    `support-server.test.ts` can drive them without spinning up an HTTP listener.
//  - `mcp_config` (a `{mcpServers: {...}}` object) is written to a per-request
//    temp file under tmpdir and forwarded via Shannon's `mcpConfig: [path]`
//    (which is a FILE PATH list, not the config itself — confirmed in src/sdk.ts).
//  - AbortController is tied to the incoming Request.signal so a client
//    disconnect aborts query(), which SIGTERMs the claude subprocess.
//  - cwd path-rewrite: the Python container mounts the workspace at
//    `/workspaces/<chat_id>` (its own mount point); the Shannon container
//    mounts the SAME volume at `/workspace`. We rewrite any path starting with
//    `/workspaces/` to `/workspace` before forwarding to Shannon, so the
//    Python side can stay simple.

import { query } from "@dexh/shannon";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.SHANNON_SUPPORT_PORT ?? 8088);

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Format a single SSE frame. */
export function sseFrame(eventName, payload) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Rewrite a cwd path coming from the Python supervisor.
 *
 * The Python container mounts the per-user workspace at `/workspaces/<chat_id>`
 * (its container-internal path). The Shannon container has the SAME host volume
 * mounted at `/workspace`. So when the Python side hands us its own view of
 * the path, we need to flip it to Shannon's view before forwarding to query().
 *
 * Leaves any other path untouched (so callers that already pass `/workspace`
 * or an absolute host path keep working).
 */
export function rewriteCwd(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return cwd;
  if (cwd === "/workspace" || cwd.startsWith("/workspace/")) return cwd;
  if (cwd.startsWith("/workspaces/")) return "/workspace";
  return cwd;
}

/** Extract the un-prefixed tool name from Shannon's `mcp__<server>__<tool>` form. */
export function stripMcpPrefix(name) {
  if (typeof name !== "string") return "";
  return name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "");
}

/**
 * Process a Shannon `query()` async iterable into SSE frames + final metadata.
 *
 * Pure-ish: takes the iterable + a `write(string)` callback. Returns the
 * final `{sessionId, totalCost, durationMs, toolCalls, isError, error}` so
 * the caller can either build a synthetic `result` frame (on early failure)
 * or rely on what the Shannon `result` message already emitted.
 *
 * Mapping (matches the Python parser in src/agents/shannon/support_agent.py):
 *   system/init   → capture session_id  (no frame emitted)
 *   assistant     → iterate content blocks:
 *                     thinking block → event: thinking
 *                     text block     → event: status (interim chatter)
 *                     tool_use block →
 *                       - send_response → event: response (input.message)
 *                       - other tool   → event: status (tool name)
 *   result        → event: result  (also captures the totals)
 *
 * `stream_event` (partial AssistantMessage deltas, only emitted when
 * includePartialMessages is on) are intentionally NOT mapped to deltas here:
 * tmux mode coalesces per turn, so the AssistantMessage carries the full
 * content. Mapping deltas would risk double-emitting the same prose.
 */
export async function processShannonStream(
  iter,
  write,
  initialSessionId = null,
  sessionIdRef = null,
  progressRef = null,
) {
  // sessionIdRef is an optional `{value: ...}` container the caller passes so
  // it can read the most-recently captured session id even if `iter` throws
  // mid-iteration (Shannon's underlying process can exit non-zero after
  // yielding system/init but before the result message, e.g. on
  // "Timed out waiting for assistant reply"). Without this, the catch path
  // in buildHandler() would fall back to the inbound request's session_id
  // (often null on first turn) and the client would lose the just-created
  // session id, breaking --resume on the next turn.
  const ref = sessionIdRef ?? { value: initialSessionId };
  if (ref.value == null) ref.value = initialSessionId;

  // progressRef is an optional `{toolCalls, totalCost, durationMs, resultEmitted}`
  // container for the same reason as sessionIdRef but for tool-call / cost /
  // duration telemetry: the synthetic "no_result_message" frame and the
  // catch-path synthetic frame in buildHandler() used to write `tool_calls: []`
  // / cost:0 / duration_ms:0 and throw away whatever we had already accumulated.
  // That matters in real life: the enforcer's resumed second attempt can call
  // `mcp__support_tools__send_response` AND THEN Shannon exits with
  // "Timed out waiting for assistant reply" before emitting the result line —
  // so the slot is populated, the user gets their reply, but the SSE result
  // frame the caller sees has `tool_calls: []`. With progressRef the caller
  // sees the actual `["send_response"]` it accumulated.
  //
  // `resultEmitted` lives on the ref too so the catch path in buildHandler can
  // tell whether a real result already went out (it must NOT emit a second
  // synthetic on top of a real one — the python worker treats each result
  // event as the final state of the turn, so two would clobber).
  const progress = progressRef ?? {
    toolCalls: [],
    totalCost: 0,
    durationMs: 0,
    resultEmitted: false,
  };
  // Always reset at the start — caller-provided refs are reused across
  // sibling attempts inside the rotation/enforcer loop, and stale state would
  // double-count or surface tool calls from a prior attempt. `.length = 0`
  // clears IN PLACE so the outer reference the caller holds reflects the reset.
  progress.toolCalls.length = 0;
  progress.totalCost = 0;
  progress.durationMs = 0;
  progress.resultEmitted = false;

  let isError = false;

  // Deduplicate tool_use blocks across the two ways Shannon surfaces them:
  //
  //   1. `shannon_tool_use` events from runShannon's `agentEvents` — covers
  //      tool_use blocks in EVERY row of the turn (turnRows), including
  //      rows that are NOT `assistant.row` (the row waitForAssistantReply
  //      returned).
  //   2. `tool_use` blocks inside the chosen assistant message — covers
  //      whatever was in `assistant.row` specifically.
  //
  // Concrete failure mode we're protecting against: the support agent often
  // emits text first (row N) THEN a single send_response tool_use (row N+1).
  // assistantReplyFromRows picks row N as the reply, so the assistant
  // message Shannon yields has only text — the tool_use is ONLY visible via
  // shannon_tool_use. Without handling that event, send_response is invisible
  // to the caller. Without dedup, the simpler "agent emits text + tool_use
  // in ONE row" case (which the existing tests use) would double-count.
  const seenToolUseIds = new Set();

  for await (const msg of iter) {
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") continue;

    if (msg.type === "system" && msg.subtype === "init") {
      if (typeof msg.session_id === "string" && msg.session_id) {
        ref.value = msg.session_id;
      }
      continue;
    }

    if (msg.type === "shannon_tool_use") {
      // Shannon's `toSdkToolUseEvents` emits these per tool_use block in
      // every turnRow. Use them as the primary source so we don't miss
      // tool calls in rows OTHER than the chosen assistant.row.
      if (typeof msg.session_id === "string" && msg.session_id) {
        ref.value = msg.session_id;
      }
      const id = typeof msg.tool_use_id === "string" ? msg.tool_use_id : null;
      const rawName = typeof msg.tool_name === "string" ? msg.tool_name : "";
      const name = stripMcpPrefix(rawName);
      if (!name) continue;
      // Skip if we already recorded this same tool_use under either path —
      // the same id can arrive twice when assistant.row is the row containing
      // the tool_use (it's in agentEvents AND in the assistant message).
      if (id && seenToolUseIds.has(id)) continue;
      if (id) seenToolUseIds.add(id);
      progress.toolCalls.push(name);
      if (name === "send_response") {
        const input = msg.input && typeof msg.input === "object" ? msg.input : {};
        const finalMsg = typeof input.message === "string" ? input.message : "";
        if (finalMsg) {
          write(sseFrame("response", { content: finalMsg, delta: false }));
        }
      } else {
        write(sseFrame("status", { tool: name }));
      }
      continue;
    }

    if (msg.type === "assistant") {
      if (typeof msg.session_id === "string" && msg.session_id) {
        ref.value = msg.session_id;
      }
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "thinking") {
          const thinking = typeof block.thinking === "string" ? block.thinking : "";
          if (thinking.trim()) {
            write(sseFrame("thinking", { content: thinking, delta: false }));
          }
        } else if (block.type === "text") {
          const text = typeof block.text === "string" ? block.text : "";
          if (text.trim()) {
            write(sseFrame("status", { content: text }));
          }
        } else if (block.type === "tool_use") {
          const id = typeof block.id === "string" ? block.id : null;
          // Same dedup key as the shannon_tool_use branch — when both paths
          // surface the same tool_use, only the FIRST one wins.
          if (id && seenToolUseIds.has(id)) continue;
          if (id) seenToolUseIds.add(id);
          const rawName = typeof block.name === "string" ? block.name : "";
          const name = stripMcpPrefix(rawName);
          if (name) progress.toolCalls.push(name);
          if (name === "send_response") {
            const finalMsg = block.input && typeof block.input.message === "string"
              ? block.input.message
              : "";
            if (finalMsg) {
              write(sseFrame("response", { content: finalMsg, delta: false }));
            }
          } else if (name) {
            write(sseFrame("status", { tool: name }));
          }
        }
      }
      continue;
    }

    if (msg.type === "result") {
      if (typeof msg.session_id === "string" && msg.session_id) {
        ref.value = msg.session_id;
      }
      progress.totalCost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
      progress.durationMs = typeof msg.duration_ms === "number" ? msg.duration_ms : 0;
      isError = Boolean(msg.is_error);
      const payload = {
        session_id: ref.value,
        cost: progress.totalCost,
        duration_ms: progress.durationMs,
        tool_calls: progress.toolCalls,
      };
      if (isError) {
        payload.is_error = true;
        if (typeof msg.result === "string" && msg.result) payload.error = msg.result;
      }
      write(sseFrame("result", payload));
      progress.resultEmitted = true;
    }
  }

  return {
    sessionId: ref.value,
    totalCost: progress.totalCost,
    durationMs: progress.durationMs,
    toolCalls: progress.toolCalls,
    isError,
    resultEmitted: progress.resultEmitted,
  };
}

/**
 * Write the `{mcpServers: {...}}` JSON to a per-request temp file and return
 * the path. Caller is responsible for cleaning the parent dir up.
 *
 * Uses node:fs sync writes (mkdtemp + writeFile) instead of Bun.write because
 * we want strict per-request isolation under a fresh mkdtemp dir, and the
 * config is tiny (a single JSON blob) — sync IO here is fine.
 */
export function writeMcpConfigTmpFile(mcpConfig) {
  const tmpDir = mkdtempSync(join(tmpdir(), "shannon-mcp-"));
  const tmpPath = join(tmpDir, "mcp-config.json");
  const body = JSON.stringify(mcpConfig ?? { mcpServers: {} });
  writeFileSync(tmpPath, body, "utf8");
  return { tmpDir, tmpPath };
}

export function cleanupMcpConfigDir(tmpDir) {
  if (!tmpDir) return;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; nothing else to do.
  }
}

// ─── Request handler ─────────────────────────────────────────────────────────

/**
 * Build the request handler used by Bun.serve. Accepts a `queryFn` so tests
 * can stub out the real Shannon `query()` and drive the SSE stream from a
 * fixture-backed async iterable.
 */
export function buildHandler({ queryFn = query } = {}) {
  return async function handleInvoke(req) {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const {
      system_prompt,
      message,
      session_id,
      model,
      cwd,
      mcp_config,
      allowed_tools,
      disallowed_tools,
      settings: shannonSettings,
    } = body ?? {};

    if (typeof message !== "string" || message.length === 0) {
      return new Response(JSON.stringify({ error: "missing_message" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { tmpDir, tmpPath } = writeMcpConfigTmpFile(mcp_config);

    const abortController = new AbortController();
    // Abort downstream Shannon query when the client disconnects.
    if (req.signal) {
      if (req.signal.aborted) abortController.abort();
      else req.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    const queryOptions = {
      // Shannon's query() defaults command to "shannon" and tries to exec it
      // off PATH. Inside this image the runnable is /app/bin/shannon.mjs (no
      // shannon binary on PATH) so we point at it directly. Matches the same
      // pattern tracer/tracer.ts uses.
      command: "/app/bin/shannon.mjs",
      systemPrompt: typeof system_prompt === "string" ? system_prompt : undefined,
      model: typeof model === "string" ? model : undefined,
      resume: typeof session_id === "string" && session_id ? session_id : undefined,
      cwd: rewriteCwd(cwd),
      mcpConfig: [tmpPath],
      allowedTools: Array.isArray(allowed_tools) ? allowed_tools : [],
      disallowedTools: Array.isArray(disallowed_tools) ? disallowed_tools : [],
      permissionMode: "acceptEdits",
      includePartialMessages: true,
      settings: shannonSettings && typeof shannonSettings === "object" ? shannonSettings : {},
      abortController,
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const safeWrite = (text) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            closed = true;
          }
        };
        // Outer-scope session id container so the catch path below can still
        // emit the session id captured from `system/init` even if the
        // underlying Shannon process throws (e.g. "Timed out waiting for
        // assistant reply") AFTER yielding the init message. Without this
        // ref, the catch fell back to the inbound request's session_id
        // (null on first turn), and the client lost --resume on the next
        // turn.
        const sessionIdRef = {
          value: typeof session_id === "string" ? session_id : null,
        };
        // progressRef captures what processShannonStream accumulated even if
        // the inner iter throws (Shannon "Timed out waiting for assistant
        // reply" after the agent already called send_response) OR ends
        // without emitting a result message. Both synthetic-result branches
        // below read from this so the SSE result frame the caller sees
        // reports the actual tool_calls / cost / duration instead of
        // dropping them to zeros — telemetry parity with the happy path.
        const progressRef = {
          toolCalls: [],
          totalCost: 0,
          durationMs: 0,
          resultEmitted: false,
        };
        try {
          const iter = queryFn({ prompt: message, options: queryOptions });
          const { resultEmitted, sessionId } = await processShannonStream(
            iter,
            safeWrite,
            typeof session_id === "string" ? session_id : null,
            sessionIdRef,
            progressRef,
          );
          if (!resultEmitted) {
            safeWrite(
              sseFrame("result", {
                session_id: sessionId,
                cost: progressRef.totalCost,
                duration_ms: progressRef.durationMs,
                tool_calls: progressRef.toolCalls,
                is_error: true,
                error: "no_result_message",
              }),
            );
          }
        } catch (err) {
          // Only emit a synthetic-error result frame if processShannonStream
          // had NOT already written a real one — otherwise the python worker
          // sees two result events for the same attempt and the second one
          // (with cost=0 and is_error=true) clobbers the first's telemetry.
          if (!progressRef.resultEmitted) {
            safeWrite(
              sseFrame("result", {
                session_id: sessionIdRef.value,
                cost: progressRef.totalCost,
                duration_ms: progressRef.durationMs,
                tool_calls: progressRef.toolCalls,
                is_error: true,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        } finally {
          cleanupMcpConfigDir(tmpDir);
          try {
            controller.close();
          } catch {
            // controller may already be closed if the client went away
          }
          closed = true;
        }
      },
      cancel() {
        // Client disconnected; abort the in-flight Shannon turn and clean up.
        abortController.abort();
        cleanupMcpConfigDir(tmpDir);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}

/**
 * Build the top-level Bun fetch handler combining /health and /invoke/stream.
 * Exported so tests can drive the routing layer (without a port bind) and so
 * the in-process startup at the bottom of this file has a single source of
 * truth.
 */
export function buildFetch({ queryFn = query } = {}) {
  const handleInvoke = buildHandler({ queryFn });
  return async function fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health" && req.method === "GET") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/invoke/stream" && req.method === "POST") {
      return handleInvoke(req);
    }
    return new Response("not found", { status: 404 });
  };
}

// ─── Bun.serve startup (only when run directly) ─────────────────────────────

if (import.meta.main) {
  const fetchHandler = buildFetch();
  Bun.serve({
    port: PORT,
    fetch: fetchHandler,
    // Bun.serve defaults to a 10s idle timeout, which the SSE stream blows
    // past on every non-trivial turn (agent thinking + tool calls). Bun caps
    // idleTimeout at 255 — pick that max so it stays just under the python
    // read timeout (280s).
    idleTimeout: 255,
  });
  console.log(`shannon-support-worker listening on :${PORT}`);
}
