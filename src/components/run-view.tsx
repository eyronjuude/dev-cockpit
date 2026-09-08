'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import type { RunEvent } from '@/domain/events';
import { computeRunProgress } from '@/domain/progress';
import type { ChangeType } from '@/domain/types';
import { CHANGE_TYPE_TONE, type BadgeTone } from '@/domain/vocabulary';
import { ArtifactPanel } from './artifact-panel';
import { DiffView } from './diff-view';
import { EventFeed } from './event-feed';
import { LogStream } from './log-stream';
import { Markdown } from './markdown';
import { ReadinessNotice, RunActions } from './run-actions';
import { Scorecard } from './scorecard';
import {
  formatDuration,
  formatRelative,
  RunStatusBadge,
  SeverityBadge,
  formatTime,
  runStatusLabel,
} from './status';
import { useRunStream, type RunSnapshot } from './use-run-stream';

const TABS = ['Overview', 'Map', 'Changes', 'Diff', 'Tests', 'Artifacts', 'Logs'] as const;
type Tab = (typeof TABS)[number];

/**
 * Written out in full rather than interpolated: Tailwind scans source text for
 * class names, so a composed `text-${tone}` would never be generated.
 */
const TONE_TEXT: Record<BadgeTone, string> = {
  pass: 'text-pass',
  fail: 'text-fail',
  warn: 'text-warn',
  running: 'text-running',
  idle: 'text-ink-faint',
  accent: 'text-accent',
};

const changeTone = (type: ChangeType): string => TONE_TEXT[CHANGE_TYPE_TONE[type]];

