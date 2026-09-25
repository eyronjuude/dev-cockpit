'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { COMMAND_TARGET_LABELS, COMMAND_TARGETS, type CommandTarget } from '@/domain/types';
import type {
  OperationalCommandRunView,
  OperationalCommandView,
} from '@/services/operational-commands';

/** The subset of a run this panel needs to offer as a `non_production` target. */
export interface RunOption {
  id: string;
  title: string;
  branch: string | null;
  worktreePath: string | null;
}

const splitLines = (value: string): string[] =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Commands a person runs deliberately against a real target — a migration,
 * a seed script — as distinct from validation steps, which run
 * automatically. Nothing here fires on its own: every execution starts from
 * an explicit click on "Run" in this panel, and the server refuses the
 * request without `confirmed: true` regardless of what this UI sent.
 */
export function OperationalCommandsPanel({
  projectId,
  projectName,
  initialCommands,
  runs,
}: {
  projectId: string;
  projectName: string;
  initialCommands: OperationalCommandView[];
  runs: RunOption[];
}) {
  const router = useRouter();
  const [commands, setCommands] = useState(initialCommands);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<Record<string, OperationalCommandRunView>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [confirmText, setConfirmText] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [target, setTarget] = useState<CommandTarget>('non_production');
  const [env, setEnv] = useState('');

  const runsWithWorktree = runs.filter((r) => r.worktreePath);

  const addCommand = async () => {
    setBusy('add');
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/operational-commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label,
          command,
          workingDir: workingDir || null,
          target,
          env: splitLines(env),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { operationalCommand?: OperationalCommandView; error?: string }
        | null;
      if (!response.ok || !payload?.operationalCommand) {
        setError(payload?.error ?? `Request failed (${response.status})`);
        return;
      }
      setCommands((prev) => [...prev, payload.operationalCommand!]);
      setShowAdd(false);
      setLabel('');
      setCommand('');
      setWorkingDir('');
      setTarget('non_production');
      setEnv('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  const deleteCommand = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/operational-commands/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? `Request failed (${response.status})`);
        return;
      }
      setCommands((prev) => prev.filter((c) => c.id !== id));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  const openConfirm = (id: string) => {
    setConfirmingId(id);
    setSelectedRunId(runsWithWorktree[0]?.id ?? '');
    setConfirmText('');
    setError(null);
  };

  const runCommandNow = async (cmd: OperationalCommandView) => {
    const isProduction = cmd.target === 'production';
    if (isProduction && confirmText.trim() !== projectName) {
      setError(`Type the project name (${projectName}) to confirm a production run.`);
      return;
    }
    if (!isProduction && !selectedRunId) {
      setError('Pick a run to borrow a worktree from.');
      return;
    }

    setBusy(cmd.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/operational-commands/${cmd.id}/run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId: isProduction ? undefined : selectedRunId,
            confirmed: true,
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { run?: OperationalCommandRunView; error?: string }
        | null;
      if (!response.ok || !payload?.run) {
        setError(payload?.error ?? `Request failed (${response.status})`);
        return;
      }
      setLastRun((prev) => ({ ...prev, [cmd.id]: payload.run! }));
      setConfirmingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel mb-4">
      <div className="panel-head">
        <h2 className="panel-title">Operational commands</h2>
        <button type="button" className="btn text-[11px]" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? 'Cancel' : 'Add command'}
        </button>
      </div>

      <div className="px-3.5 py-3">
        <p className="hint mb-3">
          A command you run deliberately against a real target — a migration, a seed script —
          rather than one that runs automatically as part of validation. Non-production runs
          inside a run&apos;s own worktree; production runs directly in this project&apos;s main
          checkout, and only once that checkout is on its default branch and clean.
        </p>

        {error ? <p className="mb-2.5 text-[12px] text-fail">{error}</p> : null}

        {showAdd ? (
          <div className="mb-3 space-y-2.5 rounded border border-line p-2.5">
            <div>
              <label className="label" htmlFor="opc-label">
                Label
              </label>
              <input
                id="opc-label"
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Run migrations"
              />
            </div>
            <div>
              <label className="label" htmlFor="opc-command">
                Command
              </label>
              <input
                id="opc-command"
                className="input input-mono"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="pnpm db:migrate"
              />
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="opc-working-dir">
                  Working directory
                </label>
                <input
                  id="opc-working-dir"
                  className="input input-mono"
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                  placeholder="(root)"
                />
              </div>
              <div>
                <label className="label" htmlFor="opc-target">
                  Target
                </label>
                <select
                  id="opc-target"
                  className="input"
                  value={target}
                  onChange={(e) => setTarget(e.target.value as CommandTarget)}
                >
                  {COMMAND_TARGETS.map((t) => (
                    <option key={t} value={t}>
                      {COMMAND_TARGET_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="opc-env">
                Environment
              </label>
              <textarea
                id="opc-env"
                className="textarea input-mono"
                rows={3}
                value={env}
                placeholder={'DATABASE_URL=postgres://...'}
                onChange={(e) => setEnv(e.target.value)}
              />
              <p className="hint">
                One <code className="mono">KEY=VALUE</code> per line, merged over the project&apos;s
                own environment for this command only. Non-production commands resolve{' '}
                <code className="mono">{'{runId}'}</code> to the borrowed run; production leaves
                it as written.
              </p>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy === 'add' || !label.trim() || !command.trim()}
                onClick={() => void addCommand()}
              >
                {busy === 'add' ? 'Adding…' : 'Add command'}
              </button>
            </div>
          </div>
        ) : null}

        {commands.length === 0 ? (
          <p className="empty-state">No operational commands configured.</p>
        ) : (
          <ul className="divide-y divide-line">
            {commands.map((cmd) => {
              const result = lastRun[cmd.id];
              return (
                <li key={cmd.id} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`badge ${cmd.target === 'production' ? 'badge-fail' : 'badge-running'}`}
                    >
                      {COMMAND_TARGET_LABELS[cmd.target]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                      {cmd.label}
                    </span>
                    <button
                      type="button"
                      className="btn text-[11px]"
                      disabled={busy === cmd.id}
                      onClick={() => openConfirm(cmd.id)}
                    >
                      Run
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost text-[11px]"
                      disabled={busy === cmd.id}
                      onClick={() => void deleteCommand(cmd.id)}
                    >
                      Delete
                    </button>
                  </div>
                  <code className="mono mt-1 block truncate text-[11.5px] text-ink-faint">
                    {cmd.workingDir ? `${cmd.workingDir}: ` : ''}
                    {cmd.command}
                  </code>

                  {confirmingId === cmd.id ? (
                    <div className="mt-2 rounded border border-warn/40 bg-warn-soft px-2.5 py-2">
                      <p className="mb-2 text-[12px] font-medium text-warn">
                        {cmd.target === 'production'
                          ? `This runs directly in the project's main checkout on its default branch.`
                          : `This runs inside the worktree of the run selected below.`}
                      </p>

                      {cmd.target === 'production' ? (
                        <>
                          <label className="label" htmlFor={`opc-confirm-${cmd.id}`}>
                            Type the project name ({projectName}) to confirm
                          </label>
                          <input
                            id={`opc-confirm-${cmd.id}`}
                            className="input"
                            value={confirmText}
                            onChange={(e) => setConfirmText(e.target.value)}
                          />
                        </>
                      ) : runsWithWorktree.length === 0 ? (
                        <p className="text-[12px] text-ink-faint">
                          No run currently has a worktree to run this in.
                        </p>
                      ) : (
                        <>
                          <label className="label" htmlFor={`opc-run-${cmd.id}`}>
                            Run
                          </label>
                          <select
                            id={`opc-run-${cmd.id}`}
                            className="input"
                            value={selectedRunId}
                            onChange={(e) => setSelectedRunId(e.target.value)}
                          >
                            {runsWithWorktree.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.title} ({r.branch ?? r.id})
                              </option>
                            ))}
                          </select>
                        </>
                      )}

                      <div className="mt-2 flex justify-end gap-1.5">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => setConfirmingId(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          disabled={
                            busy === cmd.id ||
                            (cmd.target === 'production'
                              ? confirmText.trim() !== projectName
                              : runsWithWorktree.length === 0)
                          }
                          onClick={() => void runCommandNow(cmd)}
                        >
                          {busy === cmd.id ? 'Running…' : 'Run'}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {result ? (
                    <div className="mt-2 text-[11.5px]">
                      <span
                        className={
                          result.outcome === 'pass'
                            ? 'text-pass'
                            : result.outcome === 'running'
                              ? 'text-ink-faint'
                              : 'text-fail'
                        }
                      >
                        {result.outcome} (exit {result.exitCode ?? '—'})
                      </span>
                      {result.stdout || result.stderr ? (
                        <pre className="mono mt-1 max-h-40 overflow-auto rounded bg-surface-hover p-2 text-[11px]">
                          {[result.stdout, result.stderr].filter(Boolean).join('\n')}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
