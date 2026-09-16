'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { effectiveWorkMode } from '@/domain/modes';
import { selectRunOutputs, type RunOutput } from '@/domain/outputs';
import {
  parsePreviewTargets,
  rankPreviewTargets,
  type PreviewTarget,
} from '@/domain/preview-targets';
import { joinPreviewPath } from '@/domain/previews';
import { Markdown } from './markdown';
import type { RunSnapshot } from './use-run-stream';

/**
 * The Preview tab: the run's output, rendered.
 *
 * One output is shown at a time. `domain/outputs` picks it and says why, and
 * the alternatives sit in that same sentence as links — a second row of tabs
 * above an iframe would be chrome for a case that should be rare, and when it
 * stops being rare the fix is the ranking rather than more switches.
 */
export function OutputView({
  snapshot,
  onChanged,
}: {
  snapshot: RunSnapshot;
  onChanged: () => void;
}) {
  const { run, artifacts, preview, live, policies } = snapshot;

  const selection = useMemo(
    () =>
      selectRunOutputs({
        mode: effectiveWorkMode(run),
        status: run.status,
        active: live.active,
        request: run.request,
        changedFiles: run.changedFiles.map((file) => ({
          path: file.path,
          changeType: file.changeType,
        })),
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          label: artifact.label,
          mimeType: artifact.mimeType,
          createdAt: artifact.createdAt,
          exists: artifact.exists,
          expiredAt: artifact.expiredAt,
        })),
        preview: { configured: preview.configured, running: preview.running },
        hasWorktree: run.worktreePath !== null,
        uiPathPatterns: policies.uiPathPatterns,
        projectId: run.projectId,
      }),
    [run, artifacts, preview.configured, preview.running, live.active, policies.uiPathPatterns],
  );

  // Derived, never effect-synced: the snapshot refetches while a run is active,
  // and a selection kept in sync by an effect would jump under the user.
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const available = selection.shown ? [selection.shown, ...selection.alternatives] : [];
  const current = available.find((output) => output.id === requestedId) ?? selection.shown;

  if (!current) {
    return (
      <p className="empty-state">
        {selection.emptyReason}
        {selection.emptyReasonHref ? (
          <>
            {' '}
            <Link
              href={selection.emptyReasonHref}
              className="underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              Set one up
            </Link>
            .
          </>
        ) : null}
      </p>
    );
  }

  const others = available.filter((output) => output.id !== current.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="shrink-0 border-b border-line px-3.5 py-2 text-[11.5px] text-ink-faint">
        Showing the <span className="font-medium text-ink">{current.label}</span> — {current.reason}
        {current.settingsHref ? (
          <>
            {' '}
            <Link
              href={current.settingsHref}
              className="underline decoration-dotted underline-offset-2 hover:text-ink"
            >
              Set up a preview
            </Link>
            .
          </>
        ) : null}
        {selection.olderPasses > 0 && current.id === selection.shown?.id ? (
          <>
            {' '}
            {selection.olderPasses === 1 ? 'An earlier pass is' : `${selection.olderPasses} earlier passes are`}{' '}
            in the Artifacts tab.
          </>
        ) : null}
        {others.length > 0 ? (
          <>
            {' '}
            Or:{' '}
            {others.map((output, index) => (
              <span key={output.id}>
                {index > 0 ? ' · ' : ''}
                <button
                  type="button"
                  className="underline decoration-dotted underline-offset-2 hover:text-ink"
                  onClick={() => setRequestedId(output.id)}
                >
                  the {output.label}
                </button>
              </span>
            ))}
          </>
        ) : null}
      </p>

      <div className="min-h-0 flex-1 overflow-auto">
        <OutputBody output={current} snapshot={snapshot} onChanged={onChanged} />
      </div>
    </div>
  );
}

