// Tests for the support-worker HTTP server. The pure helpers
// (sseFrame, processShannonStream, rewriteCwd, mcp-config tmp file lifecycle)
// are exercised in-process via the exported building blocks. The HTTP layer is
// exercised by handing buildFetch() a stub queryFn that yields a canned
// Shannon message sequence, so we never need the real claude binary, the real
// tmux harness, or a port bind in this test file.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildFetch,
  buildHandler,
  cleanupMcpConfigDir,
  processShannonStream,
  rewriteCwd,
  sseFrame,
  stripMcpPrefix,
  writeMcpConfigTmpFile,
} from "./support-server.mjs";

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("sseFrame", () => {
  test("produces well-formed SSE frame", () => {
    const frame = sseFrame("thinking", { content: "hi" });
    expect(frame).toBe('event: thinking\ndata: {"content":"hi"}\n\n');
  });

  test("serialises nested payloads", () => {
    const frame = sseFrame("result", { session_id: "s-1", cost: 0.5, tool_calls: ["a", "b"] });
    expect(frame.startsWith("event: result\n")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    const data = JSON.parse(frame.split("data: ")[1].trim());
    expect(data).toEqual({ session_id: "s-1", cost: 0.5, tool_calls: ["a", "b"] });
  });
});

describe("rewriteCwd", () => {
  test("rewrites /workspaces/<id> to /workspace", () => {
    expect(rewriteCwd("/workspaces/abc-123")).toBe("/workspace");
    expect(rewriteCwd("/workspaces/u-1/nested/path")).toBe("/workspace");
  });

  test("leaves /workspace and absolute paths untouched", () => {
    expect(rewriteCwd("/workspace")).toBe("/workspace");
    expect(rewriteCwd("/workspace/subdir")).toBe("/workspace/subdir");
    expect(rewriteCwd("/some/other/path")).toBe("/some/other/path");
  });

  test("passes empty / non-string cwd through unchanged", () => {
    expect(rewriteCwd("")).toBe("");
    expect(rewriteCwd(undefined)).toBe(undefined);
    expect(rewriteCwd(null)).toBe(null);
  });
});

describe("stripMcpPrefix", () => {
  test("strips MCP-tool prefix to bare tool name", () => {
    expect(stripMcpPrefix("mcp__support_tools__send_response")).toBe("send_response");
    expect(stripMcpPrefix("mcp__idoneachat-platform__count_candidates")).toBe("count_candidates");
  });

  test("leaves non-MCP tool names alone", () => {
    expect(stripMcpPrefix("Read")).toBe("Read");
    expect(stripMcpPrefix("Bash")).toBe("Bash");
  });

  test("returns empty string on non-string input", () => {
    expect(stripMcpPrefix(undefined)).toBe("");
    expect(stripMcpPrefix(null)).toBe("");
    expect(stripMcpPrefix(42)).toBe("");
  });
});

// ─── mcp_config tmp-file lifecycle ───────────────────────────────────────────

describe("writeMcpConfigTmpFile + cleanupMcpConfigDir", () => {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("writes JSON to a fresh per-call dir and cleanup removes it", () => {
    const cfg = { mcpServers: { foo: { type: "http", url: "https://example.test/mcp" } } };
    const { tmpDir, tmpPath } = writeMcpConfigTmpFile(cfg);
    created.push(tmpDir);
    expect(existsSync(tmpDir)).toBe(true);
    expect(existsSync(tmpPath)).toBe(true);
    expect(JSON.parse(readFileSync(tmpPath, "utf8"))).toEqual(cfg);

    cleanupMcpConfigDir(tmpDir);
    expect(existsSync(tmpDir)).toBe(false);
  });

  test("two calls produce distinct directories (no sharing)", () => {
    const a = writeMcpConfigTmpFile({ mcpServers: {} });
    const b = writeMcpConfigTmpFile({ mcpServers: {} });
    created.push(a.tmpDir, b.tmpDir);
    expect(a.tmpDir).not.toBe(b.tmpDir);
  });

  test("falsy mcp_config falls back to empty mcpServers", () => {
    const { tmpDir, tmpPath } = writeMcpConfigTmpFile(undefined);
    created.push(tmpDir);
    expect(JSON.parse(readFileSync(tmpPath, "utf8"))).toEqual({ mcpServers: {} });
  });

  test("cleanup is best-effort on missing dir", () => {
    expect(() => cleanupMcpConfigDir("/does/not/exist/anywhere")).not.toThrow();
    expect(() => cleanupMcpConfigDir(undefined)).not.toThrow();
  });
});

// ─── processShannonStream → SSE mapping ──────────────────────────────────────

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

function collect(): { frames: string[]; write: (s: string) => void } {
  const frames: string[] = [];
  return { frames, write: (s) => frames.push(s) };
}

function parseFrame(raw: string): { event: string; data: Record<string, unknown> } {
  const evLine = raw.split("\n").find((l) => l.startsWith("event: "));
  const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
  return {
    event: evLine?.slice("event: ".length) ?? "",
    data: dataLine ? JSON.parse(dataLine.slice("data: ".length)) : {},
  };
}

describe("processShannonStream", () => {
  test("system/init captures session_id without emitting a frame", async () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-init-9" },
    ];
    const { frames, write } = collect();
    const out = await processShannonStream(fromArray(messages), write);
    expect(frames).toHaveLength(0);
    expect(out.sessionId).toBe("sess-init-9");
    expect(out.resultEmitted).toBe(false);
  });

  test("assistant content blocks → thinking, status, response, tool status", async () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "assistant",
        session_id: "sess-1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think about this question." },
            { type: "text", text: "Looking up your data..." },
            {
              type: "tool_use",
              name: "mcp__idoneachat-platform__count_candidates",
              input: {},
            },
            {
              type: "tool_use",
              name: "mcp__support_tools__send_response",
              input: { message: "You have 17 candidates.", ui_actions: [] },
            },
          ],
        },
      },
      {
        type: "result",
        session_id: "sess-1",
        total_cost_usd: 0.0023,
        duration_ms: 4210,
        is_error: false,
        result: "ok",
      },
    ];

    const { frames, write } = collect();
    const out = await processShannonStream(fromArray(messages), write);

    const parsed = frames.map(parseFrame);
    expect(parsed.map((p) => p.event)).toEqual([
      "thinking",
      "status",
      "status",
      "response",
      "result",
    ]);
    expect(parsed[0].data).toEqual({
      content: "Let me think about this question.",
      delta: false,
    });
    expect(parsed[1].data).toEqual({ content: "Looking up your data..." });
    expect(parsed[2].data).toEqual({ tool: "count_candidates" });
    expect(parsed[3].data).toEqual({
      content: "You have 17 candidates.",
      delta: false,
    });
    expect(parsed[4].data).toEqual({
      session_id: "sess-1",
      cost: 0.0023,
      duration_ms: 4210,
      tool_calls: ["count_candidates", "send_response"],
    });

    expect(out.resultEmitted).toBe(true);
    expect(out.sessionId).toBe("sess-1");
    expect(out.toolCalls).toEqual(["count_candidates", "send_response"]);
  });

  test("send_response with empty message string does not emit a response frame", async () => {
    const messages = [
      {
        type: "assistant",
        session_id: "sess-empty",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "mcp__support_tools__send_response", input: { message: "" } },
          ],
        },
      },
      { type: "result", session_id: "sess-empty", total_cost_usd: 0, duration_ms: 1, is_error: false },
    ];
    const { frames, write } = collect();
    await processShannonStream(fromArray(messages), write);
    const events = frames.map(parseFrame).map((p) => p.event);
    expect(events).not.toContain("response");
    expect(events).toContain("result");
  });

  test("blank thinking / text blocks are dropped", async () => {
    const messages = [
      {
        type: "assistant",
        session_id: "sess-blank",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "   " },
            { type: "text", text: "\n" },
            { type: "text", text: "actual content" },
          ],
        },
      },
    ];
    const { frames, write } = collect();
    await processShannonStream(fromArray(messages), write);
    const parsed = frames.map(parseFrame);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].event).toBe("status");
    expect(parsed[0].data).toEqual({ content: "actual content" });
  });

  test("is_error=true result frame carries is_error + error fields", async () => {
    const messages = [
      {
        type: "result",
        session_id: "sess-err",
        total_cost_usd: 0,
        duration_ms: 12,
        is_error: true,
        result: "ratelimited",
      },
    ];
    const { frames, write } = collect();
    await processShannonStream(fromArray(messages), write);
    const parsed = parseFrame(frames[0]);
    expect(parsed.event).toBe("result");
    expect(parsed.data.is_error).toBe(true);
    expect(parsed.data.error).toBe("ratelimited");
  });

  test("missing result emits no synthetic frame from processShannonStream", async () => {
    // processShannonStream is the inner pure helper; the synthetic 'no_result_message'
    // safety net lives in buildHandler, not here.
    const messages = [
      {
        type: "assistant",
        session_id: "sess-no-result",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ];
    const { frames, write } = collect();
    const out = await processShannonStream(fromArray(messages), write);
    expect(out.resultEmitted).toBe(false);
    expect(frames.some((f) => f.startsWith("event: result"))).toBe(false);
  });

  test("ignores stream_event partial deltas (avoids double-emit with AssistantMessage)", async () => {
    const messages = [
      {
        type: "stream_event",
        session_id: "sess-stream",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial " } },
      },
      {
        type: "assistant",
        session_id: "sess-stream",
        message: { role: "assistant", content: [{ type: "text", text: "partial reply" }] },
      },
    ];
    const { frames, write } = collect();
    await processShannonStream(fromArray(messages), write);
    expect(frames).toHaveLength(1);
    expect(parseFrame(frames[0]).data).toEqual({ content: "partial reply" });
  });
});

