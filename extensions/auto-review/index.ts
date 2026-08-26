import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Config, j, scratchpadRoot } from "jpi-base";

import { REVIEW_POLICY } from "./policy.ts";
import { isReadOnlyCommand } from "./readonly.ts";
import { splitCommand } from "./split.ts";

// The root barrel exports ToolCallEventResult but omits this sibling type
// (a gap in pi-coding-agent 0.84.3); mirror it until upstream fixes the export.
interface ToolResultEventResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
}

const COMMAND_NAME = "auto-review";
const STATUS_KEY = "@jpi-guardian/review-mode";
const MAX_REVIEW_TOKENS = 220;
const MAX_TOOL_ARGS_CHARS = 4_000;
const MAX_TRANSCRIPT_CHARS = 4_000;
const MAX_USER_MESSAGE_CHARS = 1_200;
const MAX_USER_MESSAGES = 6;
const MAX_JSON_DEPTH = 4;
const MAX_JSON_KEYS = 40;
const MAX_JSON_ITEMS = 20;
const MAX_JSON_STRING = 4_000;
const MAX_REASON_CHARS = 220;
// Canonical tool name from @juicesharp/rpiv-ask-user-question. Its
// toolResult details carry both question and answer, so no pairing with
// the originating toolCall is needed.
const QUESTION_TOOL_NAMES = new Set(["ask_user_question"]);

const guardianSchema = j.node({
  fields: {
    model: j.string().describe("model that runs the reviews").default("anthropic/claude-sonnet-5"),
    enabled: j.boolean().describe("set to #false to disable reviews").default(true),
    timeoutMs: j
      .number()
      .int()
      .positive()
      .describe("per-review timeout in milliseconds")
      .default(10_000),
    allow: j.node({
      fields: {
        tool: j.list(j.string(), {
          description: 'tool names that skip review (repeat: tool "name")',
          default: [],
        }),
        bash: j.list(j.string(), {
          description: "regexes; a full command match skips review",
          default: [],
        }),
        mcp: j.list(j.string(), {
          description: 'MCP servers whose tools skip review (repeat: mcp "server")',
          default: [],
        }),
        readonly: j
          .boolean()
          .describe("set to #false to disable the built-in read-only command list")
          .default(true),
        scratchpad: j
          .boolean()
          .describe("set to #false to review scratchpad writes too")
          .default(true),
      },
    }),
    policy: j.list(j.string(), {
      description: "extra review policy lines",
      default: [],
    }),
  },
});

type GuardianConfigValue = j.infer<typeof guardianSchema>;

type ReviewerModelSpec = {
  raw: string;
  provider: string;
  modelId: string;
};

type BashAllowPattern = {
  source: string;
  regex: RegExp;
};

type ReviewConfig = {
  path: string;
  enabled: boolean;
  model?: ReviewerModelSpec;
  allowTools: string[];
  allowBash: BashAllowPattern[];
  allowMcp: string[];
  readonly: boolean;
  scratchpad: boolean;
  policy: string[];
  timeoutMs: number;
};

type ReviewConfigState = {
  config: ReviewConfig;
  issues: string[];
};

type StatusLevel = "info" | "warning";

// jpi-status passes setStatus values through to the terminal unmodified, so
// the short status carries its own truecolor SGR sequence.
function coloredStatus(hex: string, text: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

const STATUS_OFF = coloredStatus("#949494", "⏸ manual mode on");
const STATUS_CONFIG_ERROR = coloredStatus("#cf8c88", "✕ auto config error");
const STATUS_UNKNOWN_MODEL = coloredStatus("#cf8c88", "✕ unknown model");
const STATUS_NO_AUTH = coloredStatus("#cf8c88", "✕ no review auth");
const STATUS_ON = coloredStatus("#f8c633", "⏵⏵ auto mode on");

type StatusSnapshot = {
  short: string;
  detail: string;
  level: StatusLevel;
};

type SessionEntryLike = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    details?: unknown;
  };
};

