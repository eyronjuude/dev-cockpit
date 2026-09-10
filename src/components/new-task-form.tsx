'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { safeAttachmentFileName } from '@/domain/attachments';
import {
  DEFAULT_WORK_MODE,
  isReadOnlyMode,
  resolveWorkMode,
  WORK_MODE_DESCRIPTIONS,
  WORK_MODE_LABELS,
  WORK_MODE_WORDING,
  WORK_MODES,
  type WorkMode,
} from '@/domain/modes';
import {
  agentModelLabel,
  CLAUDE_CODE_PROVIDER,
  findAgentModel,
  listAgentModels,
  resolveAgentEffort,
  resolveAgentModel,
  type EffortResolution,
} from '@/domain/models';
import {
  permissionModeAllowsCommands,
  VALIDATION_KIND_LABELS,
  type ExecutionProfileName,
} from '@/domain/types';
import { recommendedModelFor, type ExecutionProfile } from '@/orchestrator/profiles';
import type { ProjectView, RepositoryState } from '@/services/projects';
import { AttachmentPicker } from './attachments';

export interface ProviderOption {
  id: string;
  label: string;
  requirement: string;
  available: boolean;
  detail: string;
}

/**
 * The effort line under a model tile.
 *
 * Says what the model will actually be sent, not what the profile asked for:
 * the two differ exactly when the choice is interesting, and a tile that
 * printed the profile's level would hide the one thing worth knowing.
 */
function effortFootnote(effort: EffortResolution): string {
  if (effort.effort === null) {
    return effort.clamped ? 'takes no effort setting' : 'no effort set';
  }
  return effort.clamped
    ? `effort ${effort.effort} · profile asks ${effort.requested}`
    : `effort ${effort.effort}`;
}

/** The one-line consequence of each mode, under its description. */
const MODE_FOOTNOTES: Record<WorkMode, string> = {
  ask: 'read-only · no checks',
  plan: 'read-only · no checks',
  build: 'edits files · checks run',
  auto: 'decided from the request',
};

/**
 * New task.
 *
 * The request field is the main event. Provider selection defaults to what is
 * actually available on this machine, and an unavailable provider is shown
 * with the reason rather than hidden, so nothing silently does nothing.
 *
 * Three independent choices sit under it, and keeping them separate is the
 * point: the working mode decides *what* the run produces, the execution
 * profile decides *how much effort* it spends, and the model decides *what
 * spends it*. The profile suggests a model to go with its effort, and the
 * suggestion is only that — the last panel overrides it without the profile or
 * its effort changing.
 *
 * Auto shows the mode it would pick, and why, before anything is created — a
 * guess the user can see is a guess the user can correct. The model panel does
 * the same for effort: where the chosen model will not take the profile's
 * level, it says which level is actually sent.
 */