function OutputBody({
  output,
  snapshot,
  onChanged,
}: {
  output: RunOutput;
  snapshot: RunSnapshot;
  onChanged: () => void;
}) {
  // Bound once: narrowing a nested discriminant does not survive the closure
  // the artifact lookup needs.
  const source = output.source;
  if (source.source === 'devServer') {
    return <SiteOutput snapshot={snapshot} onChanged={onChanged} />;
  }
  if (output.kind === 'page') {
    const artifact = snapshot.artifacts.find((candidate) => candidate.id === source.artifactId);
    return (
      <PageOutput
        artifactId={source.artifactId}
        selfContained={artifact?.meta.selfContained !== false}
      />
    );
  }
  return <DocumentOutput artifactId={source.artifactId} />;
}

/* ------------------------------------------------------------------ *
 * A document
 * ------------------------------------------------------------------ */

/**
 * Loads a markdown artifact on demand.
 *
 * The body is stored together with the id it came from, so switching outputs
 * while a run is live never renders the previous artifact under the new name —
 * the same guard the diff loader uses.
 */
function DocumentOutput({ artifactId }: { artifactId: string }) {
  const [state, setState] = useState<{
    artifactId: string;
    text: string | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/artifacts/${artifactId}/content`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((body: { content: { text: string | null } | null; message: string | null }) => {
        if (cancelled) return;
        setState({
          artifactId,
          text: body.content?.text ?? null,
          error: body.content?.text ? null : (body.message ?? 'This output is empty.'),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          artifactId,
          text: null,
          error: err instanceof Error ? err.message : 'Could not load this output.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  const current = state?.artifactId === artifactId ? state : null;
  if (current === null) return <p className="empty-state">Loading…</p>;
  if (current.error) return <p className="empty-state">{current.error}</p>;

  return (
    <div>
      <Markdown className="px-3.5 py-2.5">{current.text ?? ''}</Markdown>
      <p className="border-t border-line px-3.5 py-1.5 text-[11px] text-ink-faint">
        The stored deliverable, as written.{' '}
        <a className="underline decoration-dotted underline-offset-2 hover:text-ink" href={`/api/artifacts/${artifactId}/raw?download=1`} download>
          Download
        </a>
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A standalone page the agent wrote
 * ------------------------------------------------------------------ */

/**
 * An agent-authored page, in an opaque origin.
 *
 * `allow-scripts` without `allow-same-origin` is the whole of the protection:
 * a chart library still runs, but the document cannot reach this application's
 * API, which spawns coding agents and runs shell commands. The response also
 * carries `Content-Security-Policy: sandbox allow-scripts` for anyone who opens
 * the raw URL directly, where this attribute would not apply.
 *
 * Never add `allow-same-origin` beside `allow-scripts`. Together they are
 * equivalent to no sandbox at all, because the frame can then reach up and
 * remove its own sandbox attribute.
 */
function PageOutput({
  artifactId,
  selfContained,
}: {
  artifactId: string;
  selfContained: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-3.5 py-2">
        <p className="text-[11px] text-ink-faint">
          {selfContained
            ? 'Rendered in a sandbox: this page can draw and calculate, but cannot reach Dev Cockpit.'
            : 'This page refers to files beside it in the worktree, which the preview cannot serve — it will render without them.'}
        </p>
        <a
          className="btn btn-sm shrink-0"
          href={`/api/artifacts/${artifactId}/raw`}
          target="_blank"
          rel="noreferrer"
        >
          Open
        </a>
      </div>
      <iframe
        src={`/api/artifacts/${artifactId}/raw`}
        title="Run output"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="min-h-[520px] flex-1 border-0 bg-white"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The running site
 * ------------------------------------------------------------------ */

function SiteOutput({
  snapshot,
  onChanged,
}: {
  snapshot: RunSnapshot;
  onChanged: () => void;
}) {
  const { run, preview, live, policies } = snapshot;

  // Paths the running server did not answer. Marked in the suggestion list
  // rather than dropped: a 404 on a page the implementer named usually means
  // the route takes a parameter or sits behind a login, which is worth seeing.
  // Stamped with the generation it was measured against, so a restarted server
  // does not inherit the last one's verdicts.
  const [probed, setProbed] = useState<{ generation: number; unreachable: string[] } | null>(null);
  // Memoised because it feeds a dependency array: a fresh [] each render would
  // re-rank the targets every time.
  const unreachable = useMemo(
    () => (probed?.generation === preview.generation ? probed.unreachable : []),
    [probed, preview.generation],
  );

  const declaredPaths = useMemo(
    () => parsePreviewTargets(lastCompletedText(run)).map((target) => target.path),
    [run],
  );

  const targets = useMemo(
    () =>
      rankPreviewTargets({
        finalText: lastCompletedText(run),
        readyPath: policies.previewReadyPath,
        unreachable,
      }),
    [run, policies.previewReadyPath, unreachable],
  );

  const suggested = targets[0]?.path ?? '/';

  // Derived rather than synchronised. What the user typed is stamped with the
  // preview generation it was typed against, so a restarted server falls back
  // to what the implementer named without an effect writing state — the same
  // reason the output selection above is derived.
  const [typed, setTyped] = useState<{ generation: number; path: string; draft: string } | null>(
    null,
  );
  const current = typed?.generation === preview.generation ? typed : null;
  const path = current?.path ?? suggested;
  const draft = current?.draft ?? suggested;

  const setDraft = (value: string) =>
    setTyped({ generation: preview.generation, path, draft: value });
  const setPath = (value: string) =>
    setTyped({ generation: preview.generation, path: value, draft: value });
  // Bumped by Reload. Reloading the frame is not restarting the server, so the
  // two are separate actions with separate buttons.
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generation = preview.generation;

  // Once, when the server says it is up. A named path that does not resolve is
  // worth knowing before navigating to it.
  const ready = preview.status === 'ready';
  useEffect(() => {
    if (!ready || declaredPaths.length === 0) return;
    let cancelled = false;

    fetch(`/api/runs/${run.id}/preview/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: declaredPaths }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { unreachable?: string[] } | null) => {
        if (cancelled || !body?.unreachable) return;
        setProbed({ generation, unreachable: body.unreachable });
      })
      .catch(() => {
        // A failed probe only costs the marking; the paths are still offered.
      });

    return () => {
      cancelled = true;
    };
  }, [ready, generation, run.id, declaredPaths]);

  const post = useCallback(
    async (endpoint: string, label: string) => {
      setBusy(label);
      setError(null);
      try {
        const response = await fetch(`/api/runs/${run.id}/preview/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(payload?.error ?? `Request failed (${response.status})`);
          return;
        }
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Request failed');
      } finally {
        setBusy(null);
      }
    },
    [run.id, onChanged],
  );

  if (!preview.configured) {
    return <p className="empty-state">No development command is configured for this project.</p>;
  }
  if (!run.worktreePath) {
    return <p className="empty-state">A preview needs a worktree, and this run no longer has one.</p>;
  }

  const canStart = !live.active && !preview.running;
  const url = preview.url ? joinPreviewPath(preview.url, path) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
        <span
          className={`badge ${
            preview.status === 'ready'
              ? 'badge-pass'
              : preview.status === 'failed'
                ? 'badge-fail'
                : preview.status === 'unresponsive'
                  ? 'badge-warn'
                  : preview.running
                    ? 'badge-running'
                    : 'badge-idle'
          }`}
        >
          {preview.status.replace('_', ' ')}
        </span>

        <form
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            setPath(draft.trim() || '/');
          }}
        >
          <input
            className="input input-mono min-w-0 flex-1"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            list="preview-target-paths"
            aria-label="Preview path"
            spellCheck={false}
          />
          <datalist id="preview-target-paths">
            {targets.map((target) => (
              <option key={target.path} value={target.path} label={describeTarget(target)} />
            ))}
          </datalist>
          <button type="submit" className="btn btn-sm shrink-0">
            Go
          </button>
        </form>

        {canStart ? (
          <button
            type="button"
            className="btn btn-sm btn-primary shrink-0"
            disabled={busy !== null}
            onClick={() => void post('start', 'start')}
          >
            {busy === 'start' ? 'Starting…' : 'Start preview'}
          </button>
        ) : null}

        {preview.running ? (
          <button
            type="button"
            className="btn btn-sm shrink-0"
            // Reloads the frame only. Restarting the server itself is an action
            // bar button, beside start and stop.
            onClick={() => setNonce((n) => n + 1)}
          >
            Reload
          </button>
        ) : null}

        {url ? (
          <a className="btn btn-sm shrink-0" href={url} target="_blank" rel="noreferrer">
            Open
          </a>
        ) : null}
      </div>

      {targets[0]?.origin === 'declared' && targets[0].note ? (
        <p className="shrink-0 border-b border-line px-3.5 py-1.5 text-[11px] text-ink-faint">
          The implementer pointed at <code className="mono">{targets[0].path}</code> — {targets[0].note}
        </p>
      ) : null}

      {error ? (
        <p className="shrink-0 border-b border-fail/30 bg-fail-soft px-3.5 py-1.5 text-[12px] text-fail">
          {error}
        </p>
      ) : null}
      {preview.error ? (
        <p className="shrink-0 border-b border-line px-3.5 py-1.5 text-[12px] text-fail">
          {preview.error}
        </p>
      ) : null}

      {url && preview.running ? (
        <iframe
          // The generation alone is not enough: it lives in a module-global map
          // that resets when the process does, so the same number can sit in
          // front of a different server. The start time pins it, and the path
          // remounts the frame rather than relying on its own history.
          key={`${preview.generation}:${preview.startedAt ?? ''}:${path}:${nonce}`}
          src={url}
          title="Run preview"
          className="min-h-[520px] flex-1 border-0 bg-white"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <p className="empty-state">
            {preview.status === 'failed'
              ? 'The development server failed to start. Its output is below.'
              : preview.status === 'stopped'
                ? 'The development server has stopped. Its last output is below.'
                : 'Start the development server to see the site.'}
          </p>
          <PreviewLog preview={preview} />
        </div>
      )}
    </div>
  );
}

/**
 * The tail of the server's output, which the preview service already keeps.
 *
 * It lives in memory beside the process, so it survives a stop but not a
 * restart of Dev Cockpit itself; after that the captured log artifact is the
 * fallback.
 */
function PreviewLog({ preview }: { preview: RunSnapshot['preview'] }) {
  if (preview.logTail) {
    return (
      <details className="mx-3.5 mb-3.5" open={preview.status === 'failed'}>
        <summary className="cursor-pointer py-1.5 text-[11.5px] text-ink-muted hover:text-ink">
          Server output
        </summary>
        <pre className="log max-h-96 overflow-auto">{preview.logTail}</pre>
      </details>
    );
  }

  if (preview.logArtifactId) {
    return (
      <p className="px-3.5 pb-3.5 text-[11.5px] text-ink-faint">
        The captured{' '}
        <a
          className="underline decoration-dotted underline-offset-2 hover:text-ink"
          href={`/api/artifacts/${preview.logArtifactId}/raw`}
          target="_blank"
          rel="noreferrer"
        >
          preview server log
        </a>{' '}
        is in the Artifacts tab.
      </p>
    );
  }

  return null;
}

/* ------------------------------------------------------------------ */

/** The closing message of the newest iteration that actually finished. */
function lastCompletedText(run: RunSnapshot['run']): string | null {
  for (let i = run.iterations.length - 1; i >= 0; i -= 1) {
    const iteration = run.iterations[i];
    if (iteration?.status === 'completed' && iteration.finalText) return iteration.finalText;
  }
  return null;
}

function describeTarget(target: PreviewTarget): string {
  const suffix = target.reachable === false ? ' (did not answer)' : '';
  return `${target.note ?? (target.origin === 'configured' ? 'the ready path' : '')}${suffix}`.trim();
}