export function RunView({ initial }: { initial: RunSnapshot }) {
  const { events, snapshot, connected, refresh } = useRunStream(initial.run.id, initial);
  const { run, readiness, artifacts, live } = snapshot;
  const [tab, setTab] = useState<Tab>('Overview');

  const latestAttempt = useMemo(
    () => run.validations.reduce((acc, v) => Math.max(acc, v.attempt), 0),
    [run.validations],
  );

  const elapsed = useElapsed(run.startedAt, run.finishedAt, live.active);

  const diffArtifact = artifacts.filter((a) => a.kind === 'git_diff').at(-1);
  const mapArtifacts = artifacts.filter((a) => a.kind === 'implementation_map');
  const logArtifacts = artifacts.filter(
    (a) =>
      a.kind === 'implementation_log' || a.kind === 'stdout_log' || a.kind === 'stderr_log',
  );

  const latestIteration = run.iterations.at(-1) ?? null;
  const latestFindingAttempt = run.findings.reduce((acc, f) => Math.max(acc, f.attempt), 0);
  const currentFindings = run.findings.filter((f) => f.attempt === latestFindingAttempt);

  // Phase-level progress, recomputed from the snapshot the stream keeps fresh,
  // so the bar advances while the run does rather than on a page reload.
  const progress = useMemo(
    () =>
      computeRunProgress({
        status: run.status,
        phase: live.phase,
        active: live.active,
        evidence: {
          hasSpec: run.spec !== null,
          hasWorktree: run.worktreePath !== null,
          iterations: run.iterations.length,
          changedFiles: run.changedFiles.length,
          validations: run.validations.length,
          reviewFindings: run.findings.length,
        },
      }),
    [
      run.status,
      run.spec,
      run.worktreePath,
      run.iterations.length,
      run.changedFiles.length,
      run.validations.length,
      run.findings.length,
      live.active,
      live.phase,
    ],
  );

  // The newest line, so the current activity is readable without scrolling.
  const newestMessage = events.at(-1)?.message ?? null;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="shrink-0 border-b border-line bg-surface px-5 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11.5px] text-ink-faint">
              <Link href="/runs" className="hover:text-ink">
                Runs
              </Link>
              <span aria-hidden>/</span>
              <Link href={`/projects/${run.projectId}`} className="hover:text-ink">
                {run.projectName}
              </Link>
            </div>
            <h1 className="mt-0.5 truncate text-[17px] font-semibold tracking-tight">
              {run.title}
            </h1>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            <RunStatusBadge status={run.status} />
            {live.active && live.phase ? (
              <span className="text-[11.5px] text-running">{live.phase}…</span>
            ) : null}
          </div>
        </div>

        <dl className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11.5px]">
          <Meta label="Branch" value={run.branch ?? '—'} mono />
          <Meta
            label="Base"
            value={run.baseCommit ? `${run.baseBranch ?? '?'} @ ${run.baseCommit.slice(0, 7)}` : '—'}
            mono
          />
          <Meta label="Profile" value={run.profile} />
          <Meta label="Elapsed" value={elapsed} />
          {run.agentSessionId ? (
            <Meta label="Session" value={run.agentSessionId.slice(0, 8)} mono />
          ) : null}
          {run.agentModel ? <Meta label="Model" value={run.agentModel} /> : null}
          {run.costUsd !== null ? (
            <Meta label="Cost" value={`$${run.costUsd.toFixed(4)}`} />
          ) : null}
          {run.commitSha ? <Meta label="Commit" value={run.commitSha.slice(0, 7)} mono /> : null}
        </dl>

        {run.worktreePath ? (
          <p className="mono mt-1.5 truncate text-ink-faint" title={run.worktreePath}>
            {run.worktreePath}
          </p>
        ) : null}
      </header>

      {run.error ? (
        <div className="shrink-0 border-b border-fail/30 bg-fail-soft px-5 py-2 text-[12.5px] text-fail">
          {run.error}
        </div>
      ) : null}

      {/* Body */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,420px)] divide-x divide-line">
        {/* Evidence */}
        <section className="flex min-h-0 flex-col">
          <div
            className="flex shrink-0 items-center gap-0.5 border-b border-line px-3"
            role="tablist"
            aria-label="Run evidence"
          >
            {TABS.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                className={`tab ${tab === name ? 'tab-active' : ''}`}
                onClick={() => setTab(name)}
              >
                {name}
                {name === 'Changes' && run.changedFiles.length > 0 ? (
                  <span className="ml-1.5 text-[10.5px] text-ink-faint">
                    {run.changedFiles.length}
                  </span>
                ) : null}
                {name === 'Artifacts' && artifacts.length > 0 ? (
                  <span className="ml-1.5 text-[10.5px] text-ink-faint">{artifacts.length}</span>
                ) : null}
                {name === 'Logs' && live.active ? (
                  <span className="ml-1.5 inline-flex items-center text-running" title="streaming">
                    <span className="pulse-dot" aria-hidden />
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'Overview' ? (
              <OverviewTab
                snapshot={snapshot}
                findings={currentFindings}
                latestIteration={latestIteration}
              />
            ) : null}

            {tab === 'Map' ? <MapTab artifacts={mapArtifacts} /> : null}

            {tab === 'Changes' ? (
              run.changedFiles.length === 0 ? (
                <p className="empty-state">No file changes recorded.</p>
              ) : (
                <table className="w-full text-[12.5px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-muted">
                      <th className="px-3.5 py-1.5 font-semibold">File</th>
                      <th className="w-24 px-2 py-1.5 font-semibold">Change</th>
                      <th className="w-20 px-2 py-1.5 text-right font-semibold">+</th>
                      <th className="w-20 px-3.5 py-1.5 text-right font-semibold">−</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {run.changedFiles.map((file) => (
                      <tr key={file.path} className="hover:bg-surface-hover">
                        <td className="px-3.5 py-1.5">
                          <code className="mono break-all">{file.path}</code>
                          {file.previousPath ? (
                            <span className="mono block text-ink-faint">
                              was {file.previousPath}
                            </span>
                          ) : null}
                        </td>
                        <td className={`px-2 py-1.5 ${changeTone(file.changeType)}`}>
                          {file.changeType}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-pass">
                          {file.binary ? '—' : file.additions}
                        </td>
                        <td className="px-3.5 py-1.5 text-right tabular-nums text-fail">
                          {file.binary ? '—' : file.deletions}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : null}

            {tab === 'Diff' ? (
              diffArtifact ? (
                <LazyDiff artifactId={diffArtifact.id} />
              ) : (
                <p className="empty-state">No diff has been captured yet.</p>
              )
            ) : null}

            {tab === 'Tests' ? (
              <TestsTab snapshot={snapshot} latestAttempt={latestAttempt} />
            ) : null}

            {tab === 'Artifacts' ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <ArtifactPanel artifacts={artifacts} />
              </div>
            ) : null}

            {tab === 'Logs' ? (
              <LogsTab
                events={events}
                artifacts={logArtifacts}
                connected={connected}
                active={live.active}
              />
            ) : null}
          </div>
        </section>

        {/* Right rail: actions and live state, always visible without scrolling */}
        <aside className="flex min-h-0 flex-col">
          <div className="shrink-0 space-y-3 p-3.5 pb-0">
            <RunActions snapshot={snapshot} onChanged={refresh} />
            <ReadinessNotice readiness={readiness} status={run.status} />

            {run.dispositionNote ? (
              <p className="text-[12.5px] text-ink-muted">
                <span className="font-medium">Note:</span> {run.dispositionNote}
              </p>
            ) : null}

            <Scorecard
              validations={run.validations}
              configured={snapshot.configuredValidations}
              attempt={latestAttempt > 0 ? latestAttempt : null}
            />
          </div>

          <div className="min-h-0 flex-1 p-3.5">
            <EventFeed
              events={events}
              connected={connected}
              active={live.active}
              progress={progress}
              progressLabel={progress.activeLabel ?? runStatusLabel(run.status)}
              progressDetail={live.active ? newestMessage : null}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-faint">{label}</dt>
      <dd className={mono ? 'mono text-ink' : 'text-ink'}>{value}</dd>
    </div>
  );
}

function OverviewTab({
  snapshot,
  findings,
  latestIteration,
}: {
  snapshot: RunSnapshot;
  findings: RunSnapshot['run']['findings'];
  latestIteration: RunSnapshot['run']['iterations'][number] | null;
}) {
  const { run, policies } = snapshot;
  const claim = latestIteration?.finalText ?? null;
  const interpreted = latestIteration?.summary ?? null;

  return (
    <div className="space-y-3.5 p-3.5">
      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Request</h2>
          <span className="text-[11px] text-ink-faint">stored exactly as written</span>
        </div>
        <p className="whitespace-pre-wrap px-3.5 py-2.5 text-[12.5px] leading-relaxed">
          {run.request}
        </p>
      </div>

      {run.spec && run.spec.trim() !== run.request.trim() ? (
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Implementation specification</h2>
            {run.specProvider ? (
              <span className="badge badge-accent">{run.specProvider}</span>
            ) : null}
          </div>
          <Markdown className="px-3.5 py-2.5">{run.spec}</Markdown>
        </div>
      ) : null}

      {interpreted ? (
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">What happened, in plain language</h2>
            {latestIteration?.summaryProvider ? (
              <span className="badge badge-accent">{latestIteration.summaryProvider}</span>
            ) : null}
          </div>
          <Markdown className="px-3.5 py-2.5">{interpreted}</Markdown>
          <p className="border-t border-line px-3.5 py-1.5 text-[11px] text-ink-faint">
            An interpretation of the implementer&rsquo;s own words, below. Still a claim — validation
            is recorded separately.
          </p>
        </div>
      ) : null}

      {claim ? (
        <details className="panel" open={interpreted === null}>
          <summary className="panel-head cursor-pointer list-none">
            <h2 className="panel-title">
              Implementer&rsquo;s summary{interpreted ? ' (original)' : ''}
            </h2>
            <span className="text-[11px] text-ink-faint">
              a claim, not evidence — validation is recorded separately
            </span>
          </summary>
          <Markdown className="px-3.5 py-2.5">{claim}</Markdown>
        </details>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Iterations</h2>
        </div>
        {run.iterations.length === 0 ? (
          <p className="empty-state">No implementation iterations yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {run.iterations.map((iteration) => (
              <li key={iteration.id} className="px-3.5 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span className="font-medium">#{iteration.ordinal}</span>
                  <span className="badge badge-idle">{iteration.kind.replace('_', ' ')}</span>
                  <span
                    className={`badge ${
                      iteration.status === 'completed'
                        ? 'badge-pass'
                        : iteration.status === 'failed'
                          ? 'badge-fail'
                          : iteration.status === 'running'
                            ? 'badge-running'
                            : 'badge-idle'
                    }`}
                  >
                    {iteration.status}
                  </span>
                  {iteration.resumed ? (
                    <span className="badge badge-accent" title="Continued the existing session">
                      resumed
                    </span>
                  ) : null}
                  <span className="text-[11px] text-ink-faint">
                    {formatTime(iteration.startedAt)}
                    {iteration.numTurns !== null ? ` · ${iteration.numTurns} turns` : ''}
                    {iteration.costUsd !== null ? ` · $${iteration.costUsd.toFixed(4)}` : ''}
                  </span>
                </div>
                {iteration.error ? (
                  <p className="mt-1 text-[12px] text-fail">{iteration.error}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Independent review</h2>
          <span className="text-[11px] text-ink-faint">opinions, not test results</span>
        </div>
        {findings.length === 0 ? (
          <p className="empty-state">
            {run.reviewerProvider && run.reviewerProvider !== 'none'
              ? 'No findings recorded.'
              : 'No reviewer was configured for this run.'}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {findings.map((finding) => (
              <li key={finding.id} className="px-3.5 py-2">
                <div className="flex items-start gap-2">
                  <SeverityBadge severity={finding.severity} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-medium">{finding.title}</p>
                    {finding.file ? (
                      <code className="mono text-ink-faint">
                        {finding.file}
                        {finding.line ? `:${finding.line}` : ''}
                      </code>
                    ) : null}
                    {finding.detail ? (
                      <p className="mt-1 text-[12px] text-ink-muted">{finding.detail}</p>
                    ) : null}
                    {finding.suggestion ? (
                      <p className="mt-1 text-[12px] text-ink-faint">
                        <span className="font-medium">Suggestion:</span> {finding.suggestion}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <PolicyPanel policies={policies} />
    </div>
  );
}

function TestsTab({
  snapshot,
  latestAttempt,
}: {
  snapshot: RunSnapshot;
  latestAttempt: number;
}) {
  const results = snapshot.run.validations
    .filter((v) => v.attempt === latestAttempt && v.outcome !== 'not_configured')
    .slice()
    .sort((a, b) => a.kind.localeCompare(b.kind));

  if (results.length === 0) {
    return (
      <p className="empty-state">
        No validation has run yet. Configure commands on the project to have them run
        automatically.
      </p>
    );
  }

  return (
    <div className="space-y-3.5 p-3.5">
      {results.map((result) => {
        const output = [result.stdout, result.stderr].filter((s) => s && s.trim()).join('\n');
        const failed = result.outcome === 'fail' || result.outcome === 'error';
        return (
          <div key={result.id} className="panel">
            <div className="panel-head">
              <div className="flex items-center gap-2">
                <h3 className="panel-title">{result.kind}</h3>
                <span
                  className={`badge ${
                    result.outcome === 'pass'
                      ? 'badge-pass'
                      : failed
                        ? 'badge-fail'
                        : result.outcome === 'running'
                          ? 'badge-running'
                          : 'badge-idle'
                  }`}
                >
                  {result.outcome}
                </span>
                {!result.blocking ? <span className="badge badge-idle">advisory</span> : null}
              </div>
              <span className="text-[11px] text-ink-faint">
                {result.exitCode !== null ? `exit ${result.exitCode} · ` : ''}
                {formatDuration(result.durationMs)}
              </span>
            </div>

            <div className="px-3.5 py-2">
              <code className="mono block break-all text-ink-muted">
                {result.command ?? '(no command)'}
              </code>
              {result.error ? (
                <p className="mt-1.5 text-[12px] text-fail">{result.error}</p>
              ) : null}
            </div>

            {output ? (
              <details open={failed} className="border-t border-line">
                <summary className="cursor-pointer px-3.5 py-1.5 text-[11.5px] text-ink-muted hover:text-ink">
                  Output
                </summary>
                <pre className="log max-h-96 overflow-auto px-3.5 pb-2.5">{output}</pre>
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Logs, in two forms.
 *
 * The stream is the live one and the default: it is written from the event log
 * as the run happens, so it is populated while an agent is still working. The
 * saved files are what the agent process left behind — the raw NDJSON
 * transcript and any setup output — and only exist once the step that produces
 * them has finished, which is why they cannot be the live view.
 */
function LogsTab({
  events,
  artifacts,
  connected,
  active,
}: {
  events: readonly RunEvent[];
  artifacts: RunSnapshot['artifacts'];
  connected: boolean;
  active: boolean;
}) {
  const [mode, setMode] = useState<'stream' | 'files'>('stream');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5">
        <button
          type="button"
          className={`btn btn-sm ${mode === 'stream' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setMode('stream')}
        >
          Live stream
        </button>
        <button
          type="button"
          className={`btn btn-sm ${mode === 'files' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setMode('files')}
        >
          Saved files
          {artifacts.length > 0 ? (
            <span className="text-[10.5px] opacity-70">{artifacts.length}</span>
          ) : null}
        </button>
      </div>

      {mode === 'stream' ? (
        <LogStream events={events} connected={connected} active={active} />
      ) : artifacts.length === 0 ? (
        <p className="empty-state">
          No log files have been written yet. They are saved when the step that produces them
          finishes; the live stream shows what is happening in the meantime.
        </p>
      ) : (
        <ArtifactPanel artifacts={artifacts} />
      )}
    </div>
  );
}

/**
 * The implementation map, at the size it was drawn for.
 *
 * The latest pass is shown; earlier ones stay in the Artifacts tab rather than
 * being replaced, because the map taken before a change request is the record
 * of what that request was answering.
 */
function MapTab({ artifacts }: { artifacts: RunSnapshot['artifacts'] }) {
  const latest = artifacts.at(-1) ?? null;

  if (!latest) {
    return (
      <p className="empty-state">
        No implementation map yet. One is drawn at the end of every pass, whatever the outcome.
      </p>
    );
  }

  if (!latest.exists) {
    return <p className="empty-state">The file recorded for this map is no longer on disk.</p>;
  }

  const description =
    typeof latest.meta.description === 'string' ? latest.meta.description : latest.label;

  return (
    <div className="space-y-2.5 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-ink-faint">
          Computed from stored run state — file changes and check outcomes, not the
          implementer&rsquo;s summary.
        </p>
        <a
          className="btn btn-sm shrink-0"
          href={`/api/artifacts/${latest.id}/raw?download=1`}
          download
        >
          Download SVG
        </a>
      </div>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/artifacts/${latest.id}/raw`}
        alt={description}
        className="w-full rounded border border-line"
      />

      {artifacts.length > 1 ? (
        <p className="text-[11px] text-ink-faint">
          Pass {artifacts.length}. The earlier {artifacts.length === 2 ? 'map is' : 'maps are'} in
          the Artifacts tab.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Loads a diff artifact on demand.
 *
 * The result is stored together with the id it came from, so a new diff
 * artifact (a change request produces one) never briefly renders under the
 * wrong identity, and no state is written synchronously inside the effect.
 */
function LazyDiff({ artifactId }: { artifactId: string }) {
  const [result, setResult] = useState<{
    artifactId: string;
    patch: string | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/artifacts/${artifactId}/content`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((body: { content: { text: string | null } | null; message: string | null }) => {
        if (cancelled) return;
        setResult({
          artifactId,
          patch: body.content?.text ?? null,
          error: body.content?.text ? null : (body.message ?? 'The diff artifact is empty.'),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult({
          artifactId,
          patch: null,
          error: err instanceof Error ? err.message : 'Could not load the diff.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  const current = result?.artifactId === artifactId ? result : null;
  if (current === null) return <p className="empty-state">Loading diff…</p>;
  if (current.error) return <p className="empty-state">{current.error}</p>;
  return <DiffView patch={current.patch ?? ''} />;
}

function PolicyPanel({ policies }: { policies: RunSnapshot['policies'] }) {
  const rows: { label: string; on: boolean }[] = [
    { label: 'Validation required', on: policies.requireValidation },
    { label: 'E2E required for UI changes', on: policies.requireE2eForUiChanges },
    { label: 'Review findings block readiness', on: policies.reviewBlocksReady },
    { label: 'Agent may create commits', on: policies.allowAgentCommit },
  ];

  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Project policy</h2>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-center justify-between px-3.5 py-1.5 text-[12px]"
          >
            <span className="text-ink-muted">{row.label}</span>
            <span className={row.on ? 'text-accent' : 'text-ink-faint'}>
              {row.on ? 'on' : 'off'}
            </span>
          </li>
        ))}
        <li className="px-3.5 py-1.5 text-[12px]">
          <span className="text-ink-muted">Protected branches</span>
          <code className="mono mt-0.5 block text-ink-faint">
            {policies.protectedBranches.join(', ') || 'none'}
          </code>
        </li>
      </ul>
    </div>
  );
}

/** Live-ticking elapsed time while a run is active; frozen once it finishes. */
function useElapsed(
  startedAt: string | null,
  finishedAt: string | null,
  active: boolean,
): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);

  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = active ? now : finishedAt ? new Date(finishedAt).getTime() : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return '—';
  return formatDuration(Math.max(0, end - start));
}

export { formatRelative };
