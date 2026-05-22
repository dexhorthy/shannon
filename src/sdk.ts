import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

export type ShannonMessage = Record<string, unknown> & {
  type: string;
  session_id?: string;
  uuid?: string;
};

export type ShannonUserMessage = {
  type: "user";
  message: {
    role: "user";
    content: string | Array<{ type: "text"; text: string }>;
  };
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
};

export type QueryOptions = {
  command?: string;
  cwd?: string;
  verbose?: boolean;
  outputFormat?: "stream-json" | "json" | "text";
  replayUserMessages?: boolean;
  additionalDirectories?: string[];
  agent?: string;
  agents?: Record<string, unknown>;
  bare?: boolean;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  betas?: string[];
  brief?: boolean;
  chrome?: boolean;
  continue?: boolean;
  debug?: boolean | string;
  debugFile?: string;
  disableSlashCommands?: boolean;
  disallowedTools?: string[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  env?: Record<string, string | undefined>;
  excludeDynamicSystemPromptSections?: boolean;
  fallbackModel?: string;
  file?: string[];
  forkSession?: boolean;
  fromPr?: string | boolean;
  ide?: boolean;
  includeHookEvents?: boolean;
  includePartialMessages?: boolean;
  printMode?: boolean;
  jsonSchema?: string | Record<string, unknown>;
  maxBudgetUsd?: number;
  mcpDebug?: boolean;
  mcpConfig?: string[];
  model?: string;
  name?: string;
  pathToClaudeCodeExecutable?: string;
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  pluginDir?: string[];
  pluginUrl?: string[];
  remoteControl?: string | boolean;
  remoteControlSessionNamePrefix?: string;
  resume?: string | boolean;
  sessionId?: string;
  sessionPersistence?: boolean;
  settingSources?: string;
  settings?: string | Record<string, unknown>;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  tools?: string[];
  tmux?: string | boolean;
  worktree?: string | boolean;
  dangerouslySkipPermissions?: boolean;
  allowDangerouslySkipPermissions?: boolean;
  abortController?: AbortController;
};

export type QueryParams = {
  prompt: string | AsyncIterable<ShannonUserMessage>;
  options?: QueryOptions;
};

export type ShannonQuery = AsyncIterable<ShannonMessage> & {
  interrupt(): Promise<void>;
  close(): void;
};

export type SessionLookupOptions = {
  dir?: string;
  home?: string;
  sessionStore?: SessionStore;
};

export type ListSessionsOptions = SessionLookupOptions & {
  limit?: number;
  offset?: number;
};

export type ListSubagentsOptions = SessionLookupOptions;

export type GetSubagentMessagesOptions = SessionLookupOptions & {
  limit?: number;
  offset?: number;
};

export type ForkSessionOptions = SessionLookupOptions & {
  sessionId?: string;
};

export type SessionMutationOptions = SessionLookupOptions;

export type ForkSessionResult = {
  sessionId: string;
};

export type ShannonSessionInfo = {
  sessionId: string;
  projectFolder: string;
  transcriptPath: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount: number;
};

export type SessionKey = {
  projectKey: string;
  sessionId: string;
  subpath?: string;
};

export type SessionStoreEntry = ShannonMessage;

export type SessionSummaryEntry = {
  sessionId: string;
  mtime: number;
  data: Record<string, unknown>;
};

export type SessionStore = {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
  listSessionSummaries?(projectKey: string): Promise<SessionSummaryEntry[]>;
  delete?(key: SessionKey): Promise<void>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
};

export const shannonTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
}).catchall(z.unknown());

export const shannonUserMessageSchema = z.object({
  type: z.literal("user"),
  message: z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(shannonTextBlockSchema)]),
  }).catchall(z.unknown()),
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string().optional(),
  uuid: z.string().optional(),
}).catchall(z.unknown());

export const shannonMessageSchema = z.object({
  type: z.string(),
  session_id: z.string().optional(),
  uuid: z.string().optional(),
}).catchall(z.unknown());

