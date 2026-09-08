import { describe, expect, it } from 'vitest';

import {
  NdjsonSplitter,
  parseStreamMessage,
  summariseToolInput,
} from '@/agents/stream-parser';
import type { AgentStreamEvent } from '@/agents/types';

/**
 * These fixtures are trimmed copies of real Claude Code 2.1.263 stream-json
 * output, captured by running the CLI against a scratch repository. Keeping
 * them verbatim is the point: the parser is tested against the actual wire
 * format rather than against an assumption about it.
 */

const INIT_LINE = {
  type: 'system',
  subtype: 'init',
  cwd: 'C:\\tmp\\probe',
  session_id: 'c48d7cc1-440b-4bbc-8726-e6f0ecca1080',
  tools: ['Read', 'Write'],
  model: 'claude-sonnet-5',
  permissionMode: 'acceptEdits',
  apiKeySource: 'none',
  claude_code_version: '2.1.263',
};

const ASSISTANT_TOOL_USE = {
  type: 'assistant',
  message: {
    model: 'claude-sonnet-5',
    id: 'msg_011CeoMZuG3MpAbWNE1hFMm8',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_011FVBMxvwxSrTfRTgcqg1nA',
        name: 'Write',
        input: { file_path: 'C:\\tmp\\probe\\hello.txt', content: 'hello cockpit' },
      },
    ],
  },
  session_id: 'c48d7cc1-440b-4bbc-8726-e6f0ecca1080',
};

const ASSISTANT_TEXT = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Created hello.txt with the text "hello cockpit".' }],
  },
  session_id: 'c48d7cc1-440b-4bbc-8726-e6f0ecca1080',
};

const ASSISTANT_EMPTY_THINKING = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '', signature: 'EqMCCqgBCBEYAipA' }],
  },
  session_id: 'c48d7cc1-440b-4bbc-8726-e6f0ecca1080',
};

const TOOL_RESULT = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_011FVBMxvwxSrTfRTgcqg1nA',
        type: 'tool_result',
        content: 'File created successfully at: C:\\tmp\\probe\\hello.txt',
      },
    ],
  },
  session_id: 'c48d7cc1-440b-4bbc-8726-e6f0ecca1080',
};

const RESULT_SUCCESS = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Created hello.txt with the text "hello cockpit".',
  num_turns: 2,
  duration_ms: 15023,
  total_cost_usd: 0.196608,
  session_id: 'c48d7cc1-440b-4bbc-8726-e6f0ecca1080',
  api_error_status: null,
  terminal_reason: 'completed',
  permission_denials: [],
};

const RATE_LIMIT_LINE = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
  session_id: 'c48d7cc1-440b-4bbc-8726-e6f0ecca1080',
};

const INFORMATIONAL_LINE = {
  type: 'system',
  subtype: 'informational',
  content: 'PostToolUse:Write says: jq not found — validation skipped.',
  level: 'notice',
  session_id: 'c48d7cc1-440b-4bbc-8726-e6f0ecca1080',
};

