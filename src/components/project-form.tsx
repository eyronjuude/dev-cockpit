'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  DEFAULT_AGENT_PERMISSION_MODE,
  VALIDATION_KIND_LABELS,
  VALIDATION_KINDS,
  type ValidationKind,
} from '@/domain/types';
import {
  DEFAULT_ARTIFACT_RETENTION_DAYS,
  DEFAULT_WORKTREE_RETENTION_DAYS,
} from '@/domain/expiry';
import type { SuggestedSetup } from '@/advisors/suggest';
import type { ProjectView } from '@/services/projects';
import type { RepositoryProbe } from '@/services/projects';
import type { ProviderOption } from './new-task-form';

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

/**
 * A retention box back to a number of days.
 *
 * A blank field means "leave it at the default" rather than zero, because zero
 * is the setting that turns retention off and nobody turns it off by deleting
 * the contents of a box.
 */
function retentionOr(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, 3_650);
}

export function ProjectForm({
  existing,
  advisors = [],
}: {
  existing?: ProjectView;
  /** Setup advisors that can draft the fields. Empty hides the control. */
  advisors?: ProviderOption[];
}) {
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
  // Held as strings so clearing the box does not snap back to a number the
  // user did not type. Parsed on submit; a blank falls back to the default.
  const [worktreeRetentionDays, setWorktreeRetentionDays] = useState(
    String(existing?.worktreeRetentionDays ?? DEFAULT_WORKTREE_RETENTION_DAYS),
  );
  const [artifactRetentionDays, setArtifactRetentionDays] = useState(
    String(existing?.artifactRetentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS),
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

  const [advisor, setAdvisor] = useState('none');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<SuggestedSetup | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  /**
   * Asks the server to draft the setup fields from the repository.
   *
   * Nothing is applied here. The draft is rendered for review and the user
   * chooses what to take, because every command proposed is a command that
   * will later run against their code.
   */
  const runSuggest = async () => {
    if (!repositoryPath.trim()) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const response = await fetch('/api/projects/suggest-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryPath, provider: advisor }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setSuggestError(body?.error ?? `Could not draft a setup (${response.status})`);
        return;
      }
      setSuggestion((await response.json()) as SuggestedSetup);
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : 'Could not draft a setup.');
    } finally {
      setSuggesting(false);
    }
  };

  const applyValidationCommand = (kind: ValidationKind, command: string) => {
    setCommands((prev) => ({ ...prev, [kind]: { ...prev[kind], command } }));
  };

  /**
   * Takes the whole draft, but only where the form is still blank.
   *
   * Matches what `runProbe` already does with the name and default branch:
   * a suggestion never overwrites something the user typed. Per-field
   * **Apply** is the deliberate override.
   */
  const applyWholeSuggestion = () => {
    if (!suggestion) return;
    const { proposal } = suggestion;

    if (!setupCommand.trim() && proposal.setupCommand) setSetupCommand(proposal.setupCommand);
    if (!developmentCommand.trim() && proposal.developmentCommand) {
      setDevelopmentCommand(proposal.developmentCommand);
    }
    if (!linkPaths.trim() && proposal.linkPaths.length > 0) {
      setLinkPaths(proposal.linkPaths.join('\n'));
    }
    setCommands((prev) => {
      const next = { ...prev };
      for (const proposed of proposal.validationCommands) {
        if (next[proposed.kind].command.trim()) continue;
        next[proposed.kind] = {
          ...next[proposed.kind],
          command: proposed.command,
          workingDir: proposed.workingDir ?? next[proposed.kind].workingDir,
        };
      }
      return next;
    });
  };

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
      worktreeRetentionDays: retentionOr(worktreeRetentionDays, DEFAULT_WORKTREE_RETENTION_DAYS),
      artifactRetentionDays: retentionOr(artifactRetentionDays, DEFAULT_ARTIFACT_RETENTION_DAYS),
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

      {/* Draft the setup */}
      {advisors.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Draft the setup</h2>
            <span className="text-[11px] text-ink-faint">nothing is saved until you save</span>
          </div>
          <div className="space-y-3 px-3.5 py-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-52 flex-1">
                <label className="label" htmlFor="advisor">
                  Draft using
                </label>
                <select
                  id="advisor"
                  className="input"
                  value={advisor}
                  onChange={(e) => setAdvisor(e.target.value)}
                >
                  {advisors.map((option) => (
                    <option key={option.id} value={option.id} disabled={!option.available}>
                      {option.label}
                      {option.available ? '' : ' — unavailable'}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="btn"
                disabled={suggesting || !repositoryPath.trim()}
                onClick={() => void runSuggest()}
              >
                {suggesting ? 'Reading the repository…' : 'Suggest setup'}
              </button>
            </div>

            <p className="hint">
              Reads this project&rsquo;s manifests — <code className="mono">package.json</code>,{' '}
              <code className="mono">pyproject.toml</code>, lockfiles, tool configs — and drafts the
              commands they imply. Detection alone needs no model; a provider above only refines
              what the files already say.
            </p>

            {suggestError ? <p className="hint text-fail">{suggestError}</p> : null}

            {suggestion ? (
              <div className="space-y-2.5 rounded border border-line px-3 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[12.5px] text-ink-muted">{suggestion.evidenceSummary}</p>
                  <span
                    className={`text-[11px] ${
                      suggestion.proposal.confidence === 'high' ? 'text-pass' : 'text-ink-faint'
                    }`}
                  >
                    {suggestion.proposal.confidence} confidence
                  </span>
                </div>

                {suggestion.fellBackTo ? (
                  <p className="hint text-warn">
                    {suggestion.provider} could not be used ({suggestion.fallbackReason}), so this
                    draft comes from the repository alone.
                  </p>
                ) : null}

                {suggestion.proposal.notes ? (
                  <p className="text-[12px] text-ink-muted">{suggestion.proposal.notes}</p>
                ) : null}

                <div className="divide-y divide-line">
                  {suggestion.proposal.validationCommands.map((proposed) => (
                    <SuggestionRow
                      key={proposed.kind}
                      label={VALIDATION_KIND_LABELS[proposed.kind]}
                      value={proposed.command}
                      onApply={() => applyValidationCommand(proposed.kind, proposed.command)}
                    />
                  ))}
                  {suggestion.proposal.setupCommand ? (
                    <SuggestionRow
                      label="Setup"
                      value={suggestion.proposal.setupCommand}
                      onApply={() => setSetupCommand(suggestion.proposal.setupCommand ?? '')}
                    />
                  ) : null}
                  {suggestion.proposal.developmentCommand ? (
                    <SuggestionRow
                      label="Development"
                      value={suggestion.proposal.developmentCommand}
                      onApply={() =>
                        setDevelopmentCommand(suggestion.proposal.developmentCommand ?? '')
                      }
                    />
                  ) : null}
                  {suggestion.proposal.linkPaths.length > 0 ? (
                    <SuggestionRow
                      label="Paths to link"
                      value={suggestion.proposal.linkPaths.join(', ')}
                      onApply={() => setLinkPaths(suggestion.proposal.linkPaths.join('\n'))}
                    />
                  ) : null}
                </div>

                {suggestion.proposal.validationCommands.length === 0 &&
                !suggestion.proposal.setupCommand &&
                !suggestion.proposal.developmentCommand ? (
                  <p className="hint">
                    Nothing in the repository supported a command, so there is nothing to apply.
                    Fill the fields below by hand.
                  </p>
                ) : (
                  <button type="button" className="btn btn-sm" onClick={applyWholeSuggestion}>
                    Apply all to empty fields
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

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

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="worktree-retention">
                Expire worktrees after
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="worktree-retention"
                  className="input input-mono w-24"
                  type="number"
                  min={0}
                  max={3650}
                  value={worktreeRetentionDays}
                  onChange={(e) => setWorktreeRetentionDays(e.target.value)}
                />
                <span className="text-[12px] text-ink-muted">days after a run finishes</span>
              </div>
              <p className="hint">
                Covers every finished run, including failed and cancelled ones, not only the
                two the toggle above catches. Removal still never forces.{' '}
                <code className="mono">0</code> keeps them forever.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="artifact-retention">
                Expire artifacts after
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="artifact-retention"
                  className="input input-mono w-24"
                  type="number"
                  min={0}
                  max={3650}
                  value={artifactRetentionDays}
                  onChange={(e) => setArtifactRetentionDays(e.target.value)}
                />
                <span className="text-[12px] text-ink-muted">days after a run finishes</span>
              </div>
              <p className="hint">
                Logs, diffs and reports. The record of each stays on the run and reads
                &ldquo;expired&rdquo;; only the bytes go. Attached files are never touched.{' '}
                <code className="mono">0</code> keeps them forever.
              </p>
            </div>
          </div>

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

/**
 * One proposed value, with the button that takes it.
 *
 * The value is shown in full before it can be applied. These strings become
 * shell commands that later run against the user's code, so reading one is the
 * point of the step rather than a formality.
 */
function SuggestionRow({
  label,
  value,
  onApply,
}: {
  label: string;
  value: string;
  onApply: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="w-24 shrink-0 text-[11.5px] text-ink-muted">{label}</span>
      <code className="mono flex-1 truncate text-[12px]" title={value}>
        {value}
      </code>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onApply}>
        Apply
      </button>
    </div>
  );
}