export const shannonSystemInitSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  cwd: z.string(),
  session_id: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.object({
    name: z.string(),
    status: z.string(),
  }).catchall(z.unknown())),
  model: z.string(),
  permissionMode: z.string(),
  apiKeySource: z.string().optional(),
  claude_code_version: z.string().optional(),
  output_style: z.string().optional(),
  agents: z.array(z.string()).optional(),
  slash_commands: z.array(z.string()),
  skills: z.array(z.string()),
  plugins: z.array(z.object({
    name: z.string().optional(),
    path: z.string().optional(),
    source: z.string().optional(),
  }).catchall(z.unknown())).optional(),
  uuid: z.string(),
}).catchall(z.unknown());

export const shannonHookStartedSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("hook_started"),
  hook_id: z.string(),
  hook_name: z.string(),
  hook_event: z.string(),
  session_id: z.string().optional(),
  uuid: z.string(),
}).catchall(z.unknown());

export const shannonHookResponseSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("hook_response"),
  hook_id: z.string(),
  hook_name: z.string(),
  hook_event: z.string(),
  output: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().optional(),
  outcome: z.string(),
  session_id: z.string().optional(),
  uuid: z.string(),
}).catchall(z.unknown());

export const shannonPartialAssistantMessageSchema = z.object({
  type: z.literal("stream_event"),
  event: z.object({ type: z.string() }).catchall(z.unknown()),
  parent_tool_use_id: z.string().nullable(),
  session_id: z.string(),
  uuid: z.string(),
  ttft_ms: z.number().optional(),
}).catchall(z.unknown());

export const shannonAssistantMessageSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({
    role: z.literal("assistant"),
    model: z.string().optional(),
    content: z.array(z.object({ type: z.string() }).catchall(z.unknown())),
    usage: z.record(z.string(), z.unknown()).optional(),
  }).catchall(z.unknown()),
  parent_tool_use_id: z.string().nullable().optional(),
  session_id: z.string(),
  uuid: z.string(),
}).catchall(z.unknown());

export const shannonResultMessageSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  duration_ms: z.number(),
  duration_api_ms: z.number(),
  num_turns: z.number(),
  result: z.string(),
  stop_reason: z.string().nullable().optional(),
  session_id: z.string(),
  total_cost_usd: z.number(),
  usage: z.record(z.string(), z.unknown()),
  modelUsage: z.record(z.string(), z.unknown()),
  permission_denials: z.array(z.unknown()),
  terminal_reason: z.string(),
  uuid: z.string(),
}).catchall(z.unknown());

export const shannonStatusMessageSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("status"),
  status: z.string(),
  permissionMode: z.string().optional(),
  compact_result: z.enum(["success", "failed"]).optional(),
  compact_error: z.string().optional(),
  session_id: z.string(),
  uuid: z.string(),
}).catchall(z.unknown());

export const shannonNotificationMessageSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("notification"),
  key: z.string(),
  text: z.string(),
  priority: z.enum(["low", "medium", "high", "immediate"]),
  color: z.string().optional(),
  timeout_ms: z.number().optional(),
  session_id: z.string(),
  uuid: z.string(),
}).catchall(z.unknown());

export const shannonControlRequestSchema = z.object({
  type: z.literal("control_request"),
  request_id: z.string(),
  request: z.object({
    subtype: z.string(),
  }).catchall(z.unknown()),
}).catchall(z.unknown());

export const shannonControlResponseSchema = z.object({
  type: z.literal("control_response"),
  response: z.union([
    z.object({
      subtype: z.literal("success"),
      request_id: z.string(),
      response: z.record(z.string(), z.unknown()).optional(),
    }).catchall(z.unknown()),
    z.object({
      subtype: z.literal("error"),
      request_id: z.string(),
      error: z.string(),
      pending_permission_requests: z.array(shannonControlRequestSchema).optional(),
    }).catchall(z.unknown()),
  ]),
}).catchall(z.unknown());

export const shannonSessionMetadataSchema = z.object({
  type: z.literal("shannon_session"),
  subtype: z.literal("metadata"),
  session_id: z.string(),
  session_folder: z.string(),
  transcript_path: z.string(),
  tmux_session: z.string(),
  cwd: z.string(),
  cleanup: z.record(z.string(), z.unknown()),
  uuid: z.string(),
}).catchall(z.unknown());

