'use client';

import {
  EXECUTION_PROFILES,
  MAX_RETRIES,
  RETRY_ON_MODES,
  RUN_WHEN_CONDITIONS,
  RUN_WHEN_LABELS,
  VALIDATION_KIND_LABELS,
  VALIDATION_KINDS,
  type RetryOnMode,
  type RunWhenCondition,
  type ValidationKind,
} from '@/domain/types';
import { uniqueStepKey } from '@/domain/validation-steps';

/**
 * The editor for one step of a project's validation pipeline.
 *
 * Split out of the project form because a step carries a dozen fields and the
 * form was already long. The shape it edits lives here too, so the two cannot
 * drift.
 *
 * Collapsed by default to a name, a command and a position, because that is
 * what a pipeline is read as. Working directory, environment, conditions,
 * retries and profiles are one click away — most steps use none of them, and
 * putting them all on screen would bury the command.
 */

export interface StepState {
  key: string;
  label: string;
  /** Empty string means "no kind", which is legal and different from unset. */
  kind: ValidationKind | '';
  command: string;
  workingDir: string;
  env: string;
  timeoutMs: number;
  blocking: boolean;
  enabled: boolean;
  profiles: string[];
  runWhen: RunWhenCondition;
  runWhenArg: string;
  retries: number;
  retryOn: RetryOnMode;
  /** Open in the editor. Presentation only; never persisted. */
  expanded: boolean;
}

export const DEFAULT_STEP_TIMEOUT_MS = 900_000;

export const PROFILE_NAMES: string[] = EXECUTION_PROFILES.map((name) => name);

/** Sensible starting points, shown as placeholders only. */
export const PLACEHOLDERS: Record<ValidationKind, string> = {
  typecheck: 'npm run typecheck',
  lint: 'npm run lint',
  unit: 'npm test',
  integration: 'npm run test:integration',
  e2e: 'npx playwright test',
  build: 'npm run build',
};

export function blankStep(
  key: string,
  label: string,
  kind: ValidationKind | '' = '',
): StepState {
  return {
    key,
    label,
    kind,
    command: '',
    workingDir: '',
    env: '',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    blocking: true,
    enabled: true,
    profiles: [...PROFILE_NAMES],
    runWhen: 'always',
    runWhenArg: '',
    retries: 0,
    retryOn: 'error',
    expanded: true,
  };
}

/** A new step appended to a pipeline, with a key nothing else has taken. */
export function newStepFor(
  existing: readonly StepState[],
  kind: ValidationKind | '' = '',
): StepState {
  const taken = new Set(existing.map((step) => step.key));
  const label = kind ? VALIDATION_KIND_LABELS[kind] : 'New check';
  return blankStep(uniqueStepKey(label, taken), label, kind);
}