type ReviewContext = {
  cwd: string;
  signal?: AbortSignal;
  hasUI?: boolean;
  ui?: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    setStatus(key: string, value: string | undefined): void;
  };
  sessionManager: {
    getBranch(): SessionEntryLike[];
  };
  modelRegistry: {
    find(provider: string, modelId: string): unknown;
    hasConfiguredAuth(model: unknown): boolean;
    complete(
      model: unknown,
      context: unknown,
      options?: Record<string, unknown>,
    ): Promise<AssistantMessage>;
  };
};

type ReviewCommandContext = ReviewContext & {
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    setStatus(key: string, value: string | undefined): void;
  };
};

type ControllerOptions = {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  now?: () => number;
  createSessionId?: () => string;
  scratchpadRoot?: () => string;
};

type ReviewerDecision = {
  decision: "allow" | "deny";
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateInline(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function truncateUserMessage(value: string): string {
  if (value.length <= MAX_USER_MESSAGE_CHARS) return value;
  const marker = "\n[… middle content omitted; omitted text cannot authorize actions …]\n";
  const retained = MAX_USER_MESSAGE_CHARS - marker.length;
  const headLength = Math.ceil(retained / 2);
  const tailLength = Math.floor(retained / 2);
  return `${value.slice(0, headLength)}${marker}${value.slice(-tailLength)}`;
}

function freezeToolInput(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeToolInput(child, seen);
  Object.freeze(value);
}

function normalizeReason(value: string): string {
  return truncateInline(value.replace(/\s+/g, " ").trim(), MAX_REASON_CHARS);
}

export function parseReviewerModel(value: unknown): ReviewerModelSpec | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;

  const provider = raw.slice(0, slash).trim();
  const modelId = raw.slice(slash + 1).trim();
  if (!provider || !modelId) return undefined;

  return { raw, provider, modelId };
}

function mapConfigValue(value: GuardianConfigValue, path: string, issues: string[]): ReviewConfig {
  const model = parseReviewerModel(value.model);
  if (!model) issues.push('model must be set to "provider/model-id"');

  const allowBash: BashAllowPattern[] = [];
  for (const source of value.allow.bash) {
    try {
      allowBash.push({ source, regex: new RegExp(source) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`allow.bash contains an invalid regex (${source}): ${message}`);
    }
  }

  return {
    path,
    enabled: value.enabled,
    model,
    allowTools: value.allow.tool,
    allowBash,
    allowMcp: value.allow.mcp,
    readonly: value.allow.readonly,
    scratchpad: value.allow.scratchpad,
    policy: value.policy,
    timeoutMs: value.timeoutMs,
  };
}

function matchesWholeCommand(regex: RegExp, command: string): boolean {
  const match = regex.exec(command);
  if (!match) return false;
  return match.index === 0 && match[0].length === command.length;
}

// pi-mcp-adapter names server tools in one of three shapes: a namespace-proxy
// tool ("mcp__" + server, dashes to underscores), or a directly registered
// per-tool name ("server_tool" or "mcp__server_tool").
export function matchesMcpServer(toolName: string, server: string): boolean {
  if (toolName === `mcp__${server.replaceAll("-", "_")}`) return true;
  if (toolName.startsWith(`${server}_`)) return true;
  if (toolName.startsWith(`mcp__${server}_`)) return true;
  return false;
}

export function isToolAllowlisted(
  config: ReviewConfig,
  event: Pick<ToolCallEvent, "toolName" | "input">,
): boolean {
  if (config.allowTools.includes(event.toolName)) return true;
  if (config.allowMcp.some((server) => matchesMcpServer(event.toolName, server))) return true;
  if (event.toolName !== "bash") return false;

  const input: unknown = event.input;
  const command = isRecord(input) && typeof input.command === "string" ? input.command : undefined;
  if (!command) return false;

  const split = splitCommand(command);
  if (split.kind === "opaque") {
    return config.allowBash.some((pattern) => matchesWholeCommand(pattern.regex, command));
  }

  // Most-restrictive-wins: every segment needs its own justification, so one
  // unsafe half of a split command can never ride on a safe sibling.
  return split.segments.every(
    (segment) =>
      (config.readonly && isReadOnlyCommand(segment.argv)) ||
      config.allowBash.some((pattern) => matchesWholeCommand(pattern.regex, segment.text)),
  );
}

// write/edit tool inputs both carry `path`, resolved against the handler's
// cwd by pi's own tool implementation, so it is resolved the same way here.
function getPathToolTarget(event: Pick<ToolCallEvent, "toolName" | "input">): string | undefined {
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const input: unknown = event.input;
  return isRecord(input) && typeof input.path === "string" ? input.path : undefined;
}

// Containment must use path.relative, not startsWith: a sibling directory that
// merely shares the root as a string prefix (e.g. "/tmp/jpi-scratchpad-501x")
// must not pass, and a resolved "root/../escape" must land outside cleanly.
export function isWithinRoot(root: string, resolvedTarget: string): boolean {
  const rel = relative(root, resolvedTarget);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isScratchpadWrite(
  config: Pick<ReviewConfig, "scratchpad">,
  event: Pick<ToolCallEvent, "toolName" | "input">,
  cwd: string,
  scratchpadRootFn: () => string,
): boolean {
  if (!config.scratchpad) return false;
  const target = getPathToolTarget(event);
  if (!target) return false;
  return isWithinRoot(scratchpadRootFn(), resolve(cwd, target));
}

function toJsonValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    if (value.length <= MAX_JSON_STRING) return value;
    const omitted = value.length - MAX_JSON_STRING;
    return `${value.slice(0, MAX_JSON_STRING)}\n[… truncated ${omitted} chars]`;
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";

  if (Array.isArray(value)) {
    if (depth >= MAX_JSON_DEPTH) return `[array(${value.length})]`;
    const items = value.slice(0, MAX_JSON_ITEMS).map((item) => toJsonValue(item, depth + 1, seen));
    if (value.length > MAX_JSON_ITEMS)
      items.push(`[… ${value.length - MAX_JSON_ITEMS} more items]`);
    return items;
  }

  if (!isRecord(value)) return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_JSON_DEPTH) return "[object]";

  seen.add(value);
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, entryValue] of entries.slice(0, MAX_JSON_KEYS)) {
    output[key] = toJsonValue(entryValue, depth + 1, seen);
  }
  if (entries.length > MAX_JSON_KEYS) {
    output.__truncatedKeys = entries.length - MAX_JSON_KEYS;
  }
  seen.delete(value);
  return output;
}