export const shannonRateLimitInfoSchema = z.object({
  status: z.enum(["allowed", "allowed_warning", "rejected"]),
  resetsAt: z.number().optional(),
  rateLimitType: z.enum(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"]).optional(),
  utilization: z.number().optional(),
  overageStatus: z.enum(["allowed", "allowed_warning", "rejected"]).optional(),
  overageResetsAt: z.number().optional(),
  overageDisabledReason: z.enum([
    "overage_not_provisioned",
    "org_level_disabled",
    "org_level_disabled_until",
    "out_of_credits",
    "seat_tier_level_disabled",
    "member_level_disabled",
    "seat_tier_zero_credit_limit",
    "group_zero_credit_limit",
    "member_zero_credit_limit",
    "org_service_level_disabled",
    "no_limits_configured",
    "fetch_error",
    "unknown",
  ]).optional(),
  isUsingOverage: z.boolean().optional(),
  surpassedThreshold: z.number().optional(),
}).catchall(z.unknown());

export const shannonRateLimitEventSchema = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: shannonRateLimitInfoSchema,
  session_id: z.string(),
  uuid: z.string(),
}).catchall(z.unknown());

export const shannonStreamMessageSchema = z.union([
  shannonUserMessageSchema,
  shannonSystemInitSchema,
  shannonHookStartedSchema,
  shannonHookResponseSchema,
  shannonPartialAssistantMessageSchema,
  shannonAssistantMessageSchema,
  shannonResultMessageSchema,
  shannonStatusMessageSchema,
  shannonNotificationMessageSchema,
  shannonControlRequestSchema,
  shannonControlResponseSchema,
  shannonSessionMetadataSchema,
  shannonRateLimitEventSchema,
]);

export const shannonOutputFormatSchema = z.enum(["stream-json", "json", "text"]);

export const shannonQueryOptionsSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  verbose: z.boolean().optional(),
  outputFormat: shannonOutputFormatSchema.optional(),
  replayUserMessages: z.boolean().optional(),
  additionalDirectories: z.array(z.string()).optional(),
  agent: z.string().optional(),
  agents: z.record(z.string(), z.unknown()).optional(),
  bare: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  appendSystemPrompt: z.string().optional(),
  betas: z.array(z.string()).optional(),
  brief: z.boolean().optional(),
  chrome: z.boolean().optional(),
  continue: z.boolean().optional(),
  debug: z.union([z.boolean(), z.string()]).optional(),
  debugFile: z.string().optional(),
  disableSlashCommands: z.boolean().optional(),
  disallowedTools: z.array(z.string()).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  env: z.record(z.string(), z.string().optional()).optional(),
  excludeDynamicSystemPromptSections: z.boolean().optional(),
  fallbackModel: z.string().optional(),
  file: z.array(z.string()).optional(),
  forkSession: z.boolean().optional(),
  fromPr: z.union([z.string(), z.boolean()]).optional(),
  ide: z.boolean().optional(),
  includeHookEvents: z.boolean().optional(),
  includePartialMessages: z.boolean().optional(),
  printMode: z.boolean().optional(),
  jsonSchema: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  maxBudgetUsd: z.number().optional(),
  mcpDebug: z.boolean().optional(),
  mcpConfig: z.array(z.string()).optional(),
  model: z.string().optional(),
  name: z.string().optional(),
  pathToClaudeCodeExecutable: z.string().optional(),
  permissionMode: z.enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]).optional(),
  pluginDir: z.array(z.string()).optional(),
  pluginUrl: z.array(z.string()).optional(),
  remoteControl: z.union([z.string(), z.boolean()]).optional(),
  remoteControlSessionNamePrefix: z.string().optional(),
  resume: z.union([z.string(), z.boolean()]).optional(),
  sessionId: z.string().optional(),
  sessionPersistence: z.boolean().optional(),
  settingSources: z.string().optional(),
  settings: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  strictMcpConfig: z.boolean().optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  tmux: z.union([z.string(), z.boolean()]).optional(),
  worktree: z.union([z.string(), z.boolean()]).optional(),
  dangerouslySkipPermissions: z.boolean().optional(),
  allowDangerouslySkipPermissions: z.boolean().optional(),
  abortController: z.instanceof(AbortController).optional(),
}).strict();

