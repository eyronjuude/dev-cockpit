import type { AgentStreamEvent } from './types';

/**
 * Parser for Claude Code's `--output-format stream-json` protocol.
 *
 * The wire format is newline-delimited JSON, one object per line. Shapes below
 * were captured from Claude Code 2.1.263 rather than assumed; unknown types are
 * ignored instead of throwing, because the CLI adds message types over time and
 * a run must not fail because of one.
 *
 * ANSI terminal output is never the protocol here. Nothing in this file parses
 * escape codes or screen positions.
 */

/* ---------- Wire types (partial: only the fields that are used) ---------- */

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface WireTextBlock {
  type: 'text';
  text: string;
}

interface WireThinkingBlock {
  type: 'thinking';
  thinking: string;
}

interface WireToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

type WireContentBlock =
  | WireTextBlock
  | WireThinkingBlock
  | WireToolUseBlock
  | { type: string; [k: string]: unknown };

interface WireToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

interface WireInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  claude_code_version?: string;
  apiKeySource?: string;
}

interface WireSystemMessage {
  type: 'system';
  subtype: string;
  content?: string;
  level?: string;
  session_id?: string;
  hook_name?: string;
  outcome?: string;
  stderr?: string;
}

interface WireAssistantMessage {
  type: 'assistant';
  message: { content?: WireContentBlock[]; usage?: WireUsage; model?: string };
  session_id?: string;
}

interface WireUserMessage {
  type: 'user';
  message: { content?: (WireToolResultBlock | { type: string; [k: string]: unknown })[] };
  session_id?: string;
}

interface WireResultMessage {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  session_id?: string;
  api_error_status?: string | null;
  terminal_reason?: string;
  permission_denials?: unknown[];
}

type WireMessage =
  | WireInitMessage
  | WireSystemMessage
  | WireAssistantMessage
  | WireUserMessage
  | WireResultMessage
  | { type: string; [k: string]: unknown };

/* ---------- Tool summaries ---------- */

/**
 * One-line description of a tool call for the progress feed. Keeps the UI
 * readable without the user opening the raw log.
 */
export function summariseToolInput(tool: string, input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const str = (key: string): string | null => {
    const v = obj[key];
    return typeof v === 'string' ? v : null;
  };

  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return shortenPath(str('file_path') ?? str('notebook_path') ?? '');
    case 'Bash':
    case 'PowerShell': {
      const description = str('description');
      const command = str('command') ?? '';
      return description ? `${description} — ${firstLine(command)}` : firstLine(command);
    }
    case 'Glob':
      return str('pattern') ?? '';
    case 'Grep': {
      const pattern = str('pattern') ?? '';
      const where = str('path');
      return where ? `${pattern} in ${shortenPath(where)}` : pattern;
    }
    case 'Task':
    case 'Agent':
      return str('description') ?? str('subagent_type') ?? '';
    case 'TodoWrite':
      return 'updated task list';
    case 'WebFetch':
      return str('url') ?? '';
    case 'WebSearch':
      return str('query') ?? '';
    case 'Skill':
      return str('skill') ?? '';
    default: {
      const candidate = str('file_path') ?? str('path') ?? str('description') ?? str('query');
      return candidate ? shortenPath(candidate) : '';
    }
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/** Trims a long absolute path to its last two segments. */
function shortenPath(p: string): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}

function summariseToolResult(content: unknown): string {
  if (typeof content === 'string') return firstLine(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        const text = (part as { text?: string }).text;
        if (typeof text === 'string') return firstLine(text);
      }
    }
    return `${content.length} content block(s)`;
  }
  if (content && typeof content === 'object') return 'structured result';
  return '';
}

/**
 * Tool names the CLI refused, deduplicated.
 *
 * Worth surfacing: under a permission mode that forbids commands, an agent
 * works blind, and the run otherwise reads as if it simply chose not to check
 * anything. Observed on a real run — five denied read-only git commands.
 */
function summariseDenials(denials: unknown): string[] {
  if (!Array.isArray(denials)) return [];
  const names = new Set<string>();
  for (const entry of denials) {
    if (entry === null || typeof entry !== 'object') continue;
    const name = (entry as { tool_name?: unknown }).tool_name;
    if (typeof name === 'string' && name.length > 0) names.add(name);
  }
  return [...names];
}