export function StepEditor({
  step,
  index,
  total,
  otherKeys,
  onChange,
  onRemove,
  onMove,
}: {
  step: StepState;
  index: number;
  total: number;
  otherKeys: readonly string[];
  onChange: (patch: Partial<StepState>) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const placeholder = step.kind ? PLACEHOLDERS[step.kind] : 'npm run something';

  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <span className="w-6 shrink-0 text-[11px] tabular-nums text-ink-faint">{index + 1}</span>

        <input
          className="input max-w-40"
          value={step.label}
          placeholder="Step name"
          onChange={(e) => onChange({ label: e.target.value })}
          aria-label={`Step ${index + 1} name`}
        />

        <input
          className="input input-mono flex-1"
          value={step.command}
          placeholder={placeholder}
          onChange={(e) => onChange({ command: e.target.value })}
          aria-label={`Step ${index + 1} command`}
        />

        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          title="Move earlier"
          aria-label={`Move ${step.label} earlier`}
        >
          &uarr;
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          title="Move later"
          aria-label={`Move ${step.label} later`}
        >
          &darr;
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => onChange({ expanded: !step.expanded })}
          aria-expanded={step.expanded}
        >
          {step.expanded ? 'Less' : 'More'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost text-fail"
          onClick={onRemove}
          aria-label={`Remove ${step.label}`}
        >
          Remove
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-4 pl-8">
        <label className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
          Kind
          <select
            className="input max-w-32"
            value={step.kind}
            onChange={(e) => onChange({ kind: e.target.value as ValidationKind | '' })}
            aria-label={`${step.label} kind`}
          >
            <option value="">none</option>
            {VALIDATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {VALIDATION_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-muted">
          <input
            type="checkbox"
            className="accent-accent"
            checked={step.blocking}
            onChange={(e) => onChange({ blocking: e.target.checked })}
          />
          blocks readiness on failure
        </label>

        <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-muted">
          <input
            type="checkbox"
            className="accent-accent"
            checked={step.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          enabled
        </label>
      </div>

      {step.expanded ? (
        <div className="ml-2 mt-3 space-y-3 border-l-2 border-line pl-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Working directory</label>
              <input
                className="input input-mono"
                value={step.workingDir}
                placeholder="(worktree root)"
                onChange={(e) => onChange({ workingDir: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Timeout (minutes)</label>
              <input
                className="input input-mono"
                value={String(Math.round(step.timeoutMs / 60_000))}
                inputMode="numeric"
                onChange={(e) =>
                  onChange({ timeoutMs: Math.max(1, Number(e.target.value) || 15) * 60_000 })
                }
              />
            </div>
          </div>

          <div>
            <label className="label">Environment</label>
            <textarea
              className="input input-mono min-h-14"
              value={step.env}
              placeholder="ONE_PER_LINE=value"
              onChange={(e) => onChange({ env: e.target.value })}
            />
            <p className="hint">
              One <span className="mono">KEY=VALUE</span> per line.{' '}
              <span className="mono">{'{runId}'}</span> and <span className="mono">{'{worktree}'}</span>{' '}
              (<span className="mono">run</span> or <span className="mono">landing</span>) name the
              worktree the check runs in. Secret-looking values are masked in captured output.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Run this step</label>
              <select
                className="input"
                value={step.runWhen}
                onChange={(e) =>
                  onChange({ runWhen: e.target.value as RunWhenCondition, runWhenArg: '' })
                }
                aria-label={`${step.label} condition`}
              >
                {RUN_WHEN_CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {RUN_WHEN_LABELS[condition]}
                  </option>
                ))}
              </select>

              {step.runWhen === 'changed_files_match' ? (
                <textarea
                  className="input input-mono mt-2 min-h-14"
                  value={step.runWhenArg}
                  placeholder={'src/components/\n.tsx'}
                  onChange={(e) => onChange({ runWhenArg: e.target.value })}
                  aria-label={`${step.label} path patterns`}
                />
              ) : null}

              {step.runWhen === 'depends_on' ? (
                <select
                  className="input mt-2"
                  value={step.runWhenArg}
                  onChange={(e) => onChange({ runWhenArg: e.target.value })}
                  aria-label={`${step.label} depends on`}
                >
                  <option value="">choose a step&hellip;</option>
                  {otherKeys.map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              ) : null}

              <p className="hint">
                A step held back records <span className="mono">skipped</span>, which never blocks
                readiness. Not running is not failing.
              </p>
            </div>

            <div>
              <label className="label">Retries</label>
              <div className="flex items-center gap-2">
                <input
                  className="input input-mono max-w-16"
                  value={String(step.retries)}
                  inputMode="numeric"
                  onChange={(e) =>
                    onChange({
                      retries: Math.max(0, Math.min(MAX_RETRIES, Number(e.target.value) || 0)),
                    })
                  }
                  aria-label={`${step.label} retries`}
                />
                <select
                  className="input"
                  value={step.retryOn}
                  onChange={(e) => onChange({ retryOn: e.target.value as RetryOnMode })}
                  aria-label={`${step.label} retry policy`}
                >
                  {RETRY_ON_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode === 'error'
                        ? 'when it could not run'
                        : mode === 'fail'
                          ? 'when it failed'
                          : 'either'}
                    </option>
                  ))}
                </select>
              </div>
              <p className="hint">
                Retrying a check that <em>failed</em> re-runs a suite that found something. Worth
                it for a genuinely flaky one, misleading otherwise.
              </p>
            </div>
          </div>

          <div>
            <label className="label">Profiles</label>
            <div className="flex flex-wrap gap-3">
              {EXECUTION_PROFILES.map((profile) => (
                <label
                  key={profile}
                  className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-muted"
                >
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={step.profiles.includes(profile)}
                    onChange={(e) =>
                      onChange({
                        profiles: e.target.checked
                          ? [...step.profiles, profile]
                          : step.profiles.filter((name) => name !== profile),
                      })
                    }
                  />
                  {profile}
                </label>
              ))}
            </div>
            <p className="hint">
              A step excluded by the selected profile records{' '}
              <span className="mono">skipped</span>.
            </p>
          </div>

          <p className="hint">
            Key <span className="mono">{step.key}</span> &mdash; results are matched across runs
            by this, so renaming the step does not orphan its history.
          </p>
        </div>
      ) : null}
    </div>
  );
}
