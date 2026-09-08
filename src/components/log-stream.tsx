'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { redactPatterns } from '@/core/redact-patterns';
import type { EventLevel, RunEvent } from '@/domain/events';
import { formatTime } from './status';

/**
 * The live log.
 *
 * Every event the run has produced, in the order it happened, appended at the
 * bottom the way a terminal log behaves — so the newest line is the one you
 * scroll down to, and the shape of the run reads top to bottom.
 *
 * It follows the tail while you are at the bottom and stops the moment you
 * scroll up, because a log that yanks itself away mid-read is worse than no
 * log. A counter of what arrived while you were reading is the way back.
 *
 * Nothing here is fetched. The events are the same ones the SSE stream already
 * delivers for the progress feed, so a line appears in the log at the moment
 * the orchestrator writes it, with no refresh and no polling.
 */

/** Tools whose call means the codebase changed. */
const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Update',
  'Create',
  'ApplyPatch',
]);

const LEVEL_TONE: Record<EventLevel, string> = {
  debug: 'text-ink-faint',
  info: 'text-ink-muted',
  notice: 'text-warn',
  error: 'text-fail',
};

/** Events that carry prose worth printing in full under the summary line. */
const TEXT_EVENTS = new Set([
  'agent.message',
  'agent.thinking',
  'agent.notice',
  'run.needs_changes',
]);

const MAX_DETAIL_CHARS = 4_000;

/**
 * Payloads are typed per event, so reading one field across every type needs a
 * widening cast. Done once, here, rather than at each call site.
 */
function payloadField(event: RunEvent, key: string): string | null {
  const record = event.payload as unknown as Record<string, unknown>;
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function touchesCode(event: RunEvent): boolean {
  if (event.type === 'file.changed' || event.type === 'run.commit_created') return true;
  if (event.type !== 'agent.tool_started' && event.type !== 'agent.tool_completed') return false;
  const tool = payloadField(event, 'tool');
  return tool !== null && WRITE_TOOLS.has(tool);
}

function detailFor(event: RunEvent): string | null {
  if (!TEXT_EVENTS.has(event.type)) return null;
  const text = payloadField(event, 'text');
  if (text === null) return null;
  const trimmed = text.trim();
  // The message line already carries the first line of short prose; repeating
  // it under itself would double every agent message in the log.
  if (trimmed.length === 0 || trimmed === event.message) return null;
  const safe = redactPatterns(trimmed).text;
  return safe.length > MAX_DETAIL_CHARS
    ? `${safe.slice(0, MAX_DETAIL_CHARS)}\n… ${safe.length - MAX_DETAIL_CHARS} more characters — see the saved log file`
    : safe;
}

export function LogStream({
  events,
  connected,
  active,
}: {
  events: readonly RunEvent[];
  connected: boolean;
  active: boolean;
}) {
  const [verbose, setVerbose] = useState(true);
  const [changesOnly, setChangesOnly] = useState(false);
  const [following, setFollowing] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(() => {
    let lines = events;
    if (!verbose) lines = lines.filter((e) => e.level !== 'debug');
    if (changesOnly) lines = lines.filter(touchesCode);
    return lines;
  }, [events, verbose, changesOnly]);

  const newestSeq = visible.at(-1)?.seq ?? 0;
  const [seenSeq, setSeenSeq] = useState(newestSeq);

  // Stick to the tail while the user is at the bottom. Writing scrollTop fires
  // a scroll event, which re-confirms `following` rather than fighting it.
  useEffect(() => {
    if (!following) return;
    setSeenSeq(newestSeq);
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [following, newestSeq]);

  let behind = 0;
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    const event = visible[i];
    if (!event || event.seq <= seenSeq) break;
    behind += 1;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-line px-3.5 py-1.5">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span
              className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-pass' : 'bg-idle'} ${
                connected && active ? 'pulse-dot' : ''
              }`}
              aria-hidden
            />
            {connected ? (active ? 'streaming' : 'live') : 'reconnecting'}
          </span>
          <span className="text-[11px] tabular-nums text-ink-faint">
            {visible.length} line{visible.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-faint">
            <input
              type="checkbox"
              checked={verbose}
              onChange={(e) => setVerbose(e.target.checked)}
              className="accent-accent"
            />
            verbose
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-faint">
            <input
              type="checkbox"
              checked={changesOnly}
              onChange={(e) => setChangesOnly(e.target.checked)}
              className="accent-accent"
            />
            code changes only
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-faint">
            <input
              type="checkbox"
              checked={following}
              onChange={(e) => {
                setFollowing(e.target.checked);
                if (e.target.checked) {
                  const node = scrollRef.current;
                  if (node) node.scrollTop = node.scrollHeight;
                }
              }}
              className="accent-accent"
            />
            follow
          </label>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        {visible.length === 0 ? (
          <p className="empty-state">
            {active
              ? 'Waiting for the agent’s first line…'
              : changesOnly
                ? 'No code changes recorded yet.'
                : 'Nothing has been logged for this run yet.'}
          </p>
        ) : (
          <ol>
            {visible.map((event) => {
              const detail = detailFor(event);
              const changed = touchesCode(event);
              return (
                <li key={event.seq} className="flex gap-2 py-[1px]">
                  <span className="w-14 shrink-0 pt-px text-[10.5px] tabular-nums text-ink-faint">
                    {formatTime(event.createdAt)}
                  </span>
                  <span
                    className={`w-3 shrink-0 text-center text-[11px] ${
                      changed ? 'text-accent' : 'text-ink-faint'
                    }`}
                    aria-hidden
                  >
                    {changed ? '▍' : '│'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-mono text-[11.5px] leading-relaxed">
                      <span className="text-ink-faint">{event.type}</span>{' '}
                      <span className={changed ? 'text-ink' : LEVEL_TONE[event.level]}>
                        {event.message}
                      </span>
                    </p>
                    {detail ? (
                      <pre className="log my-0.5 border-l border-line py-0.5 pl-2.5">{detail}</pre>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {behind > 0 ? (
        <div className="shrink-0 border-t border-line px-3.5 py-1.5">
          <button
            type="button"
            className="btn btn-sm w-full"
            onClick={() => {
              setFollowing(true);
              const node = scrollRef.current;
              if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
            }}
          >
            ↓ {behind} newer {behind === 1 ? 'line' : 'lines'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