/* ---------- Parser ---------- */

export interface ParsedLine {
  events: AgentStreamEvent[];
  /** Session id, whenever this line carried one. */
  sessionId: string | null;
}

/**
 * Translates one wire message into zero or more normalised agent events.
 * Pure: no I/O, no state, which is what makes it directly testable.
 */
export function parseStreamMessage(raw: unknown): ParsedLine {
  const events: AgentStreamEvent[] = [];
  if (raw === null || typeof raw !== 'object') return { events, sessionId: null };

  const msg = raw as WireMessage;
  const sessionId =
    typeof (msg as { session_id?: unknown }).session_id === 'string'
      ? ((msg as { session_id: string }).session_id)
      : null;

  switch (msg.type) {
    case 'system': {
      const sys = msg as WireSystemMessage;
      if (sys.subtype === 'init') {
        const init = msg as WireInitMessage;
        events.push({
          kind: 'session',
          sessionId: init.session_id,
          model: init.model ?? null,
          permissionMode: init.permissionMode ?? null,
        });
      } else if (sys.subtype === 'informational' && typeof sys.content === 'string') {
        events.push({
          kind: 'notice',
          text: sys.content,
          level: sys.level === 'error' ? 'error' : 'notice',
        });
      } else if (sys.subtype === 'hook_response' && sys.outcome === 'error') {
        // A failing hook in the target repo is worth surfacing: it usually
        // means the agent's environment is misconfigured, not that work failed.
        const detail = (sys.stderr ?? '').trim() || 'hook failed';
        events.push({
          kind: 'notice',
          text: `Hook ${sys.hook_name ?? '(unknown)'}: ${firstLine(detail)}`,
          level: 'notice',
        });
      }
      break;
    }

    case 'assistant': {
      const assistant = msg as WireAssistantMessage;
      for (const block of assistant.message?.content ?? []) {
        if (block.type === 'text') {
          const text = (block as WireTextBlock).text;
          if (text?.trim()) events.push({ kind: 'text', text });
        } else if (block.type === 'thinking') {
          const text = (block as WireThinkingBlock).thinking;
          if (text?.trim()) events.push({ kind: 'thinking', text });
        } else if (block.type === 'tool_use') {
          const tool = block as WireToolUseBlock;
          events.push({
            kind: 'tool_start',
            toolUseId: tool.id,
            tool: tool.name,
            input: tool.input,
          });
        }
      }
      break;
    }

    case 'user': {
      const user = msg as WireUserMessage;
      for (const block of user.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const result = block as WireToolResultBlock;
        events.push({
          kind: 'tool_end',
          toolUseId: result.tool_use_id,
          tool: '',
          isError: result.is_error === true,
          summary: summariseToolResult(result.content),
        });
      }
      break;
    }

    case 'result': {
      const result = msg as WireResultMessage;
      const failed = result.is_error === true || result.subtype !== 'success';
      const apiError =
        typeof result.api_error_status === 'string' ? result.api_error_status : null;
      events.push({
        kind: 'result',
        ok: !failed,
        finalText: typeof result.result === 'string' ? result.result : null,
        numTurns: typeof result.num_turns === 'number' ? result.num_turns : null,
        durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : null,
        costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
        errorMessage: failed
          ? (apiError ?? result.terminal_reason ?? result.subtype ?? 'agent reported an error')
          : null,
        deniedTools: summariseDenials(result.permission_denials),
      });
      break;
    }

    // rate_limit_event, stream_event, prompt_suggestion and anything added
    // later are intentionally ignored rather than treated as errors.
    default:
      break;
  }

  return { events, sessionId };
}

/**
 * Incremental newline-delimited JSON reader.
 *
 * A stream chunk can split a line anywhere, and a single line can exceed the
 * chunk size, so the remainder is buffered between calls.
 */
export class NdjsonSplitter {
  private buffer = '';

  constructor(private readonly onLine: (value: unknown, raw: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.emit(line);
      index = this.buffer.indexOf('\n');
    }
  }

  flush(): void {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line) this.emit(line);
  }

  private emit(line: string): void {
    try {
      this.onLine(JSON.parse(line), line);
    } catch {
      // Not JSON: the CLI occasionally prints a plain warning line. Pass it
      // through as an unparsed value so the caller can log it.
      this.onLine(undefined, line);
    }
  }
}
