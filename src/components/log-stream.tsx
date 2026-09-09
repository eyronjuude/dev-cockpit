'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import type { RunEvent } from '@/domain/events';
import { LogLine, touchesCode } from './log-line';

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
 * delivers for the progress panel, so a line appears in the log at the moment
 * the orchestrator writes it, with no refresh and no polling.
 *
 * Each line is drawn by `log-line.tsx` — the same row the progress panel uses,
 * so the newest line there and the last line here are the same line.
 */

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
  const effectiveSeenSeq = following ? newestSeq : seenSeq;

  // Stick to the tail while the user is at the bottom. Writing scrollTop fires
  // a scroll event, which re-confirms `following` rather than fighting it.
  useEffect(() => {
    if (!following) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [following, newestSeq]);

  let behind = 0;
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    const event = visible[i];
    if (!event || event.seq <= effectiveSeenSeq) break;
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
                  setSeenSeq(newestSeq);
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
          const nextFollowing = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          setFollowing(nextFollowing);
          if (nextFollowing) setSeenSeq(newestSeq);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2"
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
          <ol className="space-y-0.5">
            {visible.map((event) => (
              <li key={event.seq}>
                <LogLine event={event} />
              </li>
            ))}
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
