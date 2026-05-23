#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { Command } from "commander";

type OutputFormat = "stream-json" | "json" | "text";

type CliOptions = {
  prompt?: string;
  inputFormat: "text" | "stream-json";
  outputFormat: OutputFormat;
  verbose: boolean;
  replayUserMessages: boolean;
  includePartialMessages: boolean;
  cwd: string;
  pathToClaudeCodeExecutable?: string;
  claudeArgs: string[];
};

type JsonRecord = Record<string, unknown>;

type TranscriptRow = JsonRecord & {
  type?: string;
  subtype?: string;
  durationMs?: number;
  permissionMode?: string;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: JsonRecord;
    model?: string;
    stop_reason?: string | null;
  };
  attachment?: {
    type?: string;
    hookName?: string;
    toolUseID?: string;
    hookEvent?: string;
    content?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    addedNames?: unknown;
    removedNames?: unknown;
  };
};

type SessionMetadata = {
  sessionId: string;
  projectFolder: string;
  transcriptPath: string;
  tmuxSession: string;
  cwd: string;
  requestedModel?: string;
  requestedPermissionMode?: string;
};

type SessionDiscovery = {
  meta: SessionMetadata;
  rows: TranscriptRow[];
};

type ShutdownSignal = "SIGINT" | "SIGTERM";

type AssistantDiscovery = {
  row: TranscriptRow;
  rows: TranscriptRow[];
  durationMs?: number;
};

const POLL_MS = 100;
const START_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 180_000;
const TURN_DURATION_GRACE_MS = 1_000;
const WEB_SEARCH_COST_USD = 0.01;

type ModelPricing = {
  inputPerMTok: number;
  outputPerMTok: number;
  contextWindow?: number;
  maxOutputTokens?: number;
};

const MODEL_PRICING: Array<{ pattern: RegExp; pricing: ModelPricing }> = [
  {
    pattern: /claude-haiku-4-5|haiku/i,
    pricing: { inputPerMTok: 1, outputPerMTok: 5, contextWindow: 200_000, maxOutputTokens: 32_000 },
  },
  {
    pattern: /claude-sonnet-(4|3-7)|sonnet/i,
    pricing: { inputPerMTok: 3, outputPerMTok: 15, contextWindow: 200_000, maxOutputTokens: 64_000 },
  },
  {
    pattern: /claude-opus-4-(5|6|7)|opus-(4-5|4-6|4-7)/i,
    pricing: { inputPerMTok: 5, outputPerMTok: 25, contextWindow: 200_000, maxOutputTokens: 32_000 },
  },
  {
    pattern: /claude-opus|opus/i,
    pricing: { inputPerMTok: 15, outputPerMTok: 75, contextWindow: 200_000, maxOutputTokens: 32_000 },
  },
];

export const DEFAULT_CLAUDE_TOOLS = [
  "Task",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "Read",
  "RemoteTrigger",
  "ScheduleWakeup",
  "Skill",
  "TaskOutput",
  "TaskStop",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
];

