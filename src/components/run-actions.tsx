'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { RunStatus } from '@/domain/types';
import type { RunSnapshot } from './use-run-stream';

/**
 * The action bar.
 *
 * Which actions are offered comes from stored run state, not from what the
 * agent said. Approve is available whenever the user is entitled to make that
 * call, and the readiness assessment is shown next to it rather than used to
 * hide the button — the user is the approver, so an override is theirs to make,
 * but never by accident.
 */

interface ActionsProps {
  snapshot: RunSnapshot;
  onChanged: () => void;
}

type Dialog = 'none' | 'changes' | 'approve' | 'reject' | 'land';

const APPROVABLE_STATUSES: readonly RunStatus[] = [
  'NEEDS_CHANGES',
  'READY',
  'FAILED',
  'CANCELLED',
];
const LANDABLE_STATUSES: readonly RunStatus[] = [
  'APPROVED',
  'MERGE_CONFLICT',
  'LANDING_FAILED',
];
const REWORKABLE_STATUSES: readonly RunStatus[] = [
  'NEEDS_CHANGES',
  'READY',
  'FAILED',
  'CANCELLED',
];
const REVALIDATABLE_STATUSES: readonly RunStatus[] = [
  'NEEDS_CHANGES',
  'READY',
  'FAILED',
  'CANCELLED',
  'APPROVED',
  'LANDING_FAILED',
];
const LANDING_WORKTREE_STATUSES: readonly RunStatus[] = [
  'MERGE_CONFLICT',
  'LANDING_FAILED',
  'LANDED',
];

