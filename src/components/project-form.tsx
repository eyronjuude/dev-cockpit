'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ProbeRecordView } from '@/advisors/probe';
import type { SuggestedSetup } from '@/advisors/suggest';
import {
  AI_CONFIG_MODE_LABELS,
  AI_CONFIG_MODES,
  DEFAULT_AGENT_PERMISSION_MODE,
  PREVIEW_PORT_STRATEGIES,
  VALIDATION_KIND_LABELS,
  VALIDATION_KINDS,
  type AiConfigMode,
  type PreviewPortStrategy,
  type ValidationKind,
} from '@/domain/types';
import {
  blankStep,
  newStepFor,
  PROFILE_NAMES,
  StepEditor,
  type StepState,
} from './validation-step-editor';
import {
  DEFAULT_ARTIFACT_RETENTION_DAYS,
  DEFAULT_WORKTREE_RETENTION_DAYS,
} from '@/domain/expiry';
import { agentModelLabel, CLAUDE_CODE_PROVIDER, listAgentModels } from '@/domain/models';
import { PROFILES, recommendedModelFor } from '@/orchestrator/profiles';
import type { ProjectView } from '@/services/projects';
import type { RepositoryProbe } from '@/services/projects';
import type { ProviderOption } from './new-task-form';

/**
 * Project registration and configuration.
 *
 * The validation pipeline is a list the user builds, not six fixed slots: steps
 * can be added, removed and reordered, two may share a kind, and a step may
 * carry no kind at all. What has not changed is that nothing is required — a
 * pipeline with no step for a kind reports "not configured" there, which the
 * scorecard renders as such rather than as a failure.
 */

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
  implementers = [],
  transformers = [],
  reviewers = [],
}: {
  existing?: ProjectView;
  /** Setup advisors that can draft the fields. Empty hides the control. */
  advisors?: ProviderOption[];
  /** Implementation agents New Task can offer. Empty hides the default picker. */
  implementers?: ProviderOption[];
  /** Transformers New Task can offer. Empty hides the default picker. */
  transformers?: ProviderOption[];
  /** Reviewers New Task can offer. Empty hides the default picker. */
  reviewers?: ProviderOption[];
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
  const [env, setEnv] = useState((existing?.env ?? []).join('\n'));
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
  const [conventionalCommits, setConventionalCommits] = useState(
    existing?.conventionalCommits ?? true,
  );
  const [commitConvention, setCommitConvention] = useState(
    existing?.commitConvention ?? 'conventional',
  );
  const [customCommitTypes, setCustomCommitTypes] = useState(
    (existing?.customCommitTypes ?? []).join('\n'),
  );
  const [aiFormatsCommitMessages, setAiFormatsCommitMessages] = useState(
    existing?.aiFormatsCommitMessages ?? false,
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
  // Empty string means "no project default" — New Task falls back to its own
  // built-in preference order, exactly what an unset project does today.
  const [defaultAgentProvider, setDefaultAgentProvider] = useState(
    existing?.defaultAgentProvider ?? '',
  );
  const [defaultTransformerProvider, setDefaultTransformerProvider] = useState(
    existing?.defaultTransformerProvider ?? '',
  );
  const [defaultReviewerProvider, setDefaultReviewerProvider] = useState(
    existing?.defaultReviewerProvider ?? '',
  );

  // Set on the server, so it can disagree with whatever the select shows.
  const overriddenTo =
    existing && existing.effectivePermissionMode !== existing.agentPermissionMode
      ? existing.effectivePermissionMode
      : null;

  const [steps, setSteps] = useState<StepState[]>(() =>
    (existing?.validationSteps ?? []).map((step) => ({
      key: step.key,
      label: step.label,
      kind: step.kind ?? '',
      command: step.command,
      workingDir: step.workingDir ?? '',
      env: step.env.join('\n'),
      timeoutMs: step.timeoutMs,
      blocking: step.blocking,
      enabled: step.enabled,
      profiles: step.profiles.length > 0 ? step.profiles : [...PROFILE_NAMES],
      runWhen: step.runWhen,
      runWhenArg: step.runWhenArg ?? '',
      retries: step.retries,
      retryOn: step.retryOn,
      expanded: false,
    })),
  );

  /* Preview configuration. `developmentCommand` above is still the command. */
  const [previewWorkingDir, setPreviewWorkingDir] = useState(
    existing?.preview.workingDir ?? '',
  );
  const [previewEnv, setPreviewEnv] = useState(existing?.preview.env.join('\n') ?? '');
  const [previewPortStrategy, setPreviewPortStrategy] = useState<PreviewPortStrategy>(
    existing?.preview.portStrategy ?? 'auto',
  );
  const [previewFixedPort, setPreviewFixedPort] = useState(
    existing?.preview.fixedPort ? String(existing.preview.fixedPort) : '',
  );
  const [previewReadyPath, setPreviewReadyPath] = useState(existing?.preview.readyPath ?? '/');
  const [previewReadyTimeout, setPreviewReadyTimeout] = useState(
    String(Math.round((existing?.preview.readyTimeoutMs ?? 120_000) / 1000)),
  );
  const [previewAutoStart, setPreviewAutoStart] = useState(
    existing?.preview.autoStart ?? false,
  );

  const [aiConfigMode, setAiConfigMode] = useState<AiConfigMode>(
    existing?.aiConfigMode ?? 'draft',
  );

  const updateStep = (index: number, patch: Partial<StepState>) => {
    setSteps((prev) => prev.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  };

  const addStep = (kind: ValidationKind | '' = '') => {
    setSteps((prev) => [...prev, newStepFor(prev, kind)]);
  };

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  /** Order is the configuration, so moving a step is an edit like any other. */
  const moveStep = (index: number, delta: number) => {
    setSteps((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  };

  const [probe, setProbe] = useState<RepositoryProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [advisor, setAdvisor] = useState(existing?.aiConfigProvider ?? 'none');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<SuggestedSetup | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const [probeState, setProbeState] = useState<ProbeRecordView | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);

  /**
   * Hands the project to the advisor to configure, save and verify.
   *
   * Only reachable in `auto` mode, and only for a saved project: a probe needs
   * a repository path on disk and a row to write its progress against. The
   * request returns a probe id straight away and this polls it, because
   * installing dependencies and running a suite is minutes, not seconds.
   */
  const runAutoConfigure = async () => {
    if (!existing) return;
    setAutoRunning(true);
    setAutoError(null);
    setProbeState(null);
    try {
      const response = await fetch(`/api/projects/${existing.id}/auto-configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: advisor }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setAutoError(body?.error ?? `Could not start (${response.status})`);
        setAutoRunning(false);
        return;
      }
      const { probeId } = (await response.json()) as { probeId: string };
      await pollProbe(existing.id, probeId);
    } catch (err) {
      setAutoError(err instanceof Error ? err.message : 'Could not start.');
      setAutoRunning(false);
    }
  };

  const pollProbe = async (projectId: string, probeId: string) => {
    // Bounded so a probe whose process died does not leave a spinner forever.
    for (let tick = 0; tick < 600; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        const response = await fetch(`/api/projects/${projectId}/probe/${probeId}`);
        if (!response.ok) continue;
        const { probe } = (await response.json()) as { probe: ProbeRecordView };
        setProbeState(probe);
        if (probe.status !== 'running') {
          setAutoRunning(false);
          // The configuration on screen is now stale: the server wrote a new
          // one. A refresh is the honest way to show it.
          router.refresh();
          return;
        }
      } catch {
        // A dropped poll is not a failed probe. Try again.
      }
    }
    setAutoError('Stopped watching after 20 minutes. Reload to see where it got to.');
    setAutoRunning(false);
  };

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

  /** Takes one proposed step, replacing an existing one with the same key. */
  const applyProposedStep = (proposed: SuggestedSetup['proposal']['validationSteps'][number]) => {
    setSteps((prev) => {
      const at = prev.findIndex((step) => step.key === proposed.key);
      const next: StepState = {
        ...(at >= 0 ? prev[at]! : blankStep(proposed.key, proposed.label)),
        key: proposed.key,
        label: proposed.label,
        kind: proposed.kind ?? '',
        command: proposed.command,
        workingDir: proposed.workingDir ?? '',
        blocking: proposed.blocking,
        expanded: false,
      };
      if (at >= 0) return prev.map((step, i) => (i === at ? next : step));
      return [...prev, next];
    });
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
    if (!previewReadyPath.trim() || previewReadyPath === '/') {
      setPreviewReadyPath(proposal.preview.readyPath);
    }
    if (!previewWorkingDir.trim() && proposal.preview.workingDir) {
      setPreviewWorkingDir(proposal.preview.workingDir);
    }

    // Only steps the pipeline does not already have. A step the user wrote is
    // never overwritten by a draft; per-step Apply is the deliberate override.
    setSteps((prev) => {
      const taken = new Set(prev.map((step) => step.key));
      const additions = proposal.validationSteps
        .filter((proposed) => !taken.has(proposed.key))
        .map((proposed) => ({
          ...blankStep(proposed.key, proposed.label, proposed.kind ?? ''),
          command: proposed.command,
          workingDir: proposed.workingDir ?? '',
          blocking: proposed.blocking,
          expanded: false,
        }));
      return [...prev, ...additions];
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
      env: splitLines(env),
      protectedBranches: splitLines(protectedBranches),
      requireValidation,
      requireE2eForUiChanges,
      reviewBlocksReady,
      allowAgentCommit,
      cleanUpWorktreeOnFinish,
      conventionalCommits,
      commitConvention,
      customCommitTypes: splitLines(customCommitTypes),
      aiFormatsCommitMessages,
      worktreeRetentionDays: retentionOr(worktreeRetentionDays, DEFAULT_WORKTREE_RETENTION_DAYS),
      artifactRetentionDays: retentionOr(artifactRetentionDays, DEFAULT_ARTIFACT_RETENTION_DAYS),
      agentModel: agentModel || null,
      agentPermissionMode,
      defaultAgentProvider: defaultAgentProvider || null,
      defaultTransformerProvider: defaultTransformerProvider || null,
      defaultReviewerProvider: defaultReviewerProvider || null,
      aiConfigMode,
      aiConfigProvider: advisor === 'none' ? null : advisor,
      preview: {
        workingDir: previewWorkingDir.trim() || null,
        env: splitLines(previewEnv),
        portStrategy: previewPortStrategy,
        fixedPort:
          previewPortStrategy === 'fixed' && previewFixedPort.trim()
            ? Number(previewFixedPort)
            : null,
        readyPath: previewReadyPath.trim() || '/',
        readyTimeoutMs: Math.max(1, Number(previewReadyTimeout) || 120) * 1_000,
        autoStart: previewAutoStart,
      },
      // Position is the array order. Sending it explicitly rather than relying
      // on the server to infer it keeps "what I see is what runs" true.
      validationSteps: steps
        .filter((step) => step.command.trim())
        .map((step, index) => ({
          key: step.key,
          label: step.label.trim() || step.key,
          kind: step.kind || null,
          command: step.command.trim(),
          workingDir: step.workingDir.trim() || null,
          env: splitLines(step.env),
          timeoutMs: step.timeoutMs,
          blocking: step.blocking,
          enabled: step.enabled,
          profiles: step.profiles,
          position: index * 10,
          runWhen: step.runWhen,
          runWhenArg: step.runWhen === 'always' ? null : step.runWhenArg.trim() || null,
          retries: step.retries,
          retryOn: step.retryOn,
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

      {/* How much the AI may do */}
      {advisors.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">AI configuration</h2>
            <span className="text-[11px] text-ink-faint">per project</span>
          </div>
          <div className="space-y-3 px-3.5 py-3">
            <div>
              <label className="label" htmlFor="ai-config-mode">
                What the advisor may do here
              </label>
              <select
                id="ai-config-mode"
                className="input"
                value={aiConfigMode}
                onChange={(e) => setAiConfigMode(e.target.value as AiConfigMode)}
              >
                {AI_CONFIG_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {AI_CONFIG_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </div>

            {aiConfigMode === 'auto' ? (
              <div className="space-y-2 rounded border border-warn/40 bg-warn/5 p-2.5">
                <p className="text-[12px] text-ink-muted">
                  <strong>Auto</strong> saves the drafted configuration and then runs it in a
                  throwaway checkout under <span className="mono">data/probes/</span> — never your
                  own. Whatever could not run is corrected once and saved again. A check that ran
                  and <em>failed</em> is left alone: that is a real result about your code, not a
                  configuration mistake.
                </p>
                <p className="text-[12px] text-ink-muted">
                  This executes shell commands a model wrote, without you reading them first.
                  Every save is preceded by a snapshot, so the previous pipeline is one click
                  away under <strong>History</strong>.
                </p>
                {editing ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={autoRunning || existing?.aiConfigMode !== 'auto'}
                      onClick={() => void runAutoConfigure()}
                    >
                      {autoRunning ? 'Configuring and verifying…' : 'Configure and verify now'}
                    </button>
                    {existing?.aiConfigMode !== 'auto' ? (
                      <span className="hint">Save this setting first.</span>
                    ) : null}
                  </div>
                ) : (
                  <p className="hint">Save the project first, then run it from this panel.</p>
                )}
                {autoError ? <p className="hint text-fail">{autoError}</p> : null}
                {probeState ? <ProbeSummary probe={probeState} /> : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* Draft the setup */}
      {advisors.length > 0 && aiConfigMode !== 'off' ? (
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
                  {suggestion.proposal.validationSteps.map((proposed) => (
                    <SuggestionRow
                      key={proposed.key}
                      label={proposed.label}
                      value={proposed.command}
                      onApply={() => applyProposedStep(proposed)}
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

                {suggestion.proposal.validationSteps.length === 0 &&
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
          <h2 className="panel-title">Validation pipeline</h2>
          <span className="text-[11px] text-ink-faint">
            {steps.length === 0
              ? 'nothing configured'
              : `${steps.length} step${steps.length === 1 ? '' : 's'}, run top to bottom`}
          </span>
        </div>

        {steps.length === 0 ? (
          <p className="px-3.5 py-3 text-[12px] text-ink-muted">
            No steps yet. A project with no steps is reported as{' '}
            <span className="mono">not configured</span>, never as failing — but nothing will
            hold a broken run back either.
          </p>
        ) : (
          <div className="divide-y divide-line">
            {steps.map((step, index) => (
              <StepEditor
                key={step.key}
                step={step}
                index={index}
                total={steps.length}
                otherKeys={steps.filter((_, i) => i !== index).map((other) => other.key)}
                onChange={(patch) => updateStep(index, patch)}
                onRemove={() => removeStep(index)}
                onMove={(delta) => moveStep(index, delta)}
              />
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5">
          <button type="button" className="btn btn-sm" onClick={() => addStep()}>
            Add a step
          </button>
          <span className="text-[11px] text-ink-faint">or start from a kind:</span>
          {VALIDATION_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => addStep(kind)}
            >
              {VALIDATION_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      </section>

      {/* Preview */}
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Preview</h2>
          <span className="text-[11px] text-ink-faint">one per run</span>
        </div>
        <div className="space-y-3 px-3.5 py-3">
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
            <p className="hint">
              Started from the run screen. Dev Cockpit sets <span className="mono">PORT</span>,{' '}
              <span className="mono">HOST</span> and{' '}
              <span className="mono">DEV_COCKPIT_PREVIEW_URL</span> for it.
            </p>
          </div>

          {developmentCommand.trim() ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="preview-working-dir">
                    Working directory
                  </label>
                  <input
                    id="preview-working-dir"
                    className="input input-mono"
                    value={previewWorkingDir}
                    placeholder="(worktree root)"
                    onChange={(e) => setPreviewWorkingDir(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="preview-ready-path">
                    Ready path
                  </label>
                  <input
                    id="preview-ready-path"
                    className="input input-mono"
                    value={previewReadyPath}
                    placeholder="/"
                    onChange={(e) => setPreviewReadyPath(e.target.value)}
                  />
                  <p className="hint">
                    Requested until it answers. A health endpoint is a better signal than{' '}
                    <span className="mono">/</span> when the home page needs a login.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="preview-port-strategy">
                    Port
                  </label>
                  <select
                    id="preview-port-strategy"
                    className="input"
                    value={previewPortStrategy}
                    onChange={(e) =>
                      setPreviewPortStrategy(e.target.value as PreviewPortStrategy)
                    }
                  >
                    {PREVIEW_PORT_STRATEGIES.map((strategy) => (
                      <option key={strategy} value={strategy}>
                        {strategy === 'auto' ? 'Automatic — any free port' : 'Fixed'}
                      </option>
                    ))}
                  </select>
                  {previewPortStrategy === 'fixed' ? (
                    <input
                      className="input input-mono mt-2"
                      value={previewFixedPort}
                      placeholder="3000"
                      inputMode="numeric"
                      onChange={(e) => setPreviewFixedPort(e.target.value)}
                      aria-label="Fixed preview port"
                    />
                  ) : null}
                  <p className="hint">
                    Fixed is for a project whose own configuration hard-codes the URL. A clash is
                    reported rather than worked around.
                  </p>
                </div>
                <div>
                  <label className="label" htmlFor="preview-ready-timeout">
                    Give up waiting after (seconds)
                  </label>
                  <input
                    id="preview-ready-timeout"
                    className="input input-mono"
                    value={previewReadyTimeout}
                    inputMode="numeric"
                    onChange={(e) => setPreviewReadyTimeout(e.target.value)}
                  />
                  <p className="hint">
                    The process is left running when this elapses — a slow build is the usual
                    cause, and its log is the thing worth reading.
                  </p>
                </div>
              </div>

              <div>
                <label className="label" htmlFor="preview-env">
                  Environment
                </label>
                <textarea
                  id="preview-env"
                  className="input input-mono min-h-16"
                  value={previewEnv}
                  placeholder={'ONE_PER_LINE=value'}
                  onChange={(e) => setPreviewEnv(e.target.value)}
                />
                <p className="hint">
                  One <span className="mono">KEY=VALUE</span> per line. Secret-looking values are
                  masked in captured output.
                </p>
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-muted">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={previewAutoStart}
                  onChange={(e) => setPreviewAutoStart(e.target.checked)}
                />
                Start the preview automatically when a run is ready for review
              </label>
            </>
          ) : null}
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

          <div>
            <label className="label" htmlFor="setup-env">
              Environment for the setup command
            </label>
            <textarea
              id="setup-env"
              className="textarea input-mono"
              rows={3}
              value={env}
              placeholder={'DATABASE_URL=postgres://...'}
              onChange={(e) => setEnv(e.target.value)}
            />
            <p className="hint">
              One <code className="mono">KEY=VALUE</code> per line, injected directly into the
              setup command&apos;s process. Unlike linked files, this reaches the command even if
              nothing in the project loads an env file for itself — useful for a setup command
              that runs a migration. Secret-looking values are masked in captured output.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
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
          <Toggle
            checked={conventionalCommits}
            onChange={setConventionalCommits}
            label="Format Dev Cockpit's own commits as Conventional Commits"
            hint="Prefixes the run and landing-repair commit subjects with a type, e.g. feat: or chore:. Merge commits are left as git generates them. A subject that already looks conventional is left alone."
          />
          {conventionalCommits ? (
            <div className="ml-6 space-y-3 border-l border-line pl-3">
              <div>
                <label className="label" htmlFor="commit-convention">
                  Type vocabulary
                </label>
                <select
                  id="commit-convention"
                  className="select"
                  value={commitConvention}
                  onChange={(e) => setCommitConvention(e.target.value)}
                >
                  <option value="conventional">Conventional Commits (feat, fix, chore, …)</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {commitConvention === 'custom' ? (
                <div>
                  <label className="label" htmlFor="custom-commit-types">
                    Custom commit types
                  </label>
                  <textarea
                    id="custom-commit-types"
                    className="textarea input-mono"
                    rows={3}
                    value={customCommitTypes}
                    placeholder={'feature\nfixup\nmaint'}
                    onChange={(e) => setCustomCommitTypes(e.target.value)}
                  />
                  <p className="hint">
                    One per line. Replaces the built-in type list; left empty, the built-in list
                    is used instead.
                  </p>
                </div>
              ) : null}
              <Toggle
                checked={aiFormatsCommitMessages}
                onChange={setAiFormatsCommitMessages}
                label="Let the project's transformer write the commit subject"
                hint="Optional and off by default: costs one extra model call per commit. Falls back to the deterministic type prefix if the transformer is unavailable or its subject doesn't fit the convention."
              />
            </div>
          ) : null}

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
          {implementers.length > 0 ? (
            <div>
              <label className="label" htmlFor="default-implementer">
                Default implementer
              </label>
              <select
                id="default-implementer"
                className="select"
                value={defaultAgentProvider}
                onChange={(e) => setDefaultAgentProvider(e.target.value)}
              >
                <option value="">Follow New Task&rsquo;s built-in preference order</option>
                {implementers.map((option) => (
                  <option key={option.id} value={option.id} disabled={!option.available}>
                    {option.label}
                    {option.available ? '' : ' — unavailable'}
                  </option>
                ))}
              </select>
              <p className="hint">
                What New Task preselects for this project. A run or a single iteration can
                still choose a different agent — this only sets the starting point.
              </p>
            </div>
          ) : null}
          {transformers.length > 0 ? (
            <div>
              <label className="label" htmlFor="default-transformer">
                Default transformer
              </label>
              <select
                id="default-transformer"
                className="select"
                value={defaultTransformerProvider}
                onChange={(e) => setDefaultTransformerProvider(e.target.value)}
              >
                <option value="">Follow New Task&rsquo;s built-in preference order</option>
                {transformers.map((option) => (
                  <option key={option.id} value={option.id} disabled={!option.available}>
                    {option.label}
                    {option.available ? '' : ' — unavailable'}
                  </option>
                ))}
              </select>
              <p className="hint">
                Rewrites the request into a spec and the implementer&rsquo;s closing message into
                plain language. A run can still switch transformers mid-run.
              </p>
            </div>
          ) : null}
          {reviewers.length > 0 ? (
            <div>
              <label className="label" htmlFor="default-reviewer">
                Default reviewer
              </label>
              <select
                id="default-reviewer"
                className="select"
                value={defaultReviewerProvider}
                onChange={(e) => setDefaultReviewerProvider(e.target.value)}
              >
                <option value="">Follow New Task&rsquo;s built-in preference order</option>
                {reviewers.map((option) => (
                  <option key={option.id} value={option.id} disabled={!option.available}>
                    {option.label}
                    {option.available ? '' : ' — unavailable'}
                  </option>
                ))}
              </select>
              <p className="hint">Read-only code review. Optional; off by default.</p>
            </div>
          ) : null}
          <div>
            <label className="label" htmlFor="agent-model">
              Model
            </label>
            <input
              id="agent-model"
              className="input input-mono"
              list="project-agent-model-options"
              value={agentModel}
              placeholder="leave blank to follow the execution profile"
              onChange={(e) => setAgentModel(e.target.value)}
            />
            <datalist id="project-agent-model-options">
              {listAgentModels(CLAUDE_CODE_PROVIDER).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </datalist>
            <p className="hint">
              A standing default for every run in this project. Blank is the better answer for
              most projects: each execution profile already recommends a model — Quick{' '}
              <code className="mono">
                {agentModelLabel(recommendedModelFor(PROFILES.quick, CLAUDE_CODE_PROVIDER))}
              </code>
              , Deep{' '}
              <code className="mono">
                {agentModelLabel(recommendedModelFor(PROFILES.deep, CLAUDE_CODE_PROVIDER))}
              </code>{' '}
              — and setting a model here overrides all three. Either way, New Task can pick a
              different one for a single run.
            </p>
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

/**
 * What a probe found, in the order a person asks about it.
 *
 * The distinction between a step that failed and one that could not run is the
 * whole reason this panel is not a green tick or a red cross: a pipeline where
 * every command ran and one suite failed is a *correct* configuration that
 * found a real problem.
 */
function ProbeSummary({ probe }: { probe: ProbeRecordView }) {
  if (probe.status === 'running') {
    return <p className="hint">{probe.phase}&hellip;</p>;
  }

  if (probe.status === 'failed') {
    return <p className="hint text-fail">{probe.error ?? 'The probe failed.'}</p>;
  }

  const report = probe.report;
  if (!report) return <p className="hint">Finished, but the report could not be read.</p>;

  const errored = report.steps.filter((step) => step.outcome === 'error');
  const failed = report.steps.filter((step) => step.outcome === 'fail');
  const passed = report.steps.filter((step) => step.outcome === 'pass');

  return (
    <div className="space-y-1.5">
      <p className="text-[12px]">
        <span className={report.configurationSound ? 'text-pass' : 'text-fail'}>
          {report.configurationSound
            ? 'Every command ran.'
            : `${errored.length} command(s) could not run.`}
        </span>{' '}
        {passed.length} passed, {failed.length} failed.
      </p>

      {failed.length > 0 ? (
        <p className="hint">
          Failed, and left alone: {failed.map((step) => step.label).join(', ')}. These ran
          correctly and found something in your code.
        </p>
      ) : null}

      {errored.length > 0 ? (
        <ul className="space-y-0.5">
          {errored.map((step) => (
            <li key={step.key} className="text-[11.5px] text-fail">
              <span className="mono">{step.command}</span> &mdash; {step.error}
            </li>
          ))}
        </ul>
      ) : null}

      {report.preview ? (
        <p className="hint">
          Preview {report.preview.ready ? 'came up.' : `did not come up: ${report.preview.error}`}
        </p>
      ) : null}

      {report.notes.map((note) => (
        <p key={note} className="hint">
          {note}
        </p>
      ))}
    </div>
  );
}