export function parseArgs(argv: string[], cwd = process.cwd()): CliOptions {
  const program = new Command()
    .name("shannon")
    .description("Run a Claude prompt through an interactive Claude CLI session.")
    .exitOverride()
    .allowExcessArguments(false)
    .option("-p, --print <prompt>", "prompt to send to Claude")
    .argument("[prompt]", "prompt to send to Claude")
    .option("--input-format <format>", "input format", "text")
    .option("--output-format <format>", "output format", "stream-json")
    .option("--verbose", "emit verbose stream JSON", false)
    .option("--add-dir <directories...>", "additional directories to allow tool access")
    .option("--agent <agent>", "agent for the current session")
    .option("--agents <json>", "JSON object defining custom agents")
    .option("--allow-dangerously-skip-permissions", "enable bypassing all permission checks as an option")
    .option("--allowedTools, --allowed-tools <tools...>", "tool names to allow")
    .option("--append-system-prompt <prompt>", "append to the default system prompt")
    .option("--bare", "minimal Claude mode")
    .option("--betas <betas...>", "beta headers to include")
    .option("--brief", "enable SendUserMessage tool")
    .option("--chrome", "enable Claude in Chrome integration")
    .option("-c, --continue", "continue the most recent conversation")
    .option("--dangerously-skip-permissions", "bypass all permission checks")
    .option("-d, --debug [filter]", "enable debug mode")
    .option("--debug-file <path>", "write debug logs to a path")
    .option("--disable-slash-commands", "disable all skills")
    .option("--disallowedTools, --disallowed-tools <tools...>", "tool names to deny")
    .option("--effort <level>", "effort level")
    .option("--exclude-dynamic-system-prompt-sections", "exclude dynamic system prompt sections")
    .option("--fallback-model <model>", "fallback model")
    .option("--file <specs...>", "file resources to download at startup")
    .option("--fork-session", "fork when resuming")
    .option("--from-pr [value]", "resume a session linked to a PR")
    .option("--ide", "auto-connect to IDE")
    .option("--include-hook-events", "include hook lifecycle events")
    .option("--include-partial-messages", "include partial message chunks")
    .option("--json-schema <schema>", "JSON schema for structured output")
    .option("--max-budget-usd <amount>", "maximum API budget")
    .option("--mcp-config <configs...>", "MCP configs")
    .option("--mcp-debug", "enable MCP debug mode")
    .option("--model <model>", "model for the session")
    .option("-n, --name <name>", "display name for session")
    .option("--no-chrome", "disable Claude in Chrome integration")
    .option("--no-session-persistence", "disable session persistence")
    .option("--permission-mode <mode>", "permission mode")
    .option("--path-to-claude-code-executable <path>", "path to the Claude Code executable")
    .option("--plugin-dir <path>", "plugin directory", collect, [])
    .option("--plugin-url <url>", "plugin URL", collect, [])
    .option("--remote-control [name]", "start an interactive session with Remote Control enabled")
    .option("--remote-control-session-name-prefix <prefix>", "Remote Control session name prefix")
    .option("-r, --resume [value]", "resume a conversation")
    .option("--replay-user-messages", "re-emit stream-json input user messages")
    .option("--session-id <uuid>", "specific session UUID")
    .option("--setting-sources <sources>", "setting sources")
    .option("--settings <file-or-json>", "settings file or JSON")
    .option("--strict-mcp-config", "strict MCP config")
    .option("--system-prompt <prompt>", "system prompt")
    .option("--tools <tools...>", "available tools")
    .option("--tmux [mode]", "create a tmux session for the worktree")
    .option("-w, --worktree [name]", "create a new git worktree for this session")
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const parsed = program.opts<{
    print?: string;
    inputFormat: string;
    outputFormat: string;
    verbose: boolean;
    replayUserMessages?: boolean;
    [key: string]: unknown;
  }>();
  const prompt = parsed.print ?? program.args.join(" ");
  const inputFormat = parsed.inputFormat;
  const outputFormat = parsed.outputFormat;

  if (inputFormat !== "text" && inputFormat !== "stream-json") {
    throw new Error(`Unsupported --input-format ${inputFormat || "<missing>"}`);
  }

  if (!prompt && inputFormat === "text") {
    throw new Error("Expected a prompt via -p, --print, or positional prompt");
  }

  if (!isOutputFormat(outputFormat)) {
    throw new Error(`Unsupported --output-format ${outputFormat || "<missing>"}`);
  }

  return {
    prompt: prompt || undefined,
    inputFormat,
    outputFormat,
    verbose: parsed.verbose,
    replayUserMessages: parsed.replayUserMessages === true,
    includePartialMessages: parsed.includePartialMessages === true,
    cwd: resolve(cwd),
    pathToClaudeCodeExecutable: typeof parsed.pathToClaudeCodeExecutable === "string"
      ? parsed.pathToClaudeCodeExecutable
      : undefined,
    claudeArgs: buildClaudeArgs(parsed),
  };
}

function collect(value: string, previous: string[]) {
  return previous.concat(value);
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === "stream-json" || value === "json" || value === "text";
}