export function NewTaskForm({
  project,
  projects,
  profiles,
  implementers,
  transformers,
  reviewers,
  defaultImplementer,
  defaultTransformer,
  defaultReviewer,
  repoState,
}: {
  project: ProjectView;
  projects: { id: string; name: string }[];
  profiles: ExecutionProfile[];
  implementers: ProviderOption[];
  transformers: ProviderOption[];
  reviewers: ProviderOption[];
  defaultImplementer: string;
  defaultTransformer: string;
  defaultReviewer: string;
  repoState: RepositoryState;
}) {
  const router = useRouter();

  const [projectId, setProjectId] = useState(project.id);
  const [request, setRequest] = useState('');
  // Held as browser `File` objects until the run is submitted, so abandoning
  // the form leaves nothing on disk to clean up.
  const [attachments, setAttachments] = useState<File[]>([]);
  const [mode, setMode] = useState<WorkMode>(DEFAULT_WORK_MODE);
  const [profile, setProfile] = useState<ExecutionProfileName>('standard');
  const [implementer, setImplementer] = useState(defaultImplementer);
  /**
   * The model chosen for this run, or null to follow the profile.
   *
   * Null is not "no model": it is "whichever this profile recommends", which is
   * why changing the profile moves it and an explicit pick stays put. Held as
   * the id rather than a catalogue index so a model typed by hand is the same
   * kind of value as one clicked.
   */
  const [model, setModel] = useState<string | null>(null);
  const [showCustomModel, setShowCustomModel] = useState(false);
  const [transformer, setTransformer] = useState(defaultTransformer);
  const [reviewer, setReviewer] = useState(defaultReviewer);
  // Prefilled with the checked-out branch when it differs from the project
  // default, so a run does not silently start from stale code.
  const [baseRef, setBaseRef] = useState(
    repoState.divergent && repoState.currentBranch ? repoState.currentBranch : '',
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = project.validationCommands.filter(
    (c) => c.enabled && c.command.trim().length > 0,
  );
  const selectedProfile = profiles.find((p) => p.id === profile) ?? profiles[1] ?? profiles[0]!;
  const selectedImplementer = implementers.find((p) => p.id === implementer);

  // Recomputed as the request is typed, using the same pure function the
  // server uses when the run is created, so the preview cannot disagree with
  // what actually happens.
  const resolution = resolveWorkMode(mode, request);
  const readOnly = isReadOnlyMode(resolution.mode);
  const wording = WORK_MODE_WORDING[resolution.mode];

  // Same three functions the orchestrator calls, so what this panel says is
  // what the run gets rather than a second description of it. Every one of
  // them is asked about the selected implementer: a model belongs to the
  // provider that named it, and only Claude Code has a catalogue here.
  const implementerLabel = selectedImplementer?.label ?? implementer;
  const models = listAgentModels(implementer);
  const recommendedModel = recommendedModelFor(selectedProfile, implementer);
  // The saved default is a Claude Code setting, matching what the server does
  // with it, so switching implementer does not carry it onto another CLI.
  const projectModel = implementer === CLAUDE_CODE_PROVIDER ? project.agentModel : null;
  const modelChoice = resolveAgentModel({
    requested: model,
    projectDefault: projectModel,
    recommended: recommendedModel,
  });
  const effort = resolveAgentEffort(modelChoice.model, selectedProfile.agentEffort);
  // What "Follow the profile" would land on, which is the project's default
  // when one is set — a recommendation is the weakest of the three.
  const inheritedChoice = resolveAgentModel({
    projectDefault: projectModel,
    recommended: recommendedModel,
  });

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payload = JSON.stringify({
        projectId,
        request,
        mode,
        profile,
        agentProvider: implementer,
        // Only when it was chosen here. Omitted, the server applies the same
        // project-then-profile precedence this form previewed.
        model: model?.trim() || undefined,
        transformer,
        reviewer,
        baseRef: baseRef.trim() || undefined,
      });

      /**
       * Multipart only when there is a file to carry. The fields ride in a
       * JSON `payload` part and are parsed by the same schema either way, so
       * the common case stays a plain JSON body and no boundary is negotiated
       * for a request that has nothing to attach.
       *
       * `Content-Type` is left unset for the multipart case deliberately: the
       * browser has to set it, because only it knows the boundary.
       */
      const response = await fetch('/api/runs', {
        method: 'POST',
        ...(attachments.length > 0
          ? { body: buildMultipartBody(payload, attachments) }
          : { headers: { 'Content-Type': 'application/json' }, body: payload }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Could not start the run (${response.status})`);
        return;
      }

      const body = (await response.json()) as { run: { id: string } };
      router.push(`/runs/${body.run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the run');
    } finally {
      setSubmitting(false);
    }
  };

  const effectiveBase = baseRef.trim() || project.defaultBranch;
  const baseIsStale =
    repoState.divergent &&
    repoState.currentBranch !== null &&
    effectiveBase !== repoState.currentBranch;

  return (
    <div className="space-y-4">
      {repoState.divergent && repoState.currentBranch ? (
        <div
          className={`rounded border px-3 py-2.5 ${
            baseIsStale
              ? 'border-warn/50 bg-warn-soft'
              : 'border-line bg-surface'
          }`}
        >
          <p className={`text-[12.5px] ${baseIsStale ? 'text-warn' : 'text-ink-muted'}`}>
            {baseIsStale ? (
              <>
                <span className="font-semibold">This run would start from stale code.</span> Your
                checkout is on <code className="mono">{repoState.currentBranch}</code>
                {repoState.ahead !== null && repoState.ahead > 0
                  ? `, ${repoState.ahead} commit${repoState.ahead === 1 ? '' : 's'} ahead of `
                  : ', which differs from '}
                <code className="mono">{project.defaultBranch}</code>, but the base below is{' '}
                <code className="mono">{effectiveBase}</code>.
              </>
            ) : (
              <>
                Branching from <code className="mono">{repoState.currentBranch}</code>, the branch
                you have checked out
                {repoState.ahead !== null && repoState.ahead > 0
                  ? ` — ${repoState.ahead} commit${repoState.ahead === 1 ? '' : 's'} ahead of ${project.defaultBranch}.`
                  : `, rather than the project default (${project.defaultBranch}).`}
              </>
            )}
          </p>
          {baseIsStale ? (
            <button
              type="button"
              className="btn btn-sm mt-2"
              onClick={() => setBaseRef(repoState.currentBranch ?? '')}
            >
              Use {repoState.currentBranch} instead
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            {resolution.mode === 'ask' ? 'Question' : 'Development request'}
          </h2>
          {projects.length > 1 ? (
            <select
              className="select max-w-52"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                if (e.target.value !== project.id) {
                  router.push(`/projects/${e.target.value}/new-task`);
                }
              }}
              aria-label="Project"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        <div className="p-3.5">
          <textarea
            className="textarea"
            rows={9}
            autoFocus
            value={request}
            placeholder={
              resolution.mode === 'ask'
                ? 'Ask something about this codebase.\n\nHow does session expiry work, and where is the cookie actually set?'
                : resolution.mode === 'plan'
                  ? 'Describe what you want planned.\n\nWe need to move password reset off the email queue. Plan how, in steps small enough to review one at a time.'
                  : 'Describe what you want built or fixed.\n\nThe login form accepts an empty password and returns 500. It should reject it with a 400 and a field-level error, and there should be a test for it.'
            }
            onChange={(e) => setRequest(e.target.value)}
          />
          <p className="hint">
            Plain language is fine. This text is stored verbatim and, if a transformer is
            selected, expanded into a specification before the agent sees it.
          </p>
        </div>
      </div>

      <AttachmentPicker
        files={attachments}
        onChange={setAttachments}
        disabled={submitting}
      />

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Working mode</h2>
          <span className="text-[11px] text-ink-faint">what this run produces</span>
        </div>
        <div className="grid gap-2 p-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {WORK_MODES.map((option) => {
            const active = option === mode;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                aria-pressed={active}
                className={`rounded border p-2.5 text-left transition-colors ${
                  active
                    ? 'border-accent bg-accent-soft'
                    : 'border-line-strong bg-surface-raised hover:bg-surface-hover'
                }`}
              >
                <span className="block text-[12.5px] font-semibold">
                  {WORK_MODE_LABELS[option]}
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">
                  {WORK_MODE_DESCRIPTIONS[option]}
                </span>
                <span className="mt-1.5 block text-[10.5px] text-ink-faint">
                  {MODE_FOOTNOTES[option]}
                </span>
              </button>
            );
          })}
        </div>
        {mode === 'auto' ? (
          <p className="border-t border-line px-3.5 py-2 text-[12px] text-ink-muted">
            <span className="font-semibold text-accent">
              Auto → {WORK_MODE_LABELS[resolution.mode]}
            </span>{' '}
            — {resolution.reason}.{' '}
            {request.trim().length === 0
              ? 'Recomputed as you type; pick a mode to decide it yourself.'
              : 'Pick a mode to decide it yourself.'}
          </p>
        ) : null}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Execution profile</h2>
          <span className="text-[11px] text-ink-faint">how much effort it spends</span>
        </div>
        <div className="grid gap-2 p-3.5 sm:grid-cols-3">
          {profiles.map((option) => {
            const active = option.id === profile;
            const suggested = recommendedModelFor(option, implementer);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setProfile(option.id)}
                aria-pressed={active}
                className={`rounded border p-2.5 text-left transition-colors ${
                  active
                    ? 'border-accent bg-accent-soft'
                    : 'border-line-strong bg-surface-raised hover:bg-surface-hover'
                }`}
              >
                <span className="block text-[12.5px] font-semibold">{option.label}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">
                  {option.description}
                </span>
                <span className="mt-1.5 block text-[10.5px] text-ink-faint">
                  effort {option.agentEffort}
                  {/* The model it suggests, so switching profile does not move
                      the model out from under the user unannounced. */}
                  {suggested ? ` · ${agentModelLabel(suggested)}` : ''}
                  {readOnly ? '' : ` · reviewer ${option.runReviewer ? 'on' : 'off'}`}
                </span>
              </button>
            );
          })}
        </div>
        {readOnly ? (
          <p className="border-t border-line px-3.5 py-2 text-[12px] text-ink-muted">
            In {WORK_MODE_LABELS[resolution.mode]} mode the profile sets the model, the effort
            and the time cap only. No checks and no review run either way.
          </p>
        ) : null}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Model</h2>
          <span className="text-[11px] text-ink-faint">what does the work</span>
        </div>
        <div className="grid gap-2 p-3.5 sm:grid-cols-2 lg:grid-cols-4">
          <button
            type="button"
            onClick={() => setModel(null)}
            aria-pressed={model === null}
            className={`rounded border p-2.5 text-left transition-colors ${
              model === null
                ? 'border-accent bg-accent-soft'
                : 'border-line-strong bg-surface-raised hover:bg-surface-hover'
            }`}
          >
            <span className="block text-[12.5px] font-semibold">Follow the profile</span>
            <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">
              {inheritedChoice.source === 'project'
                ? 'The model saved on this project, whichever profile is selected.'
                : inheritedChoice.source === 'profile'
                  ? 'Changes with the profile. Pick one below to hold it steady instead.'
                  : `Nothing configured, so ${implementerLabel} picks for itself.`}
            </span>
            <span className="mt-1.5 block text-[10.5px] text-ink-faint">
              {inheritedChoice.model === null
                ? 'provider default'
                : `${agentModelLabel(inheritedChoice.model)} · ${
                    inheritedChoice.source === 'project' ? 'project default' : 'recommended'
                  }`}
            </span>
          </button>

          {models.map((option) => {
            const active = model === option.id;
            const optionEffort = resolveAgentEffort(option, selectedProfile.agentEffort);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setModel(option.id)}
                aria-pressed={active}
                className={`rounded border p-2.5 text-left transition-colors ${
                  active
                    ? 'border-accent bg-accent-soft'
                    : 'border-line-strong bg-surface-raised hover:bg-surface-hover'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span className="text-[12.5px] font-semibold">{option.label}</span>
                  {option.id === recommendedModel ? (
                    <span className="badge badge-accent">{selectedProfile.label}</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">
                  {option.description}
                </span>
                <span className="mt-1.5 block text-[10.5px] text-ink-faint">
                  {effortFootnote(optionEffort)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="border-t border-line px-3.5 py-2">
          <button
            type="button"
            className="btn btn-ghost text-[12px]"
            onClick={() => setShowCustomModel(!showCustomModel)}
            aria-expanded={showCustomModel}
          >
            {showCustomModel ? '▾' : '▸'} Another model
          </button>
          {showCustomModel ? (
            <div className="mt-2">
              <label className="label" htmlFor="run-model">
                Model id or alias
              </label>
              <input
                id="run-model"
                className="input input-mono"
                list="agent-model-options"
                value={model ?? ''}
                placeholder={inheritedChoice.model ?? 'leave blank to follow the profile'}
                onChange={(e) => setModel(e.target.value || null)}
              />
              <datalist id="agent-model-options">
                {models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </datalist>
              <p className="hint">
                Passed to {implementerLabel} as <code className="mono">--model</code>, verbatim.
                Use this for a model newer than this build knows about.
                {model !== null && findAgentModel(model) === null
                  ? ' Effort is left at the profile’s level, because there is nothing here that says what this model accepts.'
                  : ''}
              </p>
            </div>
          ) : null}
        </div>

        {effort.clamped ? (
          <p className="border-t border-line px-3.5 py-2 text-[12px] text-ink-muted">
            <span className="font-semibold text-accent">Effort adjusted</span> — {effort.reason}.
            The model you picked is kept; the profile’s dial moves to fit it.
          </p>
        ) : null}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">What will run</h2>
        </div>
        <div className="space-y-2 px-3.5 py-3 text-[12.5px]">
          <Row label="Mode">
            {WORK_MODE_LABELS[resolution.mode]}
            {resolution.automatic ? ` — chosen by Auto because ${resolution.reason}.` : '.'}
          </Row>
          {attachments.length > 0 ? (
            <Row label="Attachments">
              {attachments.length} file{attachments.length === 1 ? '' : 's'}, stored outside the
              worktree and listed to the{' '}
              {readOnly ? WORK_MODE_WORDING[resolution.mode].agentNoun : 'implementer'} by path, so
              it reads them with its own tools and they never enter the diff.
              {transformer !== 'none'
                ? ' The transformer sees only your text — it handles prose and never files.'
                : ''}
            </Row>
          ) : null}
          <Row label="Isolation">
            A new Git worktree on its own branch, from{' '}
            <code className="mono">{effectiveBase}</code>
            {repoState.currentBranch && effectiveBase === repoState.currentBranch
              ? ' (your current branch)'
              : ''}
            . Your checkout is not touched.
            {repoState.dirty ? ' Uncommitted work there is left alone.' : ''}
          </Row>
          <Row label={readOnly ? 'Agent' : 'Implementer'}>
            {implementerLabel}, in that worktree. If it is out of provider capacity, Dev Cockpit
            tries the next implementation fallback on its own model. Permission mode:{' '}
            {readOnly ? (
              <>
                <code className="mono">plan</code>, which refuses every edit.
              </>
            ) : (
              <>
                <code className="mono">{project.effectivePermissionMode}</code>
                {permissionModeAllowsCommands(project.effectivePermissionMode)
                  ? ' — it can run your checks itself.'
                  : ' — shell commands are refused, so it works blind.'}
              </>
            )}
          </Row>
          <Row label="Model">
            {modelChoice.model === null ? (
              <>{implementerLabel}&rsquo;s own default — nothing here pins one.</>
            ) : (
              <>
                {agentModelLabel(modelChoice.model)}{' '}
                <code className="mono">{modelChoice.model}</code>
                {modelChoice.source === 'run'
                  ? ', chosen for this run'
                  : modelChoice.source === 'project'
                    ? ', this project’s saved default'
                    : `, recommended by the ${selectedProfile.label} profile`}
                .{' '}
                {effort.clamped
                  ? `${effort.reason}.`
                  : effort.effort === null
                    ? 'No effort setting is sent.'
                    : `Effort ${effort.effort}.`}
              </>
            )}
          </Row>
          <Row label="Deliverable">
            {resolution.mode === 'ask'
              ? 'A written answer, stored as an artifact and shown on the run screen. No files change.'
              : resolution.mode === 'plan'
                ? 'A written plan, stored as an artifact and shown on the run screen. No files change.'
                : 'A diff on the run branch, plus the recorded result of every check.'}
          </Row>
          <Row label="Validation">
            {readOnly ? (
              'None — nothing changes, so there is nothing to check.'
            ) : configured.length === 0 ? (
              <span className="text-warn">
                Nothing configured — no checks will run.{' '}
                <a href={`/projects/${project.id}`} className="underline">
                  Configure commands
                </a>
                .
              </span>
            ) : (
              configured
                .filter((c) => c.profiles.length === 0 || c.profiles.includes(profile))
                .map((c) => VALIDATION_KIND_LABELS[c.kind])
                .join(', ') || 'Nothing for this profile'
            )}
          </Row>
          <Row label="Review">
            {readOnly
              ? `None — there is no diff to review. You read the ${wording.deliverable}.`
              : reviewer === 'none'
                ? 'None — findings are optional and off.'
                : selectedProfile.runReviewer
                  ? `${reviewers.find((r) => r.id === reviewer)?.label ?? reviewer}, read-only.`
                  : `Configured, but the ${selectedProfile.label} profile skips it.`}
          </Row>
          <Row label="Approval">
            Yours. Nothing is merged or pushed automatically.
            {readOnly ? ' This run can be switched to Build later without losing its session.' : ''}
          </Row>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-ghost text-[12px]"
        onClick={() => setShowAdvanced(!showAdvanced)}
        aria-expanded={showAdvanced}
      >
        {showAdvanced ? '▾' : '▸'} Providers and base ref
      </button>

      {showAdvanced ? (
        <div className="panel">
          <div className="space-y-3 px-3.5 py-3">
            <ProviderSelect
              id="implementer"
              label="Implementation agent"
              hint="Runs the task in the isolated worktree. If it runs out of provider capacity, the configured fallback is tried."
              options={implementers}
              value={implementer}
              onChange={(value) => {
                setImplementer(value);
                // A model id belongs to the provider that named it, so a pick
                // made for the old one is dropped rather than carried over.
                setModel(null);
              }}
            />

            <ProviderSelect
              id="transformer"
              label="Request transformer"
              hint="Turns your request into a specification. Optional; the run works without one."
              options={[
                {
                  id: 'none',
                  label: 'None — use the request as written',
                  requirement: '',
                  available: true,
                  detail: '',
                },
                ...transformers.filter((t) => t.id !== 'none'),
              ]}
              value={transformer}
              onChange={setTransformer}
            />

            <ProviderSelect
              id="reviewer"
              label="Independent reviewer"
              hint="Read-only second opinion on the diff. Findings never block readiness unless the project says so."
              options={[
                {
                  id: 'none',
                  label: 'None',
                  requirement: '',
                  available: true,
                  detail: '',
                },
                ...reviewers,
              ]}
              value={reviewer}
              onChange={setReviewer}
            />

            <div>
              <label className="label" htmlFor="base-ref">
                Base branch or commit
              </label>
              <input
                id="base-ref"
                className="input input-mono"
                value={baseRef}
                placeholder={project.defaultBranch}
                onChange={(e) => setBaseRef(e.target.value)}
              />
              <p className="hint">Blank uses the project default branch.</p>
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="rounded border border-fail/40 bg-fail-soft px-3 py-2 text-[12.5px] text-fail">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <span className="text-[11.5px] text-ink-faint">
          {request.trim().length === 0
            ? resolution.mode === 'ask'
              ? 'Type a question to continue'
              : 'Describe the task to continue'
            : ''}
        </span>
        <button
          type="button"
          className="btn btn-primary"
          disabled={submitting || request.trim().length === 0}
          onClick={() => void submit()}
        >
          {submitting
            ? 'Starting…'
            : resolution.mode === 'ask'
              ? 'Ask'
              : resolution.mode === 'plan'
                ? 'Start planning'
                : 'Start implementation'}
        </button>
      </div>
    </div>
  );
}

/**
 * The create-run body when files come with it.
 *
 * Named with the sanitised file name rather than the browser's, so what the
 * server stores is what the list in the form said it would.
 */
function buildMultipartBody(payload: string, files: readonly File[]): FormData {
  const form = new FormData();
  form.append('payload', payload);
  for (const file of files) {
    form.append('attachments', file, safeAttachmentFileName(file.name));
  }
  return form;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-20 shrink-0 text-ink-faint">{label}</span>
      <span className="min-w-0 flex-1 text-ink-muted">{children}</span>
    </div>
  );
}

function ProviderSelect({
  id,
  label,
  hint,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  options: ProviderOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = options.find((o) => o.id === value);

  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id} disabled={!option.available}>
            {option.label}
            {option.available ? '' : ' — unavailable'}
          </option>
        ))}
      </select>
      <p className="hint">
        {selected && !selected.available ? (
          <span className="text-warn">{selected.detail}</span>
        ) : selected?.requirement ? (
          selected.requirement
        ) : (
          hint
        )}
      </p>
    </div>
  );
}
