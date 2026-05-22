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
export async function processShannonStream(iter, write, initialSessionId = null) {
  let sessionId = initialSessionId;
  let totalCost = 0;
  let durationMs = 0;
  const toolCalls = [];
  let isError = false;
  let resultEmitted = false;

  for await (const msg of iter) {
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") continue;

    if (msg.type === "system" && msg.subtype === "init") {
      if (typeof msg.session_id === "string" && msg.session_id) {
        sessionId = msg.session_id;
      }
      continue;
    }

    if (msg.type === "assistant") {
      if (typeof msg.session_id === "string" && msg.session_id) {
        sessionId = msg.session_id;
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
          const rawName = typeof block.name === "string" ? block.name : "";
          const name = stripMcpPrefix(rawName);
          if (name) toolCalls.push(name);
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
        sessionId = msg.session_id;
      }
      totalCost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
      durationMs = typeof msg.duration_ms === "number" ? msg.duration_ms : 0;
      isError = Boolean(msg.is_error);
      const payload = {
        session_id: sessionId,
        cost: totalCost,
        duration_ms: durationMs,
        tool_calls: toolCalls,
      };
      if (isError) {
        payload.is_error = true;
        if (typeof msg.result === "string" && msg.result) payload.error = msg.result;
      }
      write(sseFrame("result", payload));
      resultEmitted = true;
    }
  }

  return { sessionId, totalCost, durationMs, toolCalls, isError, resultEmitted };
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
        try {
          const iter = queryFn({ prompt: message, options: queryOptions });
          const { resultEmitted, sessionId } = await processShannonStream(
            iter,
            safeWrite,
            typeof session_id === "string" ? session_id : null,
          );
          if (!resultEmitted) {
            safeWrite(
              sseFrame("result", {
                session_id: sessionId,
                cost: 0,
                duration_ms: 0,
                tool_calls: [],
                is_error: true,
                error: "no_result_message",
              }),
            );
          }
        } catch (err) {
          safeWrite(
            sseFrame("result", {
              session_id: typeof session_id === "string" ? session_id : null,
              cost: 0,
              duration_ms: 0,
              tool_calls: [],
              is_error: true,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
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
  });
  console.log(`shannon-support-worker listening on :${PORT}`);
}