describe('parseStreamMessage', () => {
  it('extracts the session id, model and permission mode from init', () => {
    const { events, sessionId } = parseStreamMessage(INIT_LINE);
    expect(sessionId).toBe('c48d7cc1-440b-4bbc-8726-e6f0ecca1080');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'session',
      sessionId: 'c48d7cc1-440b-4bbc-8726-e6f0ecca1080',
      model: 'claude-sonnet-5',
      permissionMode: 'acceptEdits',
    });
  });

  it('turns a tool_use block into a tool_start event', () => {
    const { events } = parseStreamMessage(ASSISTANT_TOOL_USE);
    expect(events).toHaveLength(1);
    const event = events[0] as Extract<AgentStreamEvent, { kind: 'tool_start' }>;
    expect(event.kind).toBe('tool_start');
    expect(event.tool).toBe('Write');
    expect(event.toolUseId).toBe('toolu_011FVBMxvwxSrTfRTgcqg1nA');
  });

  it('turns assistant text into a text event', () => {
    const { events } = parseStreamMessage(ASSISTANT_TEXT);
    expect(events).toEqual([
      { kind: 'text', text: 'Created hello.txt with the text "hello cockpit".' },
    ]);
  });

  it('drops empty thinking blocks rather than emitting blank events', () => {
    // Claude Code sends thinking blocks with empty text when display is omitted.
    const { events } = parseStreamMessage(ASSISTANT_EMPTY_THINKING);
    expect(events).toEqual([]);
  });

  it('turns a tool_result into a tool_end event carrying a summary', () => {
    const { events } = parseStreamMessage(TOOL_RESULT);
    expect(events).toHaveLength(1);
    const event = events[0] as Extract<AgentStreamEvent, { kind: 'tool_end' }>;
    expect(event.kind).toBe('tool_end');
    expect(event.toolUseId).toBe('toolu_011FVBMxvwxSrTfRTgcqg1nA');
    expect(event.isError).toBe(false);
    expect(event.summary).toContain('File created successfully');
  });

  it('reads success, turns, duration and cost off the result message', () => {
    const { events } = parseStreamMessage(RESULT_SUCCESS);
    const event = events[0] as Extract<AgentStreamEvent, { kind: 'result' }>;
    expect(event.kind).toBe('result');
    expect(event.ok).toBe(true);
    expect(event.numTurns).toBe(2);
    expect(event.durationMs).toBe(15023);
    expect(event.costUsd).toBeCloseTo(0.196608);
    expect(event.errorMessage).toBeNull();
  });

  it('reports an error result as not ok, with the api error status', () => {
    const { events } = parseStreamMessage({
      ...RESULT_SUCCESS,
      subtype: 'error_during_execution',
      is_error: true,
      api_error_status: 'overloaded_error',
    });
    const event = events[0] as Extract<AgentStreamEvent, { kind: 'result' }>;
    expect(event.ok).toBe(false);
    expect(event.errorMessage).toBe('overloaded_error');
  });

  it('surfaces an informational system message as a notice', () => {
    const { events } = parseStreamMessage(INFORMATIONAL_LINE);
    expect(events).toHaveLength(1);
    const event = events[0] as Extract<AgentStreamEvent, { kind: 'notice' }>;
    expect(event.level).toBe('notice');
    expect(event.text).toContain('jq not found');
  });

  it('ignores message types it does not model instead of throwing', () => {
    expect(parseStreamMessage(RATE_LIMIT_LINE).events).toEqual([]);
    expect(parseStreamMessage({ type: 'something_new_in_a_later_version' }).events).toEqual([]);
    expect(parseStreamMessage(null).events).toEqual([]);
    expect(parseStreamMessage('not an object').events).toEqual([]);
  });
});

describe('NdjsonSplitter', () => {
  it('reassembles a line split across chunk boundaries', () => {
    const seen: unknown[] = [];
    const splitter = new NdjsonSplitter((value) => seen.push(value));

    const line = JSON.stringify(ASSISTANT_TEXT);
    const cut = Math.floor(line.length / 2);
    splitter.push(line.slice(0, cut));
    expect(seen).toHaveLength(0);
    splitter.push(`${line.slice(cut)}\n`);

    expect(seen).toHaveLength(1);
    expect((seen[0] as { type: string }).type).toBe('assistant');
  });

  it('handles several lines arriving in one chunk', () => {
    const seen: unknown[] = [];
    const splitter = new NdjsonSplitter((value) => seen.push(value));
    splitter.push(
      `${JSON.stringify(INIT_LINE)}\n${JSON.stringify(ASSISTANT_TEXT)}\n${JSON.stringify(
        RESULT_SUCCESS,
      )}\n`,
    );
    expect(seen.map((s) => (s as { type: string }).type)).toEqual([
      'system',
      'assistant',
      'result',
    ]);
  });

  it('emits a trailing line with no newline on flush', () => {
    const seen: unknown[] = [];
    const splitter = new NdjsonSplitter((value) => seen.push(value));
    splitter.push(JSON.stringify(RESULT_SUCCESS));
    expect(seen).toHaveLength(0);
    splitter.flush();
    expect(seen).toHaveLength(1);
  });

  it('passes a non-JSON line through as undefined with the raw text', () => {
    const seen: { value: unknown; raw: string }[] = [];
    const splitter = new NdjsonSplitter((value, raw) => seen.push({ value, raw }));
    splitter.push('Warning: no stdin data received in 3s\n');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.value).toBeUndefined();
    expect(seen[0]?.raw).toContain('no stdin data');
  });

  it('skips blank lines', () => {
    const seen: unknown[] = [];
    const splitter = new NdjsonSplitter((value) => seen.push(value));
    splitter.push('\n\n   \n');
    splitter.flush();
    expect(seen).toEqual([]);
  });
});