export function projectKeyForCwd(cwd: string): string {
  return resolve(cwd).normalize("NFC").replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function claudeProjectFolder(cwd: string, home = Bun.env.HOME ?? ""): string {
  return join(home, ".claude", "projects", projectKeyForCwd(cwd));
}

export function buildClaudeArgs(parsed: Record<string, unknown>): string[] {
  const args: string[] = [];

  addRepeated(args, "--add-dir", parsed.addDir);
  addString(args, "--agent", parsed.agent);
  addString(args, "--agents", parsed.agents);
  addBoolean(args, "--allow-dangerously-skip-permissions", parsed.allowDangerouslySkipPermissions);
  addRepeated(args, "--allowed-tools", parsed.allowedTools);
  addString(args, "--append-system-prompt", parsed.appendSystemPrompt);
  addBoolean(args, "--bare", parsed.bare);
  addRepeated(args, "--betas", parsed.betas);
  addBoolean(args, "--brief", parsed.brief);
  addBoolean(args, "--chrome", parsed.chrome);
  addBoolean(args, "--continue", parsed.continue);
  addBoolean(args, "--dangerously-skip-permissions", parsed.dangerouslySkipPermissions);
  addOptionalString(args, "--debug", parsed.debug);
  addString(args, "--debug-file", parsed.debugFile);
  addBoolean(args, "--disable-slash-commands", parsed.disableSlashCommands);
  addRepeated(args, "--disallowed-tools", parsed.disallowedTools);
  addString(args, "--effort", parsed.effort);
  addBoolean(args, "--exclude-dynamic-system-prompt-sections", parsed.excludeDynamicSystemPromptSections);
  addString(args, "--fallback-model", parsed.fallbackModel);
  addRepeated(args, "--file", parsed.file);
  addBoolean(args, "--fork-session", parsed.forkSession);
  addOptionalString(args, "--from-pr", parsed.fromPr);
  addBoolean(args, "--ide", parsed.ide);
  addBoolean(args, "--include-hook-events", parsed.includeHookEvents);
  addString(args, "--json-schema", parsed.jsonSchema);
  addString(args, "--max-budget-usd", parsed.maxBudgetUsd);
  addRepeated(args, "--mcp-config", parsed.mcpConfig);
  addBoolean(args, "--mcp-debug", parsed.mcpDebug);
  addString(args, "--model", parsed.model);
  addString(args, "--name", parsed.name);
  if (parsed.chrome === false) args.push("--no-chrome");
  addBoolean(args, "--no-session-persistence", parsed.sessionPersistence === false);
  addString(args, "--permission-mode", parsed.permissionMode);
  addRepeatedFlag(args, "--plugin-dir", parsed.pluginDir);
  addRepeatedFlag(args, "--plugin-url", parsed.pluginUrl);
  addOptionalString(args, "--remote-control", parsed.remoteControl);
  addString(args, "--remote-control-session-name-prefix", parsed.remoteControlSessionNamePrefix);
  addOptionalString(args, "--resume", parsed.resume);
  addString(args, "--session-id", parsed.sessionId);
  addString(args, "--setting-sources", parsed.settingSources);
  addString(args, "--settings", parsed.settings);
  addBoolean(args, "--strict-mcp-config", parsed.strictMcpConfig);
  addString(args, "--system-prompt", parsed.systemPrompt);
  addRepeated(args, "--tools", parsed.tools);
  addOptionalString(args, "--tmux", parsed.tmux);
  addOptionalString(args, "--worktree", parsed.worktree);

  return args;
}

function addString(args: string[], flag: string, value: unknown) {
  if (typeof value === "string" && value.length > 0) args.push(flag, value);
}

function addOptionalString(args: string[], flag: string, value: unknown) {
  if (value === true) args.push(flag);
  else addString(args, flag, value);
}

function addBoolean(args: string[], flag: string, value: unknown) {
  if (value === true) args.push(flag);
}

function addRepeated(args: string[], flag: string, value: unknown) {
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === "string");
    if (strings.length > 0) args.push(flag, ...strings);
  } else {
    addString(args, flag, value);
  }
}

function addRepeatedFlag(args: string[], flag: string, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) args.push(flag, item);
  }
}

export function modelFromClaudeArgs(args: string[]): string | undefined {
  return stringFlagFromClaudeArgs(args, "--model");
}

export function stringFlagFromClaudeArgs(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === flag) return args[i + 1];
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block && block.type === "text") {
        return "text" in block && typeof block.text === "string" ? block.text : "";
      }
      return "";
    })
    .join("");
}

export function toSdkAssistant(row: TranscriptRow): JsonRecord {
  return {
    type: "assistant",
    message: row.message,
    parent_tool_use_id: row.parent_tool_use_id ?? null,
    session_id: row.sessionId ?? row.session_id,
    uuid: row.uuid,
  };
}

export function toSdkPartialAssistant(row: TranscriptRow): JsonRecord | undefined {
  const text = textFromContent(row.message?.content);
  const sessionId = row.sessionId ?? row.session_id;
  if (!text || !sessionId) return undefined;

  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text,
      },
    },
    parent_tool_use_id: row.parent_tool_use_id ?? null,
    session_id: sessionId,
    uuid: randomUUID(),
  };
}

export function toSdkHookResponse(row: TranscriptRow): JsonRecord | undefined {
  const attachment = row.attachment;
  if (attachment?.type !== "hook_success") return undefined;

  return {
    type: "system",
    subtype: "hook_response",
    hook_id: attachment.toolUseID ?? row.uuid ?? randomUUID(),
    hook_name: attachment.hookName ?? "unknown",
    hook_event: attachment.hookEvent ?? "unknown",
    output: attachment.content || attachment.stdout || attachment.stderr || "",
    stdout: attachment.stdout ?? "",
    stderr: attachment.stderr ?? "",
    exit_code: attachment.exitCode,
    outcome: "success",
    uuid: row.uuid ?? randomUUID(),
    session_id: row.sessionId ?? row.session_id,
  };
}

