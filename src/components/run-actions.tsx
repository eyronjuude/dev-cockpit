'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  effectiveWorkMode,
  isReadOnlyMode,
  WORK_MODE_WORDING,
  type ResolvedWorkMode,
} from '@/domain/modes';
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
 *
 * The working mode changes the set: a read-only run has nothing to
 * re-validate, and gains the one action that makes Ask and Plan worth doing
 * separately — handing what they produced back to the same session to build.
 */

interface ActionsProps {
  snapshot: RunSnapshot;
  onChanged: () => void;
}

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

/**
 * The instruction sent when a read-only run is switched to Build.
 *
 * A plan is a complete brief on its own, so the note is an adjustment to it. An
 * answer is not, so the note carries the actual instruction and the fallback
 * has to be vague rather than pretend otherwise.
 */
function buildFeedbackFor(mode: ResolvedWorkMode, note: string): string {
  const trimmed = note.trim();
  if (mode === 'plan') {
    return trimmed
      ? `Implement the plan you wrote, with this adjustment:\n\n${trimmed}`
      : 'Implement the plan you wrote, in full.';
  }
  return trimmed
    ? `Implement this, following the answer you just gave:\n\n${trimmed}`
    : 'Implement what your answer describes. If the answer did not describe a change, say what you would need to know instead of guessing.';
}

type Dialog = 'none' | 'changes' | 'approve' | 'reject' | 'land' | 'implement';