export function stringifyBoundedJson(value: unknown, maxChars = MAX_TOOL_ARGS_CHARS): string {
  const json = JSON.stringify(toJsonValue(value), null, 2);
  if (json.length <= maxChars) return json;

  let preview = json.slice(0, Math.max(0, maxChars - 120));
  while (preview.length > 0) {
    const bounded = JSON.stringify(
      {
        truncated: true,
        omittedChars: json.length - preview.length,
        preview,
      },
      null,
      2,
    );
    if (bounded.length <= maxChars) return bounded;
    preview = preview.slice(0, Math.max(0, preview.length - (bounded.length - maxChars) - 1));
  }

  return JSON.stringify({ truncated: true, omittedChars: json.length });
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// details is a QuestionnaireResult from @juicesharp/rpiv-ask-user-question,
// a package this plugin does not depend on.
export function renderQuestionAnswers(details: unknown): string {
  if (!isRecord(details)) return "";
  if (isNonEmptyString(details.error)) return "";

  if (details.cancelled === true) {
    const decline = "[User declined to answer the question(s)]";
    return isNonEmptyString(details.globalNote) ? `${decline}\nNote: ${details.globalNote}` : decline;
  }

  if (!Array.isArray(details.answers)) return "";

  const blocks: string[] = [];
  for (const item of details.answers) {
    if (!isRecord(item) || !isNonEmptyString(item.question)) continue;

    const answerText =
      item.kind === "multi"
        ? Array.isArray(item.selected)
          ? item.selected.filter((value): value is string => typeof value === "string").join(", ")
          : undefined
        : typeof item.answer === "string"
          ? item.answer
          : undefined;
    if (answerText === undefined) continue;

    let block = `Q: ${item.question}\nA: ${answerText}`;
    if (isNonEmptyString(item.notes)) block += `\nNote: ${item.notes}`;
    blocks.push(block);
  }

  return blocks.join("\n\n");
}

type TranscriptItem = {
  text: string;
  answered: boolean;
};

export function buildRecentUserTranscript(entries: SessionEntryLike[]): string {
  const items: TranscriptItem[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const { role } = entry.message;

    if (role === "user") {
      const text = truncateUserMessage(extractUserText(entry.message.content));
      if (text) items.push({ text, answered: false });
    } else if (
      role === "toolResult" &&
      typeof entry.message.toolName === "string" &&
      QUESTION_TOOL_NAMES.has(entry.message.toolName)
    ) {
      const text = truncateUserMessage(renderQuestionAnswers(entry.message.details));
      if (text) items.push({ text, answered: true });
    }
  }

  const selected: TranscriptItem[] = [];
  let total = 0;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const nextTotal = total + item.text.length;
    if (selected.length > 0 && nextTotal > MAX_TRANSCRIPT_CHARS) break;
    if (selected.length >= MAX_USER_MESSAGES) break;
    selected.unshift(item);
    total = nextTotal;
  }

  if (selected.length === 0) return "[no recent user text]";

  const omittedMessages = items.length - selected.length;
  const omissionMarker =
    omittedMessages > 0
      ? `[… ${omittedMessages} earlier user message(s) omitted; omitted messages cannot authorize actions or establish attribution …]\n\n`
      : "";
  return `${omissionMarker}${selected
    .map(
      (item, index) =>
        `User ${index + 1}${item.answered ? " (answered agent's question)" : ""}:\n${item.text}`,
    )
    .join("\n\n")}`;
}