export function toSdkHookStarted(row: TranscriptRow): JsonRecord | undefined {
  const attachment = row.attachment;
  if (attachment?.type !== "hook_success") return undefined;

  return {
    type: "system",
    subtype: "hook_started",
    hook_id: attachment.toolUseID ?? row.uuid ?? randomUUID(),
    hook_name: attachment.hookName ?? "unknown",
    hook_event: attachment.hookEvent ?? "unknown",
    uuid: row.uuid ?? randomUUID(),
    session_id: row.sessionId ?? row.session_id,
  };
}

export function toSdkInit(meta: SessionMetadata, rows: TranscriptRow[]): JsonRecord {
  const userRow = rows.find((row) => row.type === "user");
  const permissionModeRow = rows.find((row) => row.type === "permission-mode");
  const versionedRow = rows.find((row) => typeof row.version === "string");
  const assistantRow = rows.find((row) => typeof row.message?.model === "string");
  const skillNames = skillNamesFromRows(rows);
  const plugins = pluginsFromSkillRows(rows);
  const mcpServers = mcpServersFromRows(rows);
  const tools = toolsFromMcpServers(mcpServers);

  return {
    type: "system",
    subtype: "init",
    cwd: meta.cwd,
    session_id: meta.sessionId,
    tools,
    mcp_servers: mcpServers,
    model: assistantRow?.message?.model ?? meta.requestedModel ?? "unknown",
    permissionMode: typeof userRow?.permissionMode === "string"
      ? userRow.permissionMode
      : typeof permissionModeRow?.permissionMode === "string"
        ? permissionModeRow.permissionMode
      : meta.requestedPermissionMode ?? "unknown",
    apiKeySource: "none",
    claude_code_version: typeof versionedRow?.version === "string" ? versionedRow.version : undefined,
    output_style: "default",
    agents: [],
    slash_commands: skillNames,
    skills: skillNames,
    plugins,
    uuid: randomUUID(),
  };
}

export function toolsFromMcpServers(mcpServers: Array<{ name: string }>): string[] {
  return [
    ...DEFAULT_CLAUDE_TOOLS,
    ...mcpServers.flatMap((server) => mcpToolNames(server.name)),
  ];
}

function mcpToolNames(serverName: string) {
  switch (serverName) {
    case "context7":
      return ["mcp__context7__query-docs", "mcp__context7__resolve-library-id"];
    case "morph-mcp":
      return ["mcp__morph-mcp__codebase_search"];
    default:
      return [];
  }
}

export function mcpServersFromRows(rows: TranscriptRow[]): Array<{ name: string; status: string }> {
  const servers = new Map<string, { name: string; status: string }>();

  for (const row of rows) {
    if (row.attachment?.type !== "mcp_instructions_delta") continue;

    for (const name of stringArrayFromUnknown(row.attachment.addedNames)) {
      servers.set(name, { name, status: "connected" });
    }

    for (const name of stringArrayFromUnknown(row.attachment.removedNames)) {
      servers.delete(name);
    }
  }

  return [...servers.values()];
}

function stringArrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function skillNamesFromRows(rows: TranscriptRow[]): string[] {
  const names = new Set<string>();

  for (const row of rows) {
    if (row.attachment?.type !== "skill_listing" || typeof row.attachment.content !== "string") continue;
    for (const name of skillNamesFromListing(row.attachment.content)) {
      names.add(name);
    }
  }

  return [...names];
}

export function pluginsFromSkillRows(rows: TranscriptRow[]): Array<{ name: string; source: string }> {
  const plugins = new Map<string, { name: string; source: string }>();

  for (const row of rows) {
    if (row.attachment?.type !== "skill_listing" || typeof row.attachment.content !== "string") continue;
    for (const source of pluginSourcesFromSkillListing(row.attachment.content)) {
      plugins.set(source, { name: source, source });
    }
  }

  return [...plugins.values()];
}

export function skillNamesFromListing(content: string): string[] {
  const names: string[] = [];

  for (const line of content.split("\n")) {
    const match = /^-\s+(.+?)(?::\s|\s*$)/.exec(line);
    if (!match) continue;
    const name = match[1]?.trim();
    if (name) names.push(name);
  }

  return names;
}

export function pluginSourcesFromSkillListing(content: string): string[] {
  const sources = new Set<string>();

  for (const line of content.split("\n")) {
    const match = /^-\s+.+\(([^()]+)\)\s*$/.exec(line);
    const source = match?.[1]?.trim();
    if (source) sources.add(source);
  }

  return [...sources];
}

