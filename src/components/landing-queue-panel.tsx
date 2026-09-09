'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import type { LandingQueueRun, LandingQueueView } from '@/services/landing-queue';
import { formatRelative, RunStatusBadge } from './status';

/**
 * The project's landing backlog.
 *
 * Seeded from the server render so it paints without a round trip, then
 * refreshed only while something is actually in the queue. A backlog of
 * approved runs changes when a human presses a button, which no interval is
 * going to catch sooner than the next navigation; a live queue moves on its own
 * and does need watching.
 */

/** Matches the slow poll an active run gets in `use-run-stream`. */
const POLL_MS = 5_000;

export function LandingQueuePanel({
  projectId,
  initial,
}: {
  projectId: string;
  initial: LandingQueueView;
}) {
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/landing-queue`, {
        cache: 'no-store',
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: unknown }).error)
            : 'Could not read the landing queue.';
        setError(message);
        return;
      }
      setError(null);
      setView(body as LandingQueueView);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the landing queue.');
    }
  }, [projectId]);

  const live = view.liveCount > 0;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [live, refresh]);

  const total = view.liveCount + view.pendingCount;

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-[12.5px] text-ink-muted">
        <span>
          {total === 0
            ? 'Nothing is waiting to land.'
            : `${total} run${total === 1 ? '' : 's'} still to land`}
          {view.liveCount > 0 ? ` · ${view.liveCount} in the queue now` : ''}
        </span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {error ? <p className="mb-3 text-[12px] text-fail">{error}</p> : null}

      {view.branches.length === 0 ? (
        <div className="panel">
          <p className="empty-state">
            No approved run is waiting to land. Approve a run and it appears here until it
            has merged.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {view.branches.map((branch) => (
            <section key={branch.targetBranch} className="panel">
              <div className="panel-head">
                <h2 className="panel-title">
                  <code className="mono">{branch.targetBranch}</code>
                </h2>
                <span className="shrink-0 text-[11px] text-ink-faint">
                  {branch.targetBranch === view.defaultBranch ? 'default branch · ' : ''}
                  {branch.entries.length} run{branch.entries.length === 1 ? '' : 's'}
                </span>
              </div>
              <ul className="divide-y divide-line">
                {branch.entries.map((entry) => (
                  <li key={entry.id}>
                    <QueueRow entry={entry} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="hint mt-3">
        The queue itself is held in memory: runs waiting on a branch lose their place if Dev
        Cockpit restarts, and reappear here as not started.
      </p>
    </>
  );
}

function QueueRow({ entry }: { entry: LandingQueueRun }) {
  return (
    <Link
      href={`/runs/${entry.id}`}
      className="flex items-center gap-3 px-3.5 py-2 hover:bg-surface-hover"
    >
      <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-ink-faint">
        {entry.position === null ? '—' : entry.position + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{entry.title}</span>
      <code className="mono hidden shrink-0 text-ink-faint sm:block">
        {entry.branch ?? entry.id}
      </code>
      <StateBadge entry={entry} />
      <RunStatusBadge status={entry.status} />
      <span className="w-20 shrink-0 text-right text-[11px] text-ink-faint">
        {formatRelative(entry.createdAt)}
      </span>
    </Link>
  );
}

function StateBadge({ entry }: { entry: LandingQueueRun }) {
  if (entry.state === 'landing') {
    return (
      <span className="badge badge-running">
        <span className="pulse-dot" aria-hidden />
        {entry.mode === 'resolve_conflicts' ? 'Resolving' : 'Landing'}
      </span>
    );
  }

  if (entry.state === 'waiting') {
    const ahead = entry.position ?? 0;
    return (
      <span className="badge badge-warn">
        Waiting{ahead > 0 ? ` · ${ahead} ahead` : ''}
      </span>
    );
  }

  // Pending. A run that stopped mid-landing kept its landing worktree, so Land
  // resumes it rather than starting over — worth saying, because "not started"
  // would be wrong.
  return (
    <span className={`badge ${entry.stopped ? 'badge-fail' : 'badge-idle'}`}>
      {entry.stopped ? 'Stopped' : 'Not started'}
    </span>
  );
}