function getReviewerText(response: AssistantMessage): string {
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function parseReviewerDecision(rawText: string): ReviewerDecision | undefined {
  const candidates = new Set<string>();
  const trimmed = rawText.trim();
  if (!trimmed) return undefined;

  candidates.add(trimmed);

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.add(fenced[1].trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!isRecord(parsed)) continue;
      const decision =
        typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
      const reason = typeof parsed.reason === "string" ? normalizeReason(parsed.reason) : "";
      if ((decision === "allow" || decision === "deny") && reason) {
        return { decision, reason };
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

export function mergeUsage(base: Usage | undefined, extra: Usage | undefined): Usage | undefined {
  if (!base) return extra;
  if (!extra) return base;

  return {
    input: base.input + extra.input,
    output: base.output + extra.output,
    cacheRead: base.cacheRead + extra.cacheRead,
    cacheWrite: base.cacheWrite + extra.cacheWrite,
    ...(base.cacheWrite1h !== undefined || extra.cacheWrite1h !== undefined
      ? { cacheWrite1h: (base.cacheWrite1h ?? 0) + (extra.cacheWrite1h ?? 0) }
      : {}),
    ...(base.reasoning !== undefined || extra.reasoning !== undefined
      ? { reasoning: (base.reasoning ?? 0) + (extra.reasoning ?? 0) }
      : {}),
    totalTokens: base.totalTokens + extra.totalTokens,
    cost: {
      input: base.cost.input + extra.cost.input,
      output: base.cost.output + extra.cost.output,
      cacheRead: base.cost.cacheRead + extra.cost.cacheRead,
      cacheWrite: base.cost.cacheWrite + extra.cost.cacheWrite,
      total: base.cost.total + extra.cost.total,
    },
  };
}

function buildSystemPrompt(policy: string[]): string {
  if (policy.length === 0) return REVIEW_POLICY;
  return `${REVIEW_POLICY}\n\nAdditional trusted reviewer instructions:\n${policy.map((line) => `- ${line}`).join("\n")}`;
}

function buildReviewRequest(
  ctx: ReviewContext,
  event: Pick<ToolCallEvent, "toolName" | "input">,
): string {
  const transcript = buildRecentUserTranscript(ctx.sessionManager.getBranch());
  const argsJson = stringifyBoundedJson(event.input);
  return [
    "Recent user transcript (truncation markers are authorization boundaries):",
    transcript,
    `Current working directory: ${ctx.cwd}`,
    `Tool name: ${event.toolName}`,
    "Tool arguments JSON:",
    argsJson,
  ].join("\n\n");
}

function buildConfigGuidance(detail: string, path: string): ToolCallEventResult {
  return {
    block: true,
    reason: `Auto-review is enabled but unavailable: ${detail}. Fix ${path}, run /${COMMAND_NAME} reload, or use /${COMMAND_NAME} off for this session.`,
  };
}

function buildReviewFailure(reason: string, terminate: boolean): ToolCallEventResult {
  return {
    block: true,
    reason: terminate
      ? `Auto-review could not review this call again (${reason}). Stop here and ask the user instead of retrying or working around the gate.`
      : `Auto-review could not review this call (${reason}). Retry once. If review fails again, ask the user instead of working around it.`,
    terminate,
  };
}

function buildDenial(reason: string, terminate: boolean): ToolCallEventResult {
  const guidance = terminate
    ? " Stop here and ask the user before any further attempts."
    : " You may try a materially safer alternative or ask the user.";
  return {
    block: true,
    reason: `Auto-review denied this call: ${reason}. Do not workaround or circumvent this denial.${guidance}`,
    terminate,
  };
}

function buildOpenCircuit(reason: string): ToolCallEventResult {
  return {
    block: true,
    reason: `Auto-review stopped this agent run after ${reason}. Ask the user before making more tool calls.`,
    terminate: true,
  };
}

export class AutoReviewController {
  readonly cfg: Config<typeof guardianSchema>;
  readonly now: () => number;
  readonly reviewSessionId: string;
  readonly scratchpadRootFn: () => string;

  configState: ReviewConfigState | undefined;
  sessionEnabledOverride: boolean | undefined;
  consecutiveExplicitDenials = 0;
  consecutiveReviewFailures = 0;
  openCircuitReason: string | undefined;
  readonly pendingUsage = new Map<string, Usage>();

  constructor(options: ControllerOptions = {}) {
    this.cfg = new Config("guardian", guardianSchema, options.env, options.homeDirectory);
    this.now = options.now ?? Date.now;
    this.reviewSessionId = (options.createSessionId ?? randomUUID)();
    this.scratchpadRootFn = options.scratchpadRoot ?? scratchpadRoot;
  }

  async reloadConfig(): Promise<ReviewConfigState> {
    const { value, issues } = await this.cfg.load();
    const mergedIssues = [...issues];
    const config = mapConfigValue(value, this.cfg.path, mergedIssues);
    const state = { config, issues: mergedIssues };
    this.configState = state;
    return state;
  }

  async ensureConfig(): Promise<ReviewConfigState> {
    if (!this.configState) return this.reloadConfig();
    return this.configState;
  }

  resetBreakers(): void {
    this.consecutiveExplicitDenials = 0;
    this.consecutiveReviewFailures = 0;
    this.openCircuitReason = undefined;
  }

  resetAgentRun(): void {
    this.resetBreakers();
    this.pendingUsage.clear();
  }

  resetDenials(): void {
    this.consecutiveExplicitDenials = 0;
  }

  resetReviewFailures(): void {
    this.consecutiveReviewFailures = 0;
  }

  // A reviewer failure must not reset the denial streak: otherwise alternating
  // denials and failures would keep both breakers below their thresholds forever.
  recordReviewFailure(reason: string): ToolCallEventResult {
    this.consecutiveReviewFailures += 1;
    const terminate = this.consecutiveReviewFailures >= 2;
    if (terminate) this.openCircuitReason = "two consecutive reviewer failures";
    return buildReviewFailure(reason, terminate);
  }

  isEffectivelyEnabled(config: ReviewConfig): boolean {
    if (this.sessionEnabledOverride !== undefined) return this.sessionEnabledOverride;
    return config.enabled;
  }

  async getStatusSnapshot(ctx: ReviewContext): Promise<StatusSnapshot> {
    const state = await this.ensureConfig();
    const { config, issues } = state;

    if (!this.isEffectivelyEnabled(config)) {
      const source =
        this.sessionEnabledOverride === false ? "off for this session" : `off in ${config.path}`;
      return {
        short: STATUS_OFF,
        detail: `Auto-review is ${source}.`,
        level: "info",
      };
    }

    if (issues.length > 0 || !config.model) {
      return {
        short: STATUS_CONFIG_ERROR,
        detail: `Auto-review needs a valid ${config.path}: ${issues[0]!}.`,
        level: "warning",
      };
    }

    const model = ctx.modelRegistry.find(config.model.provider, config.model.modelId);
    if (!model) {
      return {
        short: STATUS_UNKNOWN_MODEL,
        detail: `Auto-review reviewer model ${config.model.raw} is not available. Update ${config.path} and run /${COMMAND_NAME} reload, or use /${COMMAND_NAME} off.`,
        level: "warning",
      };
    }

    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      return {
        short: STATUS_NO_AUTH,
        detail: `Auto-review reviewer auth is not ready for ${config.model.raw}. Fix auth or ${config.path}, then run /${COMMAND_NAME} reload, or use /${COMMAND_NAME} off.`,
        level: "warning",
      };
    }

    return {
      short: STATUS_ON,
      detail: `Auto-review is on with ${config.model.raw}.`,
      level: "info",
    };
  }

  applyStatus(ctx: ReviewContext, status: StatusSnapshot): void {
    if (!ctx.hasUI || !ctx.ui) return;
    ctx.ui.setStatus(STATUS_KEY, status.short);
  }

  async notifyStatus(ctx: ReviewCommandContext): Promise<void> {
    const status = await this.getStatusSnapshot(ctx);
    this.applyStatus(ctx, status);
    ctx.ui.notify(status.detail, status.level);
  }

  async handleCommand(rawArgs: string, ctx: ReviewCommandContext): Promise<void> {
    const command = rawArgs.trim().toLowerCase() || "status";

    if (command === "status") {
      await this.notifyStatus(ctx);
      return;
    }

    if (command === "on") {
      this.sessionEnabledOverride = true;
      this.resetBreakers();
      await this.notifyStatus(ctx);
      return;
    }

    if (command === "off") {
      this.sessionEnabledOverride = false;
      this.resetBreakers();
      await this.notifyStatus(ctx);
      return;
    }

    if (command === "reload") {
      await this.reloadConfig();
      await this.notifyStatus(ctx);
      return;
    }

    ctx.ui.notify(`Usage: /${COMMAND_NAME} [status|on|off|reload]`, "warning");
  }

  rememberUsage(toolCallId: string, usage: Usage | undefined): void {
    if (!usage) return;
    this.pendingUsage.set(
      toolCallId,
      mergeUsage(this.pendingUsage.get(toolCallId), usage) as Usage,
    );
  }

  async handleToolCall(
    event: ToolCallEvent,
    ctx: ReviewContext,
  ): Promise<ToolCallEventResult | undefined> {
    const state = await this.ensureConfig();
    const { config, issues } = state;

    if (!this.isEffectivelyEnabled(config)) {
      this.resetBreakers();
      return undefined;
    }

    if (this.openCircuitReason) return buildOpenCircuit(this.openCircuitReason);

    if (isToolAllowlisted(config, event)) {
      freezeToolInput(event.input);
      return undefined;
    }

    if (isScratchpadWrite(config, event, ctx.cwd, this.scratchpadRootFn)) {
      freezeToolInput(event.input);
      return undefined;
    }

    if (issues.length > 0 || !config.model) {
      return buildConfigGuidance(issues[0]!, config.path);
    }

    const model = ctx.modelRegistry.find(config.model.provider, config.model.modelId);
    if (!model)
      return buildConfigGuidance(
        `reviewer model ${config.model.raw} is not available`,
        config.path,
      );

    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      return buildConfigGuidance(`reviewer auth is not ready for ${config.model.raw}`, config.path);
    }

    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;

    let response: AssistantMessage;
    try {
      response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: buildSystemPrompt(config.policy),
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: buildReviewRequest(ctx, event) }],
              timestamp: this.now(),
            },
          ],
        },
        {
          cacheRetention: "short",
          maxTokens: MAX_REVIEW_TOKENS,
          reasoningEffort: "minimal",
          sessionId: this.reviewSessionId,
          signal,
          timeoutMs: config.timeoutMs,
        },
      );
    } catch (error) {
      if (timeoutSignal.aborted && !ctx.signal?.aborted) {
        return this.recordReviewFailure(`timeout after ${config.timeoutMs}ms`);
      }
      const message =
        error instanceof Error ? normalizeReason(error.message) : normalizeReason(String(error));
      return this.recordReviewFailure(message || "reviewer error");
    }

    this.rememberUsage(event.toolCallId, response.usage);

    if (response.stopReason === "aborted" && timeoutSignal.aborted && !ctx.signal?.aborted) {
      return this.recordReviewFailure(`timeout after ${config.timeoutMs}ms`);
    }

    if (response.stopReason === "error") {
      return this.recordReviewFailure(normalizeReason(response.errorMessage || "reviewer error"));
    }

    if (response.stopReason !== "stop") {
      return this.recordReviewFailure(`reviewer stopped with ${response.stopReason}`);
    }

    const decision = parseReviewerDecision(getReviewerText(response));
    if (!decision) {
      return this.recordReviewFailure("invalid reviewer output");
    }

    this.resetReviewFailures();
    if (decision.decision === "allow") {
      this.resetDenials();
      freezeToolInput(event.input);
      return undefined;
    }

    this.consecutiveExplicitDenials += 1;
    // Pi only terminates early when every tool result in the current batch sets
    // terminate, so an allowed sibling in a parallel batch delays the stop by one
    // batch. The open circuit still blocks (and terminates) every later call.
    const terminate = this.consecutiveExplicitDenials >= 3;
    if (terminate) this.openCircuitReason = "three denials without an approved call";
    return buildDenial(decision.reason, terminate);
  }

  handleToolResult(event: ToolResultEvent): ToolResultEventResult | undefined {
    const usage = this.pendingUsage.get(event.toolCallId);
    if (!usage) return undefined;
    this.pendingUsage.delete(event.toolCallId);
    return { usage: mergeUsage(event.usage, usage) };
  }

  handleToolResultMessage(message: ToolResultMessage): { message: ToolResultMessage } | undefined {
    const usage = this.pendingUsage.get(message.toolCallId);
    if (!usage) return undefined;
    this.pendingUsage.delete(message.toolCallId);
    return { message: { ...message, usage: mergeUsage(message.usage, usage) } };
  }
}

export default function autoReview(pi: ExtensionAPI) {
  const controller = new AutoReviewController();

  pi.registerCommand(COMMAND_NAME, {
    description: "Show or control auto-review",
    handler: async (args, ctx) => {
      await controller.handleCommand(args, ctx as ReviewCommandContext);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await controller.reloadConfig();
    const status = await controller.getStatusSnapshot(ctx as ReviewContext);
    controller.applyStatus(ctx as ReviewContext, status);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("before_agent_start", () => {
    controller.resetAgentRun();
  });

  pi.on("tool_call", async (event, ctx) => controller.handleToolCall(event, ctx as ReviewContext));
  pi.on("tool_result", async (event) => controller.handleToolResult(event));
  pi.on("message_end", async (event) => {
    if (event.message.role !== "toolResult") return undefined;
    return controller.handleToolResultMessage(event.message);
  });
}
