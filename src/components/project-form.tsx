'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  DEFAULT_AGENT_PERMISSION_MODE,
  VALIDATION_KIND_LABELS,
  VALIDATION_KINDS,
  type ValidationKind,
} from '@/domain/types';
import type { ProjectView } from '@/services/projects';
import type { RepositoryProbe } from '@/services/projects';

/**
 * Project registration and configuration.
 *
 * Every validation kind is offered but none is required: an empty command means
 * "not configured", which the scorecard renders as such rather than as a
 * failure. That is the whole reason the form does not validate for completeness.
 */

interface CommandState {
  command: string;
  workingDir: string;
  blocking: boolean;
  enabled: boolean;
}

const EMPTY_COMMAND: CommandState = {
  command: '',
  workingDir: '',
  blocking: true,
  enabled: true,
};

/** Sensible starting points, shown as placeholders only. */
const PLACEHOLDERS: Record<ValidationKind, string> = {
  typecheck: 'npm run typecheck',
  lint: 'npm run lint',
  unit: 'npm test',
  integration: 'npm run test:integration',
  e2e: 'npx playwright test',
  build: 'npm run build',
};

export function ProjectForm({ existing }: { existing?: ProjectView }) {
  const router = useRouter();
  const editing = existing !== undefined;

  const [name, setName] = useState(existing?.name ?? '');
  const [repositoryPath, setRepositoryPath] = useState(existing?.repositoryPath ?? '');
  const [defaultBranch, setDefaultBranch] = useState(existing?.defaultBranch ?? '');
  const [developmentCommand, setDevelopmentCommand] = useState(
    existing?.developmentCommand ?? '',
  );
  const [setupCommand, setSetupCommand] = useState(existing?.setupCommand ?? '');
  const [openCommand, setOpenCommand] = useState(existing?.openCommand ?? '');
  const [linkPaths, setLinkPaths] = useState((existing?.linkPaths ?? []).join('\n'));
  const [protectedBranches, setProtectedBranches] = useState(
    (existing?.protectedBranches ?? ['main', 'master']).join('\n'),
  );

  const [requireValidation, setRequireValidation] = useState(
    existing?.requireValidation ?? true,
  );
  const [requireE2eForUiChanges, setRequireE2eForUiChanges] = useState(
    existing?.requireE2eForUiChanges ?? false,
  );
  const [reviewBlocksReady, setReviewBlocksReady] = useState(
    existing?.reviewBlocksReady ?? false,
  );
  const [allowAgentCommit, setAllowAgentCommit] = useState(existing?.allowAgentCommit ?? false);
  const [cleanUpWorktreeOnFinish, setCleanUpWorktreeOnFinish] = useState(
    existing?.cleanUpWorktreeOnFinish ?? true,
  );
  const [agentModel, setAgentModel] = useState(existing?.agentModel ?? '');
  const [agentPermissionMode, setAgentPermissionMode] = useState<string>(
    existing?.agentPermissionMode ?? DEFAULT_AGENT_PERMISSION_MODE,
  );

  // Set on the server, so it can disagree with whatever the select shows.
  const overriddenTo =
    existing && existing.effectivePermissionMode !== existing.agentPermissionMode
      ? existing.effectivePermissionMode
      : null;

  const [commands, setCommands] = useState<Record<ValidationKind, CommandState>>(() => {
    const initial = {} as Record<ValidationKind, CommandState>;
    for (const kind of VALIDATION_KINDS) {
      const found = existing?.validationCommands.find((c) => c.kind === kind);
      initial[kind] = found
        ? {
            command: found.command,
            workingDir: found.workingDir ?? '',
            blocking: found.blocking,
            enabled: found.enabled,
          }
        : { ...EMPTY_COMMAND };
    }
    return initial;
  });

  const [probe, setProbe] = useState<RepositoryProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runProbe = async () => {
    if (!repositoryPath.trim()) return;
    setProbing(true);
    setError(null);
    try {
      const response = await fetch('/api/projects/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryPath }),
      });
      const result = (await response.json()) as RepositoryProbe;
      setProbe(result);
      if (result.ok) {
        if (result.resolvedPath) setRepositoryPath(result.resolvedPath);
        if (!defaultBranch && result.defaultBranch) setDefaultBranch(result.defaultBranch);
        if (!name.trim() && result.resolvedPath) {
          const segments = result.resolvedPath.split(/[\\/]/).filter(Boolean);
          setName(segments.at(-1) ?? '');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check that path.');
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    setSaving(true);
    setError(null);

    const payload = {
      name,
      ...(editing ? {} : { repositoryPath }),
      defaultBranch: defaultBranch || undefined,
      developmentCommand: developmentCommand || null,
      setupCommand: setupCommand || null,
      openCommand: openCommand || null,
      linkPaths: splitLines(linkPaths),
      protectedBranches: splitLines(protectedBranches),
      requireValidation,
      requireE2eForUiChanges,
      reviewBlocksReady,
      allowAgentCommit,
      cleanUpWorktreeOnFinish,
      agentModel: agentModel || null,
      agentPermissionMode,
      validationCommands: VALIDATION_KINDS.map((kind) => ({
        kind,
        command: commands[kind].command.trim(),
        workingDir: commands[kind].workingDir.trim() || null,
        blocking: commands[kind].blocking,
        enabled: commands[kind].enabled,
      })),
    };

    try {
      const response = await fetch(
        editing ? `/api/projects/${existing!.id}` : '/api/projects',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Save failed (${response.status})`);
        return;
      }

      const body = (await response.json()) as { project: { id: string } };
      router.push(`/projects/${body.project.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Repository */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Repository</h2>
        </div>
        <div className="space-y-3 px-3.5 py-3">
          <div>
            <label className="label" htmlFor="repo-path">
              Repository path
            </label>
            <div className="flex gap-1.5">
              <input
                id="repo-path"
                className="input input-mono"
                value={repositoryPath}
                disabled={editing}
                placeholder="E:\\Work\\my-project"
                onChange={(e) => setRepositoryPath(e.target.value)}
                onBlur={() => {
                  if (!editing) void runProbe();
                }}
              />
              {!editing ? (
                <button
                  type="button"
                  className="btn"
                  disabled={probing || !repositoryPath.trim()}
                  onClick={() => void runProbe()}
                >
                  {probing ? 'Checking…' : 'Check'}
                </button>
              ) : null}
            </div>
            {editing ? (
              <p className="hint">
                The repository path cannot be changed. Register a new project instead.
              </p>
            ) : probe ? (
              <p className={`hint ${probe.ok ? 'text-pass' : 'text-fail'}`}>{probe.message}</p>
            ) : (
              <p className="hint">
                An absolute path to a local Git repository. Runs happen in isolated worktrees, so
                this checkout is never modified.
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="project-name">
                Name
              </label>
              <input
                id="project-name"
                className="input"
                value={name}
                placeholder="my-project"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="default-branch">
                Default branch
              </label>
              <input
                id="default-branch"
                className="input input-mono"
                value={defaultBranch}
                placeholder="main"
                onChange={(e) => setDefaultBranch(e.target.value)}
              />
              <p className="hint">Runs branch from here. It is always protected.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Validation */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Validation commands</h2>
          <span className="text-[11px] text-ink-faint">
            leave blank for &ldquo;not configured&rdquo;
          </span>
        </div>
        <div className="divide-y divide-line">
          {VALIDATION_KINDS.map((kind) => {
            const state = commands[kind];
            const set = (patch: Partial<CommandState>) =>
              setCommands((prev) => ({ ...prev, [kind]: { ...prev[kind], ...patch } }));

            return (
              <div key={kind} className="px-3.5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="w-24 shrink-0 text-[12.5px] font-medium">
                    {VALIDATION_KIND_LABELS[kind]}
                  </span>
                  <input
                    className="input input-mono"
                    value={state.command}
                    placeholder={PLACEHOLDERS[kind]}
                    onChange={(e) => set({ command: e.target.value })}
                    aria-label={`${VALIDATION_KIND_LABELS[kind]} command`}
                  />
                </div>

                {state.command.trim() ? (
                  <div className="mt-2 flex flex-wrap items-center gap-4 pl-[6.5rem]">
                    <input
                      className="input input-mono max-w-56"
                      value={state.workingDir}
                      placeholder="working directory (optional)"
                      onChange={(e) => set({ workingDir: e.target.value })}
                      aria-label={`${VALIDATION_KIND_LABELS[kind]} working directory`}
                    />
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-muted">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={state.blocking}
                        onChange={(e) => set({ blocking: e.target.checked })}
                      />
                      blocks readiness on failure
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-muted">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={state.enabled}
                        onChange={(e) => set({ enabled: e.target.checked })}
                      />
                      enabled
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* Worktree setup */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Worktree setup</h2>
        </div>
        <div className="space-y-3 px-3.5 py-3">
          <div>
            <label className="label" htmlFor="link-paths">
              Paths to link into each worktree
            </label>
            <textarea
              id="link-paths"
              className="textarea input-mono"
              rows={3}
              value={linkPaths}
              placeholder={'node_modules\n.env.local'}
              onChange={(e) => setLinkPaths(e.target.value)}
            />
            <p className="hint">
              One per line. A fresh worktree has no <code className="mono">node_modules</code> and
              no untracked env files, which most validation commands need. Directories are
              linked (a junction on Windows); files are copied so the agent cannot edit your
              originals.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="setup-command">
              Setup command
            </label>
            <input
              id="setup-command"
              className="input input-mono"
              value={setupCommand}
              placeholder="npm install --prefer-offline"
              onChange={(e) => setSetupCommand(e.target.value)}
            />
            <p className="hint">Runs once in each new worktree, after linking.</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="dev-command">
                Development command
              </label>
              <input
                id="dev-command"
                className="input input-mono"
                value={developmentCommand}
                placeholder="npm run dev"
                onChange={(e) => setDevelopmentCommand(e.target.value)}
              />
              <p className="hint">Recorded for reference. V1 does not start it.</p>
            </div>
            <div>
              <label className="label" htmlFor="open-command">
                Open command
              </label>
              <input
                id="open-command"
                className="input input-mono"
                value={openCommand}
                placeholder="code {path}"
                onChange={(e) => setOpenCommand(e.target.value)}
              />
              <p className="hint">
                <code className="mono">{'{path}'}</code> is replaced with the worktree path.
                Blank uses your file manager.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Policies */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Policies</h2>
        </div>
        <div className="space-y-3 px-3.5 py-3">
          <Toggle
            checked={requireValidation}
            onChange={setRequireValidation}
            label="Require validation before a run can be ready"
            hint="A run with no validation results stays in Needs changes."
          />
          <Toggle
            checked={requireE2eForUiChanges}
            onChange={setRequireE2eForUiChanges}
            label="Require an E2E check when UI files change"
            hint="Applies when a changed file looks like UI code and no E2E command ran."
          />
          <Toggle
            checked={reviewBlocksReady}
            onChange={setReviewBlocksReady}
            label="Let high-severity review findings block readiness"
            hint="Off by default: a reviewer opinion is not a test result."
          />
          <Toggle
            checked={allowAgentCommit}
            onChange={setAllowAgentCommit}
            label="Allow the implementation agent to create local commits"
            hint="Even when on, the agent is told never to push, merge, rebase or reset."
          />
          <Toggle
            checked={cleanUpWorktreeOnFinish}
            onChange={setCleanUpWorktreeOnFinish}
            label="Remove a run's worktrees once it lands or is rejected"
            hint="Never forces: a worktree with uncommitted changes, or a branch with unmerged commits, is kept and the reason recorded."
          />

          <div>
            <label className="label" htmlFor="protected-branches">
              Protected branches
            </label>
            <textarea
              id="protected-branches"
              className="textarea input-mono"
              rows={2}
              value={protectedBranches}
              onChange={(e) => setProtectedBranches(e.target.value)}
            />
            <p className="hint">
              One per line. A run never checks these out and never commits onto them. The
              default branch is added automatically.
            </p>
          </div>
        </div>
      </section>

      {/* Agent */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Implementation agent</h2>
        </div>
        <div className="grid gap-3 px-3.5 py-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="agent-model">
              Model
            </label>
            <input
              id="agent-model"
              className="input input-mono"
              value={agentModel}
              placeholder="leave blank for the Claude Code default"
              onChange={(e) => setAgentModel(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="permission-mode">
              Permission mode
            </label>
            <select
              id="permission-mode"
              className="select"
              value={agentPermissionMode}
              onChange={(e) => setAgentPermissionMode(e.target.value)}
            >
              <option value="bypassPermissions">
                bypassPermissions — skips every check (default)
              </option>
              <option value="acceptEdits">acceptEdits — file edits only, no commands</option>
              <option value="plan">plan — read-only planning</option>
            </select>
            <p className="hint">
              <code className="mono">bypassPermissions</code> is the default and runs the CLI with{' '}
              <code className="mono">--dangerously-skip-permissions</code>: the agent can run your
              tests, inspect git and check a build, so it verifies its own work instead of guessing.
              Nobody is watching a run, so the alternative to skipping a check is refusing the call
              — never asking.{' '}
              <code className="mono">acceptEdits</code> takes that stricter road: file edits are
              allowed, <strong>every shell command is refused</strong>, and the agent works blind
              while validation catches problems afterwards. The worktree is disposable and on its
              own branch either way.
            </p>
            {overriddenTo ? (
              <p className="hint text-warn">
                Overridden to <code className="mono">{overriddenTo}</code> by{' '}
                <code className="mono">DEV_COCKPIT_PERMISSION_MODE</code> on this machine. Runs use
                that, whatever is saved here.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {error ? (
        <p className="rounded border border-fail/40 bg-fail-soft px-3 py-2 text-[12.5px] text-fail">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !name.trim() || (!editing && !repositoryPath.trim())}
          onClick={() => void submit()}
        >
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Register project'}
        </button>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5 accent-accent"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-[12.5px]">{label}</span>
        <span className="block text-[11.5px] text-ink-faint">{hint}</span>
      </span>
    </label>
  );
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