describe('summariseToolInput', () => {
  it('shortens a long absolute file path to its last two segments', () => {
    expect(summariseToolInput('Write', { file_path: 'C:\\a\\b\\src\\app\\page.tsx' })).toBe(
      'app/page.tsx',
    );
  });

  it('prefers the description for a Bash call, with the command after it', () => {
    expect(
      summariseToolInput('Bash', { description: 'Run tests', command: 'pnpm test --run' }),
    ).toBe('Run tests — pnpm test --run');
  });

  it('uses only the first line of a multi-line command', () => {
    expect(summariseToolInput('Bash', { command: 'line one\nline two' })).toBe('line one');
  });

  it('describes a grep with its pattern and search path', () => {
    expect(summariseToolInput('Grep', { pattern: 'TODO', path: 'src/services' })).toBe(
      'TODO in src/services',
    );
  });

  it('returns an empty string for input it cannot describe', () => {
    expect(summariseToolInput('MysteryTool', { unexpected: 1 })).toBe('');
    expect(summariseToolInput('Write', null)).toBe('');
  });
});

describe('permission denials', () => {
  it('extracts the refused tool names off the result message', () => {
    // Captured from a real run: five read-only git commands refused because
    // acceptEdits permits file edits but not shell commands.
    const { events } = parseStreamMessage({
      ...RESULT_SUCCESS,
      permission_denials: [
        { tool_name: 'PowerShell', tool_use_id: 'toolu_1', tool_input: { command: 'git log' } },
        { tool_name: 'PowerShell', tool_use_id: 'toolu_2', tool_input: { command: 'git stash list' } },
        { tool_name: 'Bash', tool_use_id: 'toolu_3', tool_input: { command: 'git branch -a' } },
      ],
    });
    const event = events[0] as Extract<AgentStreamEvent, { kind: 'result' }>;
    // Deduplicated: three denials, two distinct tools.
    expect(event.deniedTools).toEqual(['PowerShell', 'Bash']);
  });

  it('reports no denials when the field is absent or empty', () => {
    const absent = parseStreamMessage(RESULT_SUCCESS).events[0] as Extract<
      AgentStreamEvent,
      { kind: 'result' }
    >;
    expect(absent.deniedTools).toEqual([]);

    const empty = parseStreamMessage({ ...RESULT_SUCCESS, permission_denials: [] })
      .events[0] as Extract<AgentStreamEvent, { kind: 'result' }>;
    expect(empty.deniedTools).toEqual([]);
  });

  it('ignores malformed denial entries rather than throwing', () => {
    const { events } = parseStreamMessage({
      ...RESULT_SUCCESS,
      permission_denials: [null, 'nonsense', {}, { tool_name: '' }, { tool_name: 'Bash' }],
    });
    const event = events[0] as Extract<AgentStreamEvent, { kind: 'result' }>;
    expect(event.deniedTools).toEqual(['Bash']);
  });
});