export function RunActions({ snapshot, onChanged }: ActionsProps) {
  const router = useRouter();
  const { run, readiness, live } = snapshot;

  const [dialog, setDialog] = useState<Dialog>('none');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [feedback, setFeedback] = useState('');
  const [implementNote, setImplementNote] = useState('');
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

  const mode = effectiveWorkMode(run);
  const readOnly = isReadOnlyMode(mode);
  const wording = WORK_MODE_WORDING[mode];
  const canRequestChanges =
    !active && REWORKABLE_STATUSES.includes(run.status) && run.worktreePath !== null;
  // A read-only run has no diff, so there is nothing for the checks to run
  // against.
  const canRevalidate =
    !active &&
    REVALIDATABLE_STATUSES.includes(run.status) &&
    run.worktreePath !== null &&
    !readOnly;
  const canApprove = !active && APPROVABLE_STATUSES.includes(run.status);
  // Approving a read-only run creates no commit, so its branch holds nothing to
  // merge. Landing it would report success for a no-op.
  const canLand =
    !active &&
    !readOnly &&
    (LANDABLE_STATUSES.includes(run.status) ||
      (run.status === 'CANCELLED' && run.disposition === 'approved'));
  const canResolveMerge = !active && run.status === 'MERGE_CONFLICT';
  const canOpenLanding = !active && LANDING_WORKTREE_STATUSES.includes(run.status);
  const canStart = !active && run.status === 'DRAFT';
  // Only once there is something finished to build on. An iteration that
  // failed part-way can still hold text, and switching to Build on half a plan
  // is a build run started the long way round.
  const canSwitchToBuild =
    readOnly &&
    !active &&
    REWORKABLE_STATUSES.includes(run.status) &&
    run.worktreePath !== null &&
    run.iterations.some(
      (i) => i.status === 'completed' && i.finalText !== null && i.finalText.trim().length > 0,
    );

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
            {mode === 'ask' ? 'Ask' : mode === 'plan' ? 'Start planning' : 'Start implementation'}
          </button>
        ) : null}

        {active ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy !== null}
            onClick={() => void post(`/api/runs/${run.id}/cancel`, {}, 'cancel')}
          >
            {busy === 'cancel' ? 'Cancelling…' : `Cancel ${wording.activity}`}
          </button>
        ) : null}

        {canSwitchToBuild ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => setDialog(dialog === 'implement' ? 'none' : 'implement')}
          >
            {mode === 'plan' ? 'Implement this plan' : 'Switch to Build'}
          </button>
        ) : null}

        {canRequestChanges ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => setDialog(dialog === 'changes' ? 'none' : 'changes')}
          >
            {mode === 'ask'
              ? 'Ask a follow-up'
              : mode === 'plan'
                ? 'Revise the plan'
                : 'Request changes'}
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

      {dialog === 'implement' ? (
        <div className="panel p-3">
          <p className="mb-2.5 text-[12.5px] text-ink-muted">
            Switches this run to <span className="font-medium">Build</span> mode and hands the{' '}
            {wording.deliverable} back to the session that produced it. The project&rsquo;s checks
            run afterwards, and the diff appears on this screen as it would for any build run.
          </p>
          <label className="label" htmlFor="implement-note">
            {mode === 'plan'
              ? 'Anything to change about the plan first? (optional)'
              : 'What should it build? (optional, but useful)'}
          </label>
          <textarea
            id="implement-note"
            className="textarea"
            rows={3}
            value={implementNote}
            placeholder={
              mode === 'plan'
                ? 'Skip step 4 for now — the migration can wait until the endpoint is in.'
                : 'Do the second option you described, and leave the cache alone.'
            }
            onChange={(e) => setImplementNote(e.target.value)}
          />
          <p className="hint">
            {run.agentSessionId
              ? `Continues Claude Code session ${run.agentSessionId.slice(0, 8)}, so the reading behind the ${wording.deliverable} is not thrown away.`
              : `No agent session is recorded for this run, so the implementer starts fresh with the ${wording.deliverable} text in its prompt.`}
          </p>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog('none')}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() =>
                void post(
                  `/api/runs/${run.id}/changes`,
                  {
                    mode: 'build',
                    feedback: buildFeedbackFor(mode, implementNote),
                  },
                  'implement',
                )
              }
            >
              {busy === 'implement' ? 'Sending…' : 'Switch to Build and implement'}
            </button>
          </div>
        </div>
      ) : null}

      {dialog === 'changes' ? (
        <div className="panel p-3">
          <label className="label" htmlFor="feedback">
            {mode === 'ask'
              ? 'What else do you want to know?'
              : mode === 'plan'
                ? 'What should the plan do differently?'
                : 'What should change?'}
          </label>
          <textarea
            id="feedback"
            className="textarea"
            rows={4}
            value={feedback}
            placeholder={
              mode === 'ask'
                ? 'And where does that session get invalidated on logout?'
                : mode === 'plan'
                  ? 'Step 2 assumes the cache is in-process. It is Redis — replan from there.'
                  : 'The endpoint returns 500 when the id is missing. It should return 400 with a message.'
            }
            onChange={(e) => setFeedback(e.target.value)}
          />
          <p className="hint">
            {run.agentSessionId
              ? `Continues Claude Code session ${run.agentSessionId.slice(0, 8)}, so the ${
                  readOnly ? `reading behind the ${wording.deliverable}` : 'implementation context'
                } is kept. ${
                  readOnly ? 'Still changes no files.' : 'Validation runs again afterwards.'
                }`
              : `No agent session is recorded for this run, so the ${wording.agentNoun} starts fresh from this run's stored request.`}
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
              {busy === 'changes' ? 'Sending…' : `Send to the ${wording.agentNoun}`}
            </button>
          </div>
        </div>
      ) : null}

      {dialog === 'approve' ? (
        <div className="panel p-3">
          {readiness.ready ? (
            <p className="mb-2.5 text-[12.5px] text-pass">
              {readOnly
                ? `The ${wording.deliverable} is written and nothing was changed to produce it.`
                : `All configured checks passed and ${run.changedFiles.length} file${
                    run.changedFiles.length === 1 ? '' : 's'
                  } changed.`}
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

          {/* A read-only run has nothing to commit: its output is an artifact. */}
          {readOnly ? null : (
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
          )}

          {createCommit && !readOnly ? (
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
                    createCommit: createCommit && !readOnly,
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
        {readiness.mode === 'build'
          ? `Ready — ${readiness.validationsPassed} check${
              readiness.validationsPassed === 1 ? '' : 's'
            } passed, nothing blocking.`
          : `Ready — the ${
              WORK_MODE_WORDING[readiness.mode].deliverable
            } is written and no files were changed.`}
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