export const shannonQueryParamsSchema = z.object({
  prompt: z.union([
    z.string(),
    z.custom<AsyncIterable<ShannonUserMessage>>(
      (value) => Boolean(value && typeof value === "object" && Symbol.asyncIterator in value),
      "Expected an async iterable of Shannon user messages",
    ),
  ]),
  options: shannonQueryOptionsSchema.optional(),
}).strict();

export function query({ prompt, options = {} }: QueryParams): ShannonQuery {
  const abortController = options.abortController ?? new AbortController();
  const iterable = runQuery(prompt, { ...options, abortController });

  return {
    [Symbol.asyncIterator]() {
      return iterable[Symbol.asyncIterator]();
    },
    async interrupt() {
      abortController.abort();
    },
    close() {
      abortController.abort();
    },
  };
}

export async function getSessionMessages(
  sessionId: string,
  options: SessionLookupOptions = {},
): Promise<ShannonMessage[]> {
  if (options.sessionStore) {
    return await options.sessionStore.load(sessionKey(sessionId, options)) ?? [];
  }

  const transcriptPath = await transcriptPathForSession(sessionId, options);
  if (!transcriptPath) return [];
  return readJsonlFile(transcriptPath);
}

export async function getSessionInfo(
  sessionId: string,
  options: SessionLookupOptions = {},
): Promise<ShannonSessionInfo | undefined> {
  if (options.sessionStore) {
    const rows = await options.sessionStore.load(sessionKey(sessionId, options));
    if (!rows?.length) return undefined;
    return sessionInfoFromRows(sessionId, rows, options);
  }

  const transcriptPath = await transcriptPathForSession(sessionId, options);
  if (!transcriptPath) return undefined;
  return sessionInfoFromTranscript(transcriptPath);
}

export async function listSessions(options: ListSessionsOptions = {}): Promise<ShannonSessionInfo[]> {
  if (options.sessionStore) return listStoredSessions(options);

  const infos: ShannonSessionInfo[] = [];
  for (const transcriptPath of await listTranscriptPaths(options)) {
    const info = await sessionInfoFromTranscript(transcriptPath);
    if (info) infos.push(info);
  }

  infos.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit === undefined ? undefined : Math.max(0, options.limit);
  return infos.slice(offset, limit === undefined ? undefined : offset + limit);
}

export async function listSubagents(
  sessionId: string,
  options: ListSubagentsOptions = {},
): Promise<string[]> {
  if (options.sessionStore) {
    if (!options.sessionStore.listSubkeys) {
      throw new Error("sessionStore.listSubkeys is not implemented");
    }
    const subkeys = await options.sessionStore.listSubkeys(sessionKey(sessionId, options));
    return subkeys
      .filter((subkey) => subkey.startsWith("subagents/agent-"))
      .map((subkey) => subkey.split("/").at(-1)?.replace(/^agent-/, "") ?? "")
      .filter(Boolean)
      .sort();
  }

  const subagentsFolder = await subagentsFolderForSession(sessionId, options);
  if (!subagentsFolder) return [];

  const glob = new Bun.Glob("agent-*.jsonl");
  const agentIds: string[] = [];
  try {
    for await (const file of glob.scan(subagentsFolder)) {
      agentIds.push(file.replace(/^agent-/, "").replace(/\.jsonl$/, ""));
    }
  } catch {
    return [];
  }

  return agentIds.sort();
}

export async function getSubagentMessages(
  sessionId: string,
  agentId: string,
  options: GetSubagentMessagesOptions = {},
): Promise<ShannonMessage[]> {
  if (options.sessionStore) {
    const subpath = `subagents/agent-${agentId}`;
    const rows = await options.sessionStore.load(sessionKey(sessionId, options, subpath)) ?? [];
    return sliceMessages(rows.filter((row) => row.type === "user" || row.type === "assistant"), options);
  }

  const subagentsFolder = await subagentsFolderForSession(sessionId, options);
  if (!subagentsFolder) return [];

  const rows = await readJsonlFile(join(subagentsFolder, `agent-${agentId}.jsonl`));
  return sliceMessages(rows.filter((row) => row.type === "user" || row.type === "assistant"), options);
}