// ─── HTTP layer via buildFetch + stubbed queryFn ─────────────────────────────

async function readSseFrames(resp: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const text = await resp.text();
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b) => parseFrame(b));
}

describe("buildFetch / health endpoint", () => {
  test("GET /health returns 200 {ok:true}", async () => {
    const fetchHandler = buildFetch({ queryFn: () => fromArray([]) });
    const resp = await fetchHandler(new Request("http://test.local/health"));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });

  test("unknown route returns 404", async () => {
    const fetchHandler = buildFetch({ queryFn: () => fromArray([]) });
    const resp = await fetchHandler(new Request("http://test.local/nope"));
    expect(resp.status).toBe(404);
  });
});

describe("buildHandler / POST /invoke/stream", () => {
  test("invalid JSON body → 400", async () => {
    const handler = buildHandler({ queryFn: () => fromArray([]) });
    const resp = await handler(
      new Request("http://test.local/invoke/stream", {
        method: "POST",
        body: "this is not json",
      }),
    );
    expect(resp.status).toBe(400);
  });

  test("missing message → 400", async () => {
    const handler = buildHandler({ queryFn: () => fromArray([]) });
    const resp = await handler(
      new Request("http://test.local/invoke/stream", {
        method: "POST",
        body: JSON.stringify({ system_prompt: "x" }),
      }),
    );
    expect(resp.status).toBe(400);
  });

  test("happy path: stubbed Shannon yields → SSE frames stream out + tmp file cleaned", async () => {
    let observedOptions: Record<string, unknown> | undefined;
    let observedPrompt: unknown;
    let capturedMcpPath: string | undefined;

    const fakeQuery = ({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
      observedPrompt = prompt;
      observedOptions = options;
      capturedMcpPath = Array.isArray(options.mcpConfig) ? (options.mcpConfig[0] as string) : undefined;
      // Sanity: tmp file exists at this point.
      if (!capturedMcpPath || !existsSync(capturedMcpPath)) {
        throw new Error(`expected mcp config tmp path to exist: ${capturedMcpPath}`);
      }
      return fromArray([
        { type: "system", subtype: "init", session_id: "sess-happy" },
        {
          type: "assistant",
          session_id: "sess-happy",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "thinking..." },
              {
                type: "tool_use",
                name: "mcp__support_tools__send_response",
                input: { message: "all done", ui_actions: [] },
              },
            ],
          },
        },
        {
          type: "result",
          session_id: "sess-happy",
          total_cost_usd: 0.01,
          duration_ms: 33,
          is_error: false,
          result: "ok",
        },
      ]);
    };

    const handler = buildHandler({ queryFn: fakeQuery });
    const reqBody = {
      system_prompt: "you are helpful",
      message: "hi",
      session_id: null,
      model: "claude-haiku-4-5",
      cwd: "/workspaces/u-42",
      mcp_config: { mcpServers: { support_tools: { type: "http", url: "http://py:8000/mcp/support_tools" } } },
      allowed_tools: ["mcp__support_tools__send_response"],
      disallowed_tools: ["WebFetch"],
      settings: { showThinkingSummaries: true },
    };
    const resp = await handler(
      new Request("http://test.local/invoke/stream", {
        method: "POST",
        body: JSON.stringify(reqBody),
      }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");

    const frames = await readSseFrames(resp);
    expect(frames.map((f) => f.event)).toEqual(["thinking", "response", "result"]);
    expect(frames[2].data.session_id).toBe("sess-happy");
    expect(frames[2].data.tool_calls).toEqual(["send_response"]);

    // queryFn was invoked with our expected options
    expect(observedPrompt).toBe("hi");
    expect(observedOptions?.cwd).toBe("/workspace"); // path was rewritten
    expect(observedOptions?.systemPrompt).toBe("you are helpful");
    expect(observedOptions?.model).toBe("claude-haiku-4-5");
    expect(observedOptions?.permissionMode).toBe("acceptEdits");
    expect(observedOptions?.includePartialMessages).toBe(true);
    expect(Array.isArray(observedOptions?.mcpConfig)).toBe(true);

    // tmp dir should be cleaned up after the stream finishes
    expect(capturedMcpPath).toBeDefined();
    expect(existsSync(capturedMcpPath as string)).toBe(false);
  });

  test("queryFn throwing → synthetic is_error result frame + tmp cleanup", async () => {
    let capturedMcpPath: string | undefined;
    const handler = buildHandler({
      queryFn: ({ options }: { options: Record<string, unknown> }) => {
        capturedMcpPath = Array.isArray(options.mcpConfig) ? (options.mcpConfig[0] as string) : undefined;
        // Throwing inside a sync entry into an async iterable surface: return
        // an iterator that rejects on first .next().
        return (async function* () {
          throw new Error("boom");
          yield undefined as unknown as object; // unreachable
        })();
      },
    });
    const resp = await handler(
      new Request("http://test.local/invoke/stream", {
        method: "POST",
        body: JSON.stringify({ message: "hi", mcp_config: { mcpServers: {} } }),
      }),
    );
    const frames = await readSseFrames(resp);
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("result");
    expect(frames[0].data.is_error).toBe(true);
    expect(frames[0].data.error).toBe("boom");

    expect(capturedMcpPath).toBeDefined();
    expect(existsSync(capturedMcpPath as string)).toBe(false);
  });

  test("queryFn yielding no result message → synthetic no_result_message error", async () => {
    const handler = buildHandler({
      queryFn: () =>
        fromArray([
          {
            type: "assistant",
            session_id: "sess-no-result",
            message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
          },
        ]),
    });
    const resp = await handler(
      new Request("http://test.local/invoke/stream", {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      }),
    );
    const frames = await readSseFrames(resp);
    const result = frames.find((f) => f.event === "result");
    expect(result).toBeDefined();
    expect(result?.data.is_error).toBe(true);
    expect(result?.data.error).toBe("no_result_message");
    expect(result?.data.session_id).toBe("sess-no-result");
  });

  test(
    "tool_use then no_result_message → synthetic result preserves tool_calls",
    async () => {
      // Reproduces the enforcer-resumed bug: agent yields an assistant message
      // that includes a send_response tool_use block, then Shannon ends the
      // stream without ever emitting a result message. Pre-fix we hard-coded
      // tool_calls=[] in the synthetic; the slot was populated so the user
      // got their reply, but downstream telemetry lost the toolCalls
      // accumulator. Post-fix the synthetic must report what we actually saw.
      const handler = buildHandler({
        queryFn: () =>
          fromArray([
            {
              type: "system",
              subtype: "init",
              session_id: "sess-tu-no-result",
            },
            {
              type: "assistant",
              session_id: "sess-tu-no-result",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    name: "mcp__support_tools__send_response",
                    input: { message: "hello" },
                  },
                ],
              },
            },
          ]),
      });
      const resp = await handler(
        new Request("http://test.local/invoke/stream", {
          method: "POST",
          body: JSON.stringify({ message: "hi" }),
        }),
      );
      const frames = await readSseFrames(resp);
      const result = frames.find((f) => f.event === "result");
      expect(result).toBeDefined();
      expect(result?.data.is_error).toBe(true);
      expect(result?.data.error).toBe("no_result_message");
      expect(result?.data.tool_calls).toEqual(["send_response"]);
    },
  );

  test("real result then queryFn throws → catch does NOT emit a second synthetic", async () => {
    // Defensive: pre-fix the catch path always emitted a synthetic result
    // frame, even if processShannonStream had already written a real result
    // before the throw. Downstream the python worker treats each result
    // event as the final state of the turn, so a trailing synthetic with
    // cost=0/is_error=true would clobber the real one. The fix gates the
    // catch-path synthetic on progressRef.resultEmitted=false.
    const handler = buildHandler({
      queryFn: () =>
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sess-late-throw",
          };
          yield {
            type: "assistant",
            session_id: "sess-late-throw",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          };
          yield {
            type: "result",
            session_id: "sess-late-throw",
            total_cost_usd: 0.0123,
            duration_ms: 4567,
            is_error: false,
          };
          throw new Error("post-result fault");
        })(),
    });
    const resp = await handler(
      new Request("http://test.local/invoke/stream", {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      }),
    );
    const frames = await readSseFrames(resp);
    const results = frames.filter((f) => f.event === "result");
    expect(results).toHaveLength(1);
    expect(results[0].data.is_error).toBeUndefined();
    expect(results[0].data.cost).toBe(0.0123);
  });

  test("multiple tool_use blocks before no_result_message → all accumulated", async () => {
    // Defends against future regressions where the toolCalls accumulator
    // only tracks the LAST tool_use block. The support agent occasionally
    // chains an MCP read (e.g. mcp__idoneachat-platform__list_scenarios)
    // followed by send_response; the synthetic-result branch must report
    // both tools, in order.
    const handler = buildHandler({
      queryFn: () =>
        fromArray([
          {
            type: "system",
            subtype: "init",
            session_id: "sess-multi-tu",
          },
          {
            type: "assistant",
            session_id: "sess-multi-tu",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: "mcp__idoneachat-platform__list_scenarios",
                  input: {},
                },
                {
                  type: "tool_use",
                  name: "mcp__support_tools__send_response",
                  input: { message: "done" },
                },
              ],
            },
          },
        ]),
    });
    const resp = await handler(
      new Request("http://test.local/invoke/stream", {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      }),
    );
    const frames = await readSseFrames(resp);
    const result = frames.find((f) => f.event === "result");
    expect(result).toBeDefined();
    expect(result?.data.tool_calls).toEqual(["list_scenarios", "send_response"]);
  });

  test("tool_use then queryFn throws → catch synthetic preserves tool_calls", async () => {
    // Same shape as above but the iter rejects mid-stream (the real-world
    // "shannon exited with 1: Timed out waiting for assistant reply" error
    // surfaces this way). The catch block in buildHandler used to write
    // tool_calls=[] regardless of what processShannonStream had already
    // pushed onto its accumulator; this test pins the fix.
    const handler = buildHandler({
      queryFn: () =>
        (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sess-tu-throw",
          };
          yield {
            type: "assistant",
            session_id: "sess-tu-throw",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: "mcp__support_tools__send_response",
                  input: { message: "hello" },
                },
              ],
            },
          };
          throw new Error("shannon exited with 1: Timed out waiting for assistant reply");
        })(),
    });
    const resp = await handler(
      new Request("http://test.local/invoke/stream", {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      }),
    );
    const frames = await readSseFrames(resp);
    const result = frames.find((f) => f.event === "result");
    expect(result).toBeDefined();
    expect(result?.data.is_error).toBe(true);
    expect(result?.data.error).toBe("shannon exited with 1: Timed out waiting for assistant reply");
    expect(result?.data.tool_calls).toEqual(["send_response"]);
    // session_id captured from system/init survives the throw.
    expect(result?.data.session_id).toBe("sess-tu-throw");
  });

  test("AbortController is wired so client disconnect aborts the query", async () => {
    let observedAbortController: AbortController | undefined;
    const queryStarted = Promise.withResolvers<void>();
    const handler = buildHandler({
      queryFn: ({ options }: { options: Record<string, unknown> }) => {
        observedAbortController = options.abortController as AbortController | undefined;
        return (async function* () {
          queryStarted.resolve();
          // Wait until the AbortController signals us to bail.
          await new Promise<void>((resolve) => {
            if (observedAbortController?.signal.aborted) {
              resolve();
              return;
            }
            observedAbortController?.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          // Yield a minimal result so the stream can close cleanly post-abort.
          yield {
            type: "result",
            session_id: "sess-abort",
            total_cost_usd: 0,
            duration_ms: 0,
            is_error: true,
            result: "aborted",
          };
        })();
      },
    });

    const ac = new AbortController();
    const respPromise = handler(
      new Request("http://test.local/invoke/stream", {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
        signal: ac.signal,
      }),
    );
    const resp = await respPromise;
    expect(resp.status).toBe(200);

    // Start consuming so the ReadableStream actually runs the start() callback
    // (and our stubbed queryFn).
    const reader = resp.body!.getReader();
    await queryStarted.promise;
    expect(observedAbortController).toBeDefined();
    expect(observedAbortController!.signal.aborted).toBe(false);

    ac.abort();
    // Allow microtasks to propagate before assertion.
    await Bun.sleep(10);
    expect(observedAbortController!.signal.aborted).toBe(true);

    // Drain the rest of the stream so the controller can close.
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  });
});

// ─── Smoke: file read by Bun.file matches what we wrote ──────────────────────

describe("mcp config tmp file shape", () => {
  test("file contents are valid JSON for Shannon to ingest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shannon-mcp-test-"));
    try {
      const p = join(dir, "cfg.json");
      writeFileSync(p, JSON.stringify({ mcpServers: { a: { type: "http", url: "http://x" } } }));
      const text = await Bun.file(p).text();
      expect(JSON.parse(text)).toEqual({ mcpServers: { a: { type: "http", url: "http://x" } } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