export function RunActions({ snapshot, onChanged }: ActionsProps) {
  const router = useRouter();
  const { run, readiness, live } = snapshot;

  const [dialog, setDialog] = useState<Dialog>('none');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [feedback, setFeedback] = useState('');
  const [note, setNote] = useState('');
  const [createCommit, setCreateCommit] = useState(true);
  const [commitMessage, setCommitMessage] = useState('');
  const [cleanUp, setCleanUp] = useState(false);

  const active = live.active;
  const targetBranch = run.baseBranch ?? 'the target branch';

  const post = async (path: string, body?: unknown, label?: string) => {
    setBusy(label ?? path);
    setError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? `Request failed (${response.status})`);
        return false;
      }
      setDialog('none');
      onChanged();
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const canRequestChanges =
    !active && REWORKABLE_STATUSES.includes(run.status) && run.worktreePath !== null;
  const canRevalidate =
    !active && REVALIDATABLE_STATUSES.includes(run.status) && run.worktreePath !== null;
  const canApprove = !active && APPROVABLE_STATUSES.includes(run.status);
  const canLand =
    !active &&
    (LANDABLE_STATUSES.includes(run.status) ||
      (run.status === 'CANCELLED' && run.disposition === 'approved'));
  const canResolveMerge = !active && run.status === 'MERGE_CONFLICT';
  const canOpenLanding = !active && LANDING_WORKTREE_STATUSES.includes(run.status);
  const canStart = !active && run.status === 'DRAFT';

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {canStart ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => void post(`/api/runs/${run.id}/start`, {}, 'start')}
          >
            Start implementation
          </button>
        ) : null}

        {active ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy !== null}
            onClick={() => void post(`/api/runs/${run.id}/cancel`, {}, 'cancel')}
          >
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel implementation'}
          </button>
        ) : null}

        {canRequestChanges ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => setDialog(dialog === 'changes' ? 'none' : 'changes')}
          >
            Request changes
          </button>
        ) : null}

        {canRevalidate ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void post(`/api/runs/${run.id}/revalidate`, {}, 'revalidate')}
          >
            {busy === 'revalidate' ? 'Starting…' : 'Re-run validation'}
          </button>
        ) : null}

        {run.worktreePath ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void post(`/api/runs/${run.id}/open`, { target: 'worktree' }, 'open')}
          >
            Open worktree
          </button>
        ) : null}

        {canOpenLanding ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void post(`/api/runs/${run.id}/open`, { target: 'landing' }, 'open')}
          >
            Open landing worktree
          </button>
        ) : null}

        {canResolveMerge ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void post(`/api/runs/${run.id}/resolve-merge`, {}, 'resolve-merge')}
          >
            {busy === 'resolve-merge' ? 'Starting…' : 'Resolve conflicts with AI'}
          </button>
        ) : null}

        <div className="flex-1" />

        {canLand ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => setDialog(dialog === 'land' ? 'none' : 'land')}
          >
            Land on {targetBranch}
          </button>
        ) : null}

        {canApprove ? (
          <>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy !== null}
              onClick={() => setDialog(dialog === 'reject' ? 'none' : 'reject')}
            >
              Reject
            </button>
            <button
              type="button"
              className="btn btn-approve"
              disabled={busy !== null}
              onClick={() => setDialog(dialog === 'approve' ? 'none' : 'approve')}
            >
              Approve
            </button>
          </>
        ) : null}
      </div>

      {error ? (
        <p className="rounded border border-fail/40 bg-fail-soft px-2.5 py-1.5 text-[12px] text-fail">
          {error}
        </p>
      ) : null}

      {dialog === 'changes' ? (
        <div className="panel p-3">
          <label className="label" htmlFor="feedback">
            What should change?
          </label>
          <textarea
            id="feedback"
            className="textarea"
            rows={4}
            value={feedback}
            placeholder="The endpoint returns 500 when the id is missing. It should return 400 with a message."
            onChange={(e) => setFeedback(e.target.value)}
          />
          <p className="hint">
            {run.agentSessionId
              ? `Continues Claude Code session ${run.agentSessionId.slice(0, 8)}, so the implementation context is kept. Validation runs again afterwards.`
              : 'No agent session is recorded for this run, so the implementer starts fresh.'}
          </p>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog('none')}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={feedback.trim().length === 0 || busy !== null}
              onClick={() => void post(`/api/runs/${run.id}/changes`, { feedback }, 'changes')}
            >
              {busy === 'changes' ? 'Sending…' : 'Send to implementer'}
            </button>
          </div>
        </div>
      ) : null}

      {dialog === 'approve' ? (
        <div className="panel p-3">
          {readiness.ready ? (
            <p className="mb-2.5 text-[12.5px] text-pass">
              All configured checks passed and {run.changedFiles.length} file
              {run.changedFiles.length === 1 ? '' : 's'} changed.
            </p>
          ) : (
            <div className="mb-2.5 rounded border border-warn/40 bg-warn-soft px-2.5 py-2">
              <p className="text-[12.5px] font-medium text-warn">
                This run is not marked ready. Approving anyway overrides:
              </p>
              <ul className="mt-1 list-disc pl-4 text-[12px] text-warn">
                {readiness.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          <label className="label" htmlFor="approve-note">
            Note (optional)
          </label>
          <input
            id="approve-note"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Looks right, shipping behind the existing flag."
          />

          <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              className="mt-0.5 accent-accent"
              checked={createCommit}
              onChange={(e) => setCreateCommit(e.target.checked)}
            />
            <span>
              Create a local commit on <code className="mono">{run.branch}</code>
              <span className="block text-[11.5px] text-ink-faint">
                Required for landing. Approval still does not merge or push by itself.
              </span>
            </span>
          </label>

          {createCommit ? (
            <input
              className="input mt-2"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder={run.title}
            />
          ) : null}

          <div className="mt-2.5 flex justify-end gap-1.5">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog('none')}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-approve"
              disabled={busy !== null}
              onClick={() =>
                void post(
                  `/api/runs/${run.id}/approve`,
                  {
                    note: note || undefined,
                    createCommit,
                    commitMessage: commitMessage || undefined,
                  },
                  'approve',
                )
              }
            >
              {busy === 'approve' ? 'Approving…' : readiness.ready ? 'Approve' : 'Approve anyway'}
            </button>
          </div>
        </div>
      ) : null}

      {dialog === 'land' ? (
        <div className="panel p-3">
          <p className="text-[12.5px] text-ink-muted">
            Dev Cockpit will create or reuse an isolated landing worktree from{' '}
            <code className="mono">{targetBranch}</code>, merge{' '}
            <code className="mono">{run.branch}</code>, run validation there, then fast-forward{' '}
            <code className="mono">{targetBranch}</code> only if the result is clean.
          </p>
          {run.status === 'MERGE_CONFLICT' ? (
            <p className="mt-2 text-[12px] text-warn">
              Conflicts are recorded for this landing. If you already resolved them in the landing
              worktree, retrying will finish the merge and validate it.
            </p>
          ) : null}
          {run.status === 'LANDING_FAILED' ? (
            <p className="mt-2 text-[12px] text-warn">
              The previous landing attempt failed. Retry after fixing the recorded problem in the
              landing worktree or target checkout.
            </p>
          ) : null}

          <div className="mt-2.5 flex justify-end gap-1.5">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog('none')}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => void post(`/api/runs/${run.id}/land`, {}, 'land')}
            >
              {busy === 'land' ? 'Starting…' : `Land on ${targetBranch}`}
            </button>
          </div>
        </div>
      ) : null}

      {dialog === 'reject' ? (
        <div className="panel p-3">
          <label className="label" htmlFor="reject-note">
            Why?
          </label>
          <input
            id="reject-note"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Wrong approach — this belongs in the service layer."
          />

          <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              className="mt-0.5 accent-accent"
              checked={cleanUp}
              onChange={(e) => setCleanUp(e.target.checked)}
            />
            <span>
              Remove the worktree and delete the branch
              <span className="block text-[11.5px] text-ink-faint">
                The branch is only deleted when it holds no commits. Artifacts and the event
                log are kept either way.
              </span>
            </span>
          </label>

          <div className="mt-2.5 flex justify-end gap-1.5">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog('none')}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy !== null}
              onClick={() =>
                void post(
                  `/api/runs/${run.id}/reject`,
                  { note: note || undefined, cleanUp },
                  'reject',
                )
              }
            >
              {busy === 'reject' ? 'Rejecting…' : 'Reject run'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ReadinessNotice({
  readiness,
  status,
}: {
  readiness: RunSnapshot['readiness'];
  status: RunStatus;
}) {
  if (status === 'APPROVED' || status === 'LANDED' || status === 'REJECTED') return null;
  if (readiness.ready) {
    return (
      <p className="text-[12.5px] text-pass">
        Ready — {readiness.validationsPassed} check
        {readiness.validationsPassed === 1 ? '' : 's'} passed, nothing blocking.
      </p>
    );
  }
  if (readiness.reasons.length === 0) return null;

  return (
    <div className="text-[12.5px] text-ink-muted">
      <span className="font-medium text-warn">Blocking readiness:</span>{' '}
      {readiness.reasons.join('; ')}
    </div>
  );
}