export async function forkSession(
  sessionId: string,
  options: ForkSessionOptions = {},
): Promise<ForkSessionResult> {
  if (options.sessionStore) {
    const rows = await options.sessionStore.load(sessionKey(sessionId, options));
    if (!rows?.length) throw new Error(`Session ${sessionId} not found`);
    const forkSessionId = options.sessionId ?? randomUUID();
    const existing = await options.sessionStore.load(sessionKey(forkSessionId, options));
    if (existing?.length) throw new Error(`Fork session ${forkSessionId} already exists`);
    await options.sessionStore.append(
      sessionKey(forkSessionId, options),
      rows.map((row) => rewriteSessionIds(row, forkSessionId)),
    );
    return { sessionId: forkSessionId };
  }

  const transcriptPath = await transcriptPathForSession(sessionId, options);
  if (!transcriptPath) throw new Error(`Session ${sessionId} not found`);

  const forkSessionId = options.sessionId ?? randomUUID();
  const forkPath = join(transcriptPath.slice(0, -basename(transcriptPath).length), `${forkSessionId}.jsonl`);
  if (await Bun.file(forkPath).exists()) {
    throw new Error(`Fork session ${forkSessionId} already exists`);
  }

  const rows = await readJsonlFile(transcriptPath);
  const forkedRows = rows.map((row) => rewriteSessionIds(row, forkSessionId));
  await Bun.write(forkPath, `${forkedRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { sessionId: forkSessionId };
}

export async function renameSession(
  sessionId: string,
  title: string,
  options: SessionMutationOptions = {},
): Promise<void> {
  if (!title.trim()) throw new Error("title must be non-empty");
  if (options.sessionStore) {
    await options.sessionStore.append(sessionKey(sessionId, options), [
      transcriptMutationRow(sessionId, "custom-title", { customTitle: title.trim() }),
    ]);
    return;
  }

  const transcriptPath = await transcriptPathForSession(sessionId, options);
  if (!transcriptPath) throw new Error(`Session ${sessionId} not found`);

  await appendTranscriptRow(transcriptPath, {
    type: "custom-title",
    customTitle: title.trim(),
    sessionId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

export async function tagSession(
  sessionId: string,
  tag: string | null,
  options: SessionMutationOptions = {},
): Promise<void> {
  const normalizedTag = tag === null ? "" : tag.trim();
  if (tag !== null && !normalizedTag) throw new Error("tag must be non-empty (use null to clear)");
  if (options.sessionStore) {
    await options.sessionStore.append(sessionKey(sessionId, options), [
      transcriptMutationRow(sessionId, "tag", { tag: normalizedTag }),
    ]);
    return;
  }

  const transcriptPath = await transcriptPathForSession(sessionId, options);
  if (!transcriptPath) throw new Error(`Session ${sessionId} not found`);

  await appendTranscriptRow(transcriptPath, {
    type: "tag",
    tag: normalizedTag,
    sessionId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

export async function deleteSession(
  sessionId: string,
  options: SessionMutationOptions = {},
): Promise<void> {
  if (options.sessionStore) {
    await options.sessionStore.delete?.(sessionKey(sessionId, options));
    return;
  }

  const transcriptPath = await transcriptPathForSession(sessionId, options);
  if (!transcriptPath) return;

  await rm(transcriptPath, { force: true });
  await rm(join(transcriptPath.slice(0, -basename(transcriptPath).length), sessionId), {
    force: true,
    recursive: true,
  });
}

export async function* parseJsonlStream(stream: ReadableStream<Uint8Array>): AsyncIterable<ShannonMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as ShannonMessage;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    yield JSON.parse(buffer) as ShannonMessage;
  }
}

function rewriteSessionIds(row: ShannonMessage, sessionId: string): ShannonMessage {
  const copy = structuredClone(row) as ShannonMessage;
  if ("sessionId" in copy) copy.sessionId = sessionId;
  if ("session_id" in copy) copy.session_id = sessionId;
  return copy;
}

function projectKeyForDir(dir: string): string {
  return resolve(dir).normalize("NFC").replace(/[^a-zA-Z0-9._-]/g, "-");
}

function claudeProjectsRoot(home = Bun.env.HOME ?? ""): string {
  return join(home, ".claude", "projects");
}

function claudeProjectFolder(dir: string, home?: string): string {
  return join(claudeProjectsRoot(home), projectKeyForDir(dir));
}

function sessionKey(sessionId: string, options: SessionLookupOptions, subpath?: string): SessionKey {
  return {
    projectKey: projectKeyForDir(options.dir ?? process.cwd()),
    sessionId,
    ...(subpath ? { subpath } : {}),
  };
}

function sliceMessages<T>(rows: T[], options: { limit?: number; offset?: number }): T[] {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit === undefined ? undefined : Math.max(0, options.limit);
  return rows.slice(offset, limit === undefined ? undefined : offset + limit);
}

async function listStoredSessions(options: ListSessionsOptions): Promise<ShannonSessionInfo[]> {
  const store = options.sessionStore;
  if (!store) return [];
  const projectKey = projectKeyForDir(options.dir ?? process.cwd());

  if (store.listSessionSummaries) {
    const summaries = await store.listSessionSummaries(projectKey);
    const infos = summaries.map((summary) => sessionInfoFromSummary(projectKey, summary));
    return sliceMessages(infos.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")), options);
  }

  if (!store.listSessions) {
    throw new Error("sessionStore.listSessions is not implemented");
  }

  const listed = await store.listSessions(projectKey);
  const infos = await Promise.all(
    listed.map(async ({ sessionId, mtime }) => {
      const rows = await store.load({ projectKey, sessionId }) ?? [];
      return sessionInfoFromRows(sessionId, rows, options, mtime);
    }),
  );
  return sliceMessages(infos.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")), options);
}

function sessionInfoFromSummary(projectKey: string, summary: SessionSummaryEntry): ShannonSessionInfo {
  return {
    sessionId: summary.sessionId,
    projectFolder: projectKey,
    transcriptPath: `${projectKey}/${summary.sessionId}.jsonl`,
    updatedAt: new Date(summary.mtime).toISOString(),
    messageCount: 0,
  };
}

function sessionInfoFromRows(
  sessionId: string,
  rows: ShannonMessage[],
  options: SessionLookupOptions,
  mtime?: number,
): ShannonSessionInfo {
  const timestampedRows = rows.filter((row) => typeof row.timestamp === "string");
  const firstTimestamp = timestampedRows[0]?.timestamp as string | undefined;
  const lastTimestamp = timestampedRows.at(-1)?.timestamp as string | undefined;
  const cwd = rows.find((row) => typeof row.cwd === "string")?.cwd as string | undefined;
  const projectKey = projectKeyForDir(options.dir ?? cwd ?? process.cwd());

  return {
    sessionId,
    projectFolder: options.sessionStore ? projectKey : claudeProjectFolder(options.dir ?? cwd ?? process.cwd(), options.home),
    transcriptPath: options.sessionStore ? `${projectKey}/${sessionId}.jsonl` : "",
    cwd,
    createdAt: firstTimestamp,
    updatedAt: lastTimestamp ?? (mtime === undefined ? undefined : new Date(mtime).toISOString()),
    messageCount: rows.length,
  };
}

function transcriptMutationRow(
  sessionId: string,
  type: "custom-title" | "tag",
  fields: Record<string, unknown>,
): ShannonMessage {
  return {
    type,
    ...fields,
    sessionId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

async function listTranscriptPaths(options: SessionLookupOptions = {}): Promise<string[]> {
  if (options.dir) return listTranscriptPathsInFolder(claudeProjectFolder(options.dir, options.home));

  const root = claudeProjectsRoot(options.home);
  const projects = new Bun.Glob("*");
  const paths: string[] = [];
  for await (const project of projects.scan(root)) {
    const folder = join(root, project);
    paths.push(...await listTranscriptPathsInFolder(folder));
  }
  return paths;
}

async function listTranscriptPathsInFolder(folder: string): Promise<string[]> {
  const glob = new Bun.Glob("*.jsonl");
  const paths: string[] = [];
  try {
    for await (const file of glob.scan(folder)) {
      paths.push(join(folder, file));
    }
  } catch {
    return [];
  }
  return paths;
}

async function transcriptPathForSession(
  sessionId: string,
  options: SessionLookupOptions,
): Promise<string | undefined> {
  if (options.dir) {
    const path = join(claudeProjectFolder(options.dir, options.home), `${sessionId}.jsonl`);
    return await Bun.file(path).exists() ? path : undefined;
  }

  return (await listTranscriptPaths(options)).find((path) => basename(path) === `${sessionId}.jsonl`);
}

async function subagentsFolderForSession(
  sessionId: string,
  options: SessionLookupOptions,
): Promise<string | undefined> {
  const transcriptPath = await transcriptPathForSession(sessionId, options);
  if (!transcriptPath) return undefined;
  return join(transcriptPath.slice(0, -basename(transcriptPath).length), sessionId, "subagents");
}

async function sessionInfoFromTranscript(transcriptPath: string): Promise<ShannonSessionInfo | undefined> {
  const rows = await readJsonlFile(transcriptPath);
  const sessionId = basename(transcriptPath).replace(/\.jsonl$/, "");
  const timestampedRows = rows.filter((row) => typeof row.timestamp === "string");
  const firstTimestamp = timestampedRows[0]?.timestamp as string | undefined;
  const lastTimestamp = timestampedRows.at(-1)?.timestamp as string | undefined;
  const cwd = rows.find((row) => typeof row.cwd === "string")?.cwd as string | undefined;

  return {
    sessionId,
    projectFolder: transcriptPath.slice(0, -basename(transcriptPath).length - 1),
    transcriptPath,
    cwd,
    createdAt: firstTimestamp,
    updatedAt: lastTimestamp,
    messageCount: rows.length,
  };
}

async function readJsonlFile(path: string): Promise<ShannonMessage[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ShannonMessage);
}

async function appendTranscriptRow(path: string, row: ShannonMessage): Promise<void> {
  const file = Bun.file(path);
  const text = await file.text();
  const prefix = text.length > 0 && !text.endsWith("\n") ? `${text}\n` : text;
  await Bun.write(path, `${prefix}${JSON.stringify(row)}\n`);
}

async function* runQuery(
  prompt: string | AsyncIterable<ShannonUserMessage>,
  options: QueryOptions,
): AsyncIterable<ShannonMessage> {
  const command = options.command ?? "shannon";
  const outputFormat = options.outputFormat ?? "stream-json";
  const isStreamingInput = typeof prompt !== "string";
  const args = [
    command,
    ...(typeof prompt === "string" ? ["-p", prompt] : ["--input-format=stream-json"]),
    `--output-format=${outputFormat}`,
    ...(options.verbose ?? true ? ["--verbose"] : []),
    ...(options.replayUserMessages ? ["--replay-user-messages"] : []),
    ...optionsToCliArgs(options),
  ];
  const signal = options.abortController?.signal;

  if (signal?.aborted) {
    throw new Error("Shannon query aborted before start");
  }

  const proc = Bun.spawn(args, {
    cwd: options.cwd,
    env: options.env ? { ...Bun.env, ...options.env } : undefined,
    stdin: isStreamingInput ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const abortHandler = () => {
    proc.kill("SIGTERM");
  };
  signal?.addEventListener("abort", abortHandler, { once: true });
  const stderrPromise = new Response(proc.stderr).text();
  const stdinPromise = isStreamingInput
    ? writeStreamingInput(proc.stdin, prompt)
    : Promise.resolve();

  try {
    for await (const message of parseJsonlStream(proc.stdout)) {
      yield message;
    }

    const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise, stdinPromise]);
    if (signal?.aborted) {
      throw new Error("Shannon query aborted");
    }
    if (exitCode !== 0) {
      throw new Error(`shannon exited with ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
}

export function optionsToCliArgs(options: QueryOptions): string[] {
  const args: string[] = [];

  addRepeated(args, "--add-dir", options.additionalDirectories);
  addString(args, "--agent", options.agent);
  addJson(args, "--agents", options.agents);
  addBoolean(args, "--allow-dangerously-skip-permissions", options.allowDangerouslySkipPermissions);
  addRepeated(args, "--allowed-tools", options.allowedTools);
  addString(args, "--append-system-prompt", options.appendSystemPrompt);
  addBoolean(args, "--bare", options.bare);
  addRepeated(args, "--betas", options.betas);
  addBoolean(args, "--brief", options.brief);
  addChrome(args, options.chrome);
  addBoolean(args, "--continue", options.continue);
  addOptionalString(args, "--debug", options.debug);
  addString(args, "--debug-file", options.debugFile);
  addBoolean(args, "--disable-slash-commands", options.disableSlashCommands);
  addRepeated(args, "--disallowed-tools", options.disallowedTools);
  addString(args, "--effort", options.effort);
  addBoolean(args, "--exclude-dynamic-system-prompt-sections", options.excludeDynamicSystemPromptSections);
  addString(args, "--fallback-model", options.fallbackModel);
  addRepeated(args, "--file", options.file);
  addBoolean(args, "--fork-session", options.forkSession);
  addOptionalString(args, "--from-pr", options.fromPr);
  addBoolean(args, "--ide", options.ide);
  addBoolean(args, "--include-hook-events", options.includeHookEvents);
  addBoolean(args, "--include-partial-messages", options.includePartialMessages);
  addBoolean(args, "--print-mode", options.printMode);
  addJsonOrString(args, "--json-schema", options.jsonSchema);
  addString(args, "--max-budget-usd", options.maxBudgetUsd);
  addRepeated(args, "--mcp-config", options.mcpConfig);
  addBoolean(args, "--mcp-debug", options.mcpDebug);
  addString(args, "--model", options.model);
  addString(args, "--name", options.name);
  addString(args, "--path-to-claude-code-executable", options.pathToClaudeCodeExecutable);
  addString(args, "--permission-mode", options.permissionMode);
  addRepeatedFlag(args, "--plugin-dir", options.pluginDir);
  addRepeatedFlag(args, "--plugin-url", options.pluginUrl);
  addOptionalString(args, "--remote-control", options.remoteControl);
  addString(args, "--remote-control-session-name-prefix", options.remoteControlSessionNamePrefix);
  addOptionalString(args, "--resume", options.resume);
  addString(args, "--session-id", options.sessionId);
  addNoSessionPersistence(args, options.sessionPersistence);
  addString(args, "--setting-sources", options.settingSources);
  addSettings(args, options.settings);
  addBoolean(args, "--strict-mcp-config", options.strictMcpConfig);
  addString(args, "--system-prompt", options.systemPrompt);
  addRepeated(args, "--tools", options.tools);
  addOptionalString(args, "--tmux", options.tmux);
  addOptionalString(args, "--worktree", options.worktree);
  addBoolean(args, "--dangerously-skip-permissions", options.dangerouslySkipPermissions);

  return args;
}

async function writeStreamingInput(
  stdin: { write: (chunk: string | Uint8Array) => unknown; end: () => unknown } | undefined,
  prompt: AsyncIterable<ShannonUserMessage>,
) {
  if (!stdin) throw new Error("shannon subprocess stdin was not available");

  try {
    for await (const message of prompt) {
      await stdin.write(`${JSON.stringify(message)}\n`);
    }
  } finally {
    await stdin.end();
  }
}

function addString(args: string[], flag: string, value: unknown) {
  if (typeof value === "string" && value.length > 0) args.push(flag, value);
  else if (typeof value === "number") args.push(flag, String(value));
}

function addOptionalString(args: string[], flag: string, value: unknown) {
  if (value === true) args.push(flag);
  else addString(args, flag, value);
}

function addBoolean(args: string[], flag: string, value: unknown) {
  if (value === true) args.push(flag);
}

function addRepeated(args: string[], flag: string, value: unknown) {
  if (Array.isArray(value) && value.length > 0) args.push(flag, ...value.map(String));
}

function addRepeatedFlag(args: string[], flag: string, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) args.push(flag, item);
  }
}

function addJson(args: string[], flag: string, value: unknown) {
  if (value && typeof value === "object") args.push(flag, JSON.stringify(value));
}

function addJsonOrString(args: string[], flag: string, value: unknown) {
  if (typeof value === "string" && value.length > 0) args.push(flag, value);
  else if (value && typeof value === "object") args.push(flag, JSON.stringify(value));
}

function addSettings(args: string[], value: unknown) {
  if (typeof value === "string") args.push("--settings", value);
  else if (value && typeof value === "object") args.push("--settings", JSON.stringify(value));
}

function addChrome(args: string[], value: unknown) {
  if (value === true) args.push("--chrome");
  else if (value === false) args.push("--no-chrome");
}

function addNoSessionPersistence(args: string[], value: unknown) {
  if (value === false) args.push("--no-session-persistence");
}