export function toSdkResult(row: TranscriptRow, startedAt: number, numTurns = 1, durationMsOverride?: number): JsonRecord {
  const text = textFromContent(row.message?.content);
  const usage = row.message?.usage ?? {};
  const model = row.message?.model ?? "unknown";
  const durationMs = durationMsOverride ?? Date.now() - startedAt;
  const modelUsage = toModelUsage(model, usage);
  const totalCostUsd = modelUsage.costUSD;

  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: durationMs,
    duration_api_ms: durationMs,
    num_turns: numTurns,
    result: text,
    stop_reason: row.message?.stop_reason ?? "end_turn",
    session_id: row.sessionId ?? row.session_id,
    total_cost_usd: totalCostUsd,
    usage,
    modelUsage: {
      [model]: modelUsage,
    },
    permission_denials: [],
    terminal_reason: "completed",
    uuid: randomUUID(),
  };
}

export function estimateCostUSD(model: string, usage: JsonRecord): number {
  const pricing = pricingForModel(model);
  if (!pricing) return 0;

  const inputTokens = numberFromUsage(usage.input_tokens);
  const outputTokens = numberFromUsage(usage.output_tokens);
  const cacheReadInputTokens = numberFromUsage(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = numberFromUsage(usage.cache_creation_input_tokens);
  const webSearchRequests = webSearchRequestsFromUsage(usage);

  const tokenCost = (
    inputTokens * pricing.inputPerMTok
    + cacheCreationInputTokens * pricing.inputPerMTok * 1.25
    + cacheReadInputTokens * pricing.inputPerMTok * 0.1
    + outputTokens * pricing.outputPerMTok
  ) / 1_000_000;

  return tokenCost + webSearchRequests * WEB_SEARCH_COST_USD;
}

function toModelUsage(model: string, usage: JsonRecord): JsonRecord {
  const pricing = pricingForModel(model);
  const costUSD = estimateCostUSD(model, usage);

  return {
    inputTokens: numberFromUsage(usage.input_tokens),
    outputTokens: numberFromUsage(usage.output_tokens),
    cacheReadInputTokens: numberFromUsage(usage.cache_read_input_tokens),
    cacheCreationInputTokens: numberFromUsage(usage.cache_creation_input_tokens),
    webSearchRequests: webSearchRequestsFromUsage(usage),
    costUSD,
    ...(pricing?.contextWindow !== undefined ? { contextWindow: pricing.contextWindow } : {}),
    ...(pricing?.maxOutputTokens !== undefined ? { maxOutputTokens: pricing.maxOutputTokens } : {}),
  };
}

function pricingForModel(model: string): ModelPricing | undefined {
  return MODEL_PRICING.find(({ pattern }) => pattern.test(model))?.pricing;
}

function numberFromUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function webSearchRequestsFromUsage(usage: JsonRecord): number {
  const serverToolUse = usage.server_tool_use;
  if (!serverToolUse || typeof serverToolUse !== "object") return 0;
  return numberFromUsage((serverToolUse as JsonRecord).web_search_requests);
}

export function toShannonMetadata(meta: SessionMetadata, cleanup: JsonRecord): JsonRecord {
  return {
    type: "shannon_session",
    subtype: "metadata",
    session_id: meta.sessionId,
    session_folder: meta.projectFolder,
    transcript_path: meta.transcriptPath,
    tmux_session: meta.tmuxSession,
    cwd: meta.cwd,
    cleanup,
    uuid: randomUUID(),
  };
}

export function toUserReplay(prompt: string): JsonRecord {
  return {
    type: "user",
    message: {
      role: "user",
      content: prompt,
    },
    parent_tool_use_id: null,
    session_id: "",
    uuid: randomUUID(),
  };
}

export function promptFromUserMessage(message: JsonRecord): string | undefined {
  if (message.type !== "user") return undefined;
  const nested = message.message;
  if (!nested || typeof nested !== "object") return undefined;
  const content = (nested as JsonRecord).content;
  const text = textFromContent(content);
  return text || undefined;
}

export function assistantReplyFromRows(prompt: string, rows: TranscriptRow[]): TranscriptRow | undefined {
  let sawPrompt = false;

  for (const row of rows) {
    if (row.type === "user" && row.message?.content === prompt) {
      sawPrompt = true;
      continue;
    }

    if (!sawPrompt || row.type !== "assistant" || row.message?.role !== "assistant") continue;
    if (textFromContent(row.message.content)) return row;
  }
}

export function turnDurationMsFromRows(prompt: string, rows: TranscriptRow[]): number | undefined {
  let sawPrompt = false;
  let sawAssistantReply = false;

  for (const row of rows) {
    if (row.type === "user" && row.message?.content === prompt) {
      sawPrompt = true;
      sawAssistantReply = false;
      continue;
    }

    if (!sawPrompt) continue;
    if (row.type === "assistant" && row.message?.role === "assistant" && textFromContent(row.message.content)) {
      sawAssistantReply = true;
      continue;
    }

    if (
      sawAssistantReply
      && row.type === "system"
      && row.subtype === "turn_duration"
      && typeof row.durationMs === "number"
      && Number.isFinite(row.durationMs)
    ) {
      return row.durationMs;
    }
  }
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  await runShannon(options);
}

export async function runShannon(options: CliOptions) {
  const runtime = await validateRuntime(options.pathToClaudeCodeExecutable);

  const tmuxSession = `shannon-${randomUUID()}`;
  const projectFolder = claudeProjectFolder(options.cwd);
  const before = await listTranscriptPaths(projectFolder);
  const startedAt = Date.now();
  const prompts = options.prompt
    ? asyncIterableFromArray([options.prompt])
    : readPromptsFromStdin(options.inputFormat);
  const promptIterator = prompts[Symbol.asyncIterator]();
  let meta: SessionMetadata | undefined;
  let transcriptRowCount = 0;
  let cleanup: JsonRecord = { tmux_killed: false };
  let promptCount = 0;
  let cleanupStarted = false;
  let metadataEmitted = false;
  const jsonMessages: JsonRecord[] = [];

  const cleanupOnce = async () => {
    if (cleanupStarted) return cleanup;
    cleanupStarted = true;
    cleanup = await killTmux(tmuxSession);
    return cleanup;
  };

  const emitMetadataOnce = () => {
    if (!meta || metadataEmitted || options.outputFormat !== "stream-json") return;
    metadataEmitted = true;
    emitJson(toShannonMetadata(meta, cleanup));
  };

  const disposeSignalHandlers = installSignalHandlers({
    cleanup: cleanupOnce,
    emitMetadata: emitMetadataOnce,
  });

  try {
    let prompt = await nextPrompt(promptIterator);
    if (!prompt) {
      throw new Error("Expected at least one user message on stdin for --input-format=stream-json");
    }

    const firstPromptSentAt = Date.now();
    await runCommand([
      "tmux",
      "new-session",
      "-d",
      "-s",
      tmuxSession,
      "-c",
      options.cwd,
      runtime.claude,
      ...options.claudeArgs,
      prompt,
    ]);

    let launchedWithPrompt = true;
    while (prompt) {
      promptCount += 1;

      const promptSentAt = launchedWithPrompt ? firstPromptSentAt : Date.now();
      if (!launchedWithPrompt) {
        await waitForPrompt(tmuxSession);
        await sendPrompt(tmuxSession, prompt);
      }

      if (options.replayUserMessages && options.outputFormat === "stream-json") {
        emitJson(toUserReplay(prompt));
      }

      if (!meta) {
        const discovery = await waitForSessionWithPrompt(
          projectFolder,
          before,
          tmuxSession,
          options.cwd,
          prompt,
          promptSentAt,
        );
        meta = {
          ...discovery.meta,
          requestedModel: modelFromClaudeArgs(options.claudeArgs),
          requestedPermissionMode: stringFlagFromClaudeArgs(options.claudeArgs, "--permission-mode"),
        };
        transcriptRowCount = 0;

        for (const row of discovery.rows) {
          const hookStarted = toSdkHookStarted(row);
          if (hookStarted) {
            if (options.outputFormat === "stream-json") {
              emitJson(hookStarted);
            } else if (options.outputFormat === "json") {
              jsonMessages.push(hookStarted);
            }
          }

          const hookResponse = toSdkHookResponse(row);
          if (!hookResponse) continue;
          if (options.outputFormat === "stream-json") {
            emitJson(hookResponse);
          } else if (options.outputFormat === "json") {
            jsonMessages.push(hookResponse);
          }
        }

        const init = toSdkInit(meta, discovery.rows);
        if (options.outputFormat === "stream-json") {
          emitJson(init);
        } else if (options.outputFormat === "json") {
          jsonMessages.push(init);
        }
      }

      const assistant = await waitForAssistantReply(
        meta.transcriptPath,
        prompt,
        startedAt,
        transcriptRowCount,
      );
      transcriptRowCount = assistant.rows.length;
      const result = toSdkResult(assistant.row, startedAt, promptCount, assistant.durationMs);
      const partial = options.includePartialMessages ? toSdkPartialAssistant(assistant.row) : undefined;
      const turnMessages = [
        ...(partial ? [partial] : []),
        toSdkAssistant(assistant.row),
        result,
      ];
      if (options.outputFormat === "json") {
        jsonMessages.push(...turnMessages);
      } else {
        emitOutput(options.outputFormat, turnMessages);
      }

      launchedWithPrompt = false;
      prompt = await nextPrompt(promptIterator);
    }

    if (options.outputFormat === "json") {
      process.stdout.write(`${JSON.stringify(jsonMessages)}\n`);
    }
  } finally {
    disposeSignalHandlers();
    cleanup = await cleanupOnce();
    emitMetadataOnce();
  }
}

export function signalExitCode(signal: ShutdownSignal) {
  return signal === "SIGINT" ? 130 : 143;
}

function installSignalHandlers({
  cleanup,
  emitMetadata,
}: {
  cleanup: () => Promise<JsonRecord>;
  emitMetadata: () => void;
}) {
  let shuttingDown = false;

  const handler = (signal: ShutdownSignal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    cleanup()
      .then(() => {
        emitMetadata();
      })
      .catch((error) => {
        process.stderr.write(
          `Failed to clean up Shannon tmux session after ${signal}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      })
      .finally(() => {
        process.exit(signalExitCode(signal));
      });
  };

  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);

  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

export async function validateRuntime(claudeExecutable = "claude") {
  const [claude, tmux] = await Promise.all([
    findExecutable(claudeExecutable),
    findExecutable("tmux"),
  ]);

  if (!claude) {
    throw new Error(`Missing required executable: ${claudeExecutable}. Install Claude Code and make sure it is on PATH.`);
  }

  if (!tmux) {
    throw new Error("Missing required executable: tmux. Install tmux and make sure `tmux` is on PATH.");
  }

  return { claude, tmux };
}

async function* asyncIterableFromArray(values: string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

async function* readPromptsFromStdin(inputFormat: "text" | "stream-json"): AsyncIterable<string> {
  if (inputFormat === "text") {
    const stdin = await Bun.stdin.text();
    const prompt = stdin.trimEnd();
    if (prompt) yield prompt;
    return;
  }

  for await (const line of readStdinLines()) {
    if (!line.trim()) continue;
    const prompt = promptFromUserMessage(JSON.parse(line) as JsonRecord);
    if (prompt) yield prompt;
  }
}

async function* readStdinLines(initialText?: string): AsyncIterable<string> {
  if (initialText !== undefined) {
    yield* initialText.split("\n");
    return;
  }

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) yield line;
  }

  buffer += decoder.decode();
  if (buffer) yield buffer;
}

async function waitForSessionWithPrompt(
  projectFolder: string,
  before: Set<string>,
  tmuxSession: string,
  cwd: string,
  prompt: string,
  promptSentAt: number,
): Promise<SessionDiscovery> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    const paths = await listTranscriptPaths(projectFolder);
    const fresh = [...paths].filter((path) => !before.has(path)).sort();
    const existing = [...paths].filter((path) => before.has(path)).sort();
    const candidates = [...fresh, ...existing];

    for (const transcriptPath of candidates) {
      const rows = await readTranscript(transcriptPath);
      const hasPrompt = rows.some((row) => rowContainsPromptAfter(row, prompt, promptSentAt, !before.has(transcriptPath)));
      if (!hasPrompt) continue;

      const sessionId = basename(transcriptPath).replace(/\.jsonl$/, "");
      return {
        meta: { sessionId, projectFolder, transcriptPath, tmuxSession, cwd },
        rows,
      };
    }

    await sleep(POLL_MS);
  }

  const pane = await capturePane(tmuxSession);
  throw new Error(
    `Timed out waiting for Claude transcript containing the submitted prompt in ${projectFolder}\n\nCaptured tmux pane:\n${pane}`,
  );
}

export function rowContainsPromptAfter(
  row: TranscriptRow,
  prompt: string,
  promptSentAt: number,
  allowMissingTimestamp = false,
) {
  if (row.type !== "user") return false;
  const content = row.message?.content;
  if (typeof content !== "string") return false;
  if (!promptMatchesContent(prompt, content)) return false;
  if (typeof row.timestamp !== "string") return allowMissingTimestamp;
  const timestamp = Date.parse(row.timestamp);
  return Number.isFinite(timestamp) && timestamp >= promptSentAt - 1_000;
}

function promptMatchesContent(prompt: string, content: string): boolean {
  // Plain prompts arrive verbatim in the transcript.
  if (content === prompt) return true;
  // Claude rewrites slash-command prompts into a structured envelope before
  // logging them, e.g. a prompt of `/work-on-task <id>\n\nTask: ...` becomes:
  //   <command-message>work-on-task</command-message>
  //   <command-name>/work-on-task</command-name>
  //   <command-args><id>\n\nTask: ...</command-args>
  // Anchor on the command name at the prompt's start and the args body at the
  // prompt's end; require the gap between them to be whitespace-only. This
  // stays robust to whatever Claude does with the separator (single space,
  // multiple spaces, newlines) and handles no-arg commands (where matching on
  // args alone would degenerate to endsWith("") and match anything).
  const nameMatch = content.match(/<command-name>(\/[a-z0-9:-]+)<\/command-name>/);
  if (!nameMatch) return false;
  const name = nameMatch[1];
  if (!prompt.startsWith(name)) return false;
  const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = argsMatch?.[1] ?? "";
  if (args === "") return prompt.slice(name.length).trim() === "";
  if (!prompt.endsWith(args)) return false;
  const gap = prompt.slice(name.length, prompt.length - args.length);
  return /^\s*$/.test(gap);
}

async function waitForPrompt(tmuxSession: string) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    const pane = await runCommand(["tmux", "capture-pane", "-pt", tmuxSession, "-S", "-40"]);
    if (pane.stdout.includes("❯") || pane.stdout.includes(">")) return;
    await sleep(POLL_MS);
  }

  const pane = await capturePane(tmuxSession);
  throw new Error(`Timed out waiting for Claude prompt\n\nCaptured tmux pane:\n${pane}`);
}

async function sendPrompt(tmuxSession: string, prompt: string) {
  await runCommand(["tmux", "set-buffer", "-b", `shannon-${tmuxSession}`, prompt]);
  await runCommand(["tmux", "paste-buffer", "-b", `shannon-${tmuxSession}`, "-t", tmuxSession]);
  await runCommand(["tmux", "send-keys", "-t", tmuxSession, "C-m"]);
}

async function nextPrompt(iterator: AsyncIterator<string>): Promise<string | undefined> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return undefined;
    if (next.value) return next.value;
  }
}

async function waitForAssistantReply(
  transcriptPath: string,
  prompt: string,
  startedAt: number,
  afterRowCount: number,
): Promise<AssistantDiscovery> {
  let pendingRow: TranscriptRow | undefined;
  let pendingRows: TranscriptRow[] | undefined;
  let pendingStartedAt = 0;

  while (Date.now() - startedAt < TURN_TIMEOUT_MS) {
    const rows = await readTranscript(transcriptPath);
    const newRows = rows.slice(afterRowCount);
    const row = assistantReplyFromRows(prompt, newRows);
    const durationMs = turnDurationMsFromRows(prompt, newRows);
    if (row && durationMs !== undefined) return { row, rows, durationMs };
    if (row && !pendingRow) {
      pendingRow = row;
      pendingRows = rows;
      pendingStartedAt = Date.now();
    }
    if (pendingRow && Date.now() - pendingStartedAt >= TURN_DURATION_GRACE_MS) {
      return { row: pendingRow, rows: pendingRows ?? rows };
    }

    await sleep(POLL_MS);
  }

  throw new Error(`Timed out waiting for assistant reply in ${transcriptPath}`);
}

async function readTranscript(transcriptPath: string): Promise<TranscriptRow[]> {
  const file = Bun.file(transcriptPath);
  if (!(await file.exists())) return [];

  const text = await file.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptRow;
      } catch {
        return { type: "shannon_parse_error", line };
      }
    });
}

async function listTranscriptPaths(projectFolder: string): Promise<Set<string>> {
  const glob = new Bun.Glob("*.jsonl");
  const paths = new Set<string>();

  try {
    for await (const name of glob.scan(projectFolder)) {
      paths.add(join(projectFolder, name));
    }
  } catch {
    return paths;
  }

  return paths;
}

async function killTmux(tmuxSession: string): Promise<JsonRecord> {
  const result = await runCommand(["tmux", "kill-session", "-t", tmuxSession], false);
  return {
    tmux_killed: result.exitCode === 0,
    exit_code: result.exitCode,
    stderr: result.stderr.trim(),
  };
}

async function capturePane(tmuxSession: string) {
  const result = await runCommand(
    ["tmux", "capture-pane", "-pt", tmuxSession, "-S", "-80"],
    false,
  );
  return result.stdout.trimEnd() || result.stderr.trimEnd();
}

async function findExecutable(name: string) {
  if (name.includes("/")) {
    return await Bun.file(name).exists() ? name : undefined;
  }

  const result = await runCommand(["which", name], false);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function runCommand(args: string[], throwOnFailure = true) {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (throwOnFailure && exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed with ${exitCode}: ${stderr}`);
  }

  return { stdout, stderr, exitCode };
}

function emitJson(value: JsonRecord) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function emitOutput(outputFormat: OutputFormat, messages: JsonRecord[]) {
  if (outputFormat === "stream-json") {
    for (const message of messages) emitJson(message);
    return;
  }

  const result = messages.find((message) => message.type === "result") ?? {};
  if (outputFormat === "json") {
    emitJson(result);
    return;
  }

  const text = typeof result.result === "string" ? result.result : "";
  process.stdout.write(text ? `${text}\n` : "");
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function usage() {
  return "Usage: shannon -p <prompt> --output-format=stream-json --verbose";
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
