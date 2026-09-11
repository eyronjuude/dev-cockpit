import { isReadOnlyMode, WORK_MODE_LABELS, type ResolvedWorkMode } from '@/domain/modes';
import { VALIDATION_KIND_LABELS, VALIDATION_KINDS, type ValidationKind } from '@/domain/types';
import type { ValidationResultView } from '@/services/runs';
import type { ConfiguredValidation } from './use-run-stream';
import { formatDuration, OutcomeBadge } from './status';

/**
 * The validation scorecard.
 *
 * Grouped by kind, because that is the vocabulary in which absence is legible.
 * The six rows are always present and still distinguish three absences that
 * would otherwise look the same:
 *
 *  - not configured — no step claims this kind. Not a failure.
 *  - pending — a step exists but has not run yet.
 *  - skipped — configured, but a profile or a condition held it back.
 *
 * A pipeline may hold several steps of one kind, so a kind row summarises its
 * steps and lists them underneath. The summary takes the *worst* outcome among
 * them: a kind with one passing and one failing step has not passed, and a row
 * that said otherwise would be the exact lie this component exists to prevent.
 *
 * Steps carrying no kind are gathered under "Other checks" rather than forced
 * into a category they do not belong to.
 *
 * A read-only run gets none of that. Six rows reading "Pending" forever would
 * be a fourth kind of lie, so the mode is stated instead.
 */
export function Scorecard({
  validations,
  configured,
  attempt,
  mode,
}: {
  validations: readonly ValidationResultView[];
  configured: readonly ConfiguredValidation[];
  attempt: number | null;
  mode: ResolvedWorkMode;
}) {
  if (isReadOnlyMode(mode) && attempt === null) {
    return (
      <div className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Validation</h2>
          <span className="text-[11px] text-ink-faint">not applicable</span>
        </div>
        <p className="px-3.5 py-2.5 text-[12px] text-ink-muted">
          {WORK_MODE_LABELS[mode]} mode changes no files, so none of this project&rsquo;s{' '}
          {configured.length === 0 ? 'checks' : `${configured.length} configured step(s)`} were
          run. Switch the run to Build mode to have them run against an implementation.
        </p>
      </div>
    );
  }

  const current = attempt === null ? [] : validations.filter((v) => v.attempt === attempt);

  const resultsByKey = new Map<string, ValidationResultView>();
  for (const result of current) resultsByKey.set(result.stepKey, result);

  const groups = groupByKind(configured, current);
  const ungrouped = groups.get(null) ?? [];

  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Validation</h2>
        {attempt !== null && attempt > 0 ? (
          <span className="text-[11px] text-ink-faint">
            attempt {attempt}
            {attempt > 1 ? ' · latest' : ''}
          </span>
        ) : (
          <span className="text-[11px] text-ink-faint">not run yet</span>
        )}
      </div>

      <div className="divide-y divide-line">
        {VALIDATION_KINDS.map((kind) => (
          <KindRow
            key={kind}
            label={VALIDATION_KIND_LABELS[kind]}
            steps={groups.get(kind) ?? []}
            results={resultsByKey}
            fallback={current.find((v) => v.kind === kind && v.stepKey === kind)}
          />
        ))}
        {ungrouped.length > 0 ? (
          <KindRow
            label="Other checks"
            steps={ungrouped}
            results={resultsByKey}
            fallback={undefined}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * One kind, and every step tagged with it.
 *
 * A kind claimed by exactly one step renders as a single line, which is the
 * common case and the shape this panel has always had. Two or more get a
 * summary line and the steps beneath it.
 */
function KindRow({
  label,
  steps,
  results,
  fallback,
}: {
  label: string;
  steps: readonly ConfiguredValidation[];
  results: ReadonlyMap<string, ValidationResultView>;
  /** The stored `not_configured` placeholder, when no step claims this kind. */
  fallback: ValidationResultView | undefined;
}) {
  const rows = steps.map((step) => ({ step, result: results.get(step.key) }));
  const unset = steps.length === 0;

  const outcome = unset
    ? (fallback?.outcome ?? 'not_configured')
    : worstOutcome(rows.map((row) => row.result?.outcome ?? 'running'));
  const pending = !unset && rows.some((row) => row.result === undefined);
  const advisory = !unset && rows.every((row) => !row.step.blocking);

  const total = rows.reduce((acc, row) => acc + (row.result?.durationMs ?? 0), 0);

  return (
    <div className="px-3.5 py-2">
      <div className="flex items-center gap-2.5">
        <span
          className={`w-[5.25rem] shrink-0 text-[12.5px] font-medium ${
            unset ? 'text-ink-faint' : 'text-ink'
          }`}
        >
          {label}
        </span>

        {pending && outcome === 'running' ? (
          <span className="badge badge-idle">Pending</span>
        ) : (
          <OutcomeBadge outcome={outcome} />
        )}

        {steps.length > 1 ? (
          <span className="text-[11px] text-ink-faint">{steps.length} steps</span>
        ) : null}

        <div className="flex-1" />

        {total > 0 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
            {formatDuration(total)}
          </span>
        ) : null}
        {advisory ? (
          <span
            className="badge badge-idle shrink-0"
            title="A failure here does not block readiness"
          >
            advisory
          </span>
        ) : null}
      </div>

      <div className="mt-0.5 space-y-0.5 pl-[5.25rem]">
        {unset ? (
          <span className="text-[11px] text-ink-faint">No step configured for this kind</span>
        ) : (
          rows.map(({ step, result }) => (
            <StepLine
              key={step.key}
              step={step}
              result={result}
              showName={steps.length > 1}
            />
          ))
        )}
      </div>
    </div>
  );
}

function StepLine({
  step,
  result,
  showName,
}: {
  step: ConfiguredValidation;
  result: ValidationResultView | undefined;
  showName: boolean;
}) {
  const command = result?.command ?? step.command;
  return (
    <div>
      <div className="flex items-center gap-2">
        {showName ? (
          <>
            <span className="shrink-0 text-[11px] text-ink-muted">{step.label}</span>
            {result ? <OutcomeBadge outcome={result.outcome} /> : (
              <span className="badge badge-idle">Pending</span>
            )}
          </>
        ) : null}
        <code className="mono min-w-0 flex-1 truncate text-ink-faint" title={command}>
          {command}
        </code>
        {result?.exitCode !== null && result?.exitCode !== undefined ? (
          <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
            exit {result.exitCode}
          </span>
        ) : null}
        {showName && result?.durationMs !== null && result?.durationMs !== undefined ? (
          <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
            {formatDuration(result.durationMs)}
          </span>
        ) : null}
      </div>
      {result?.error ? <p className="mt-0.5 text-[11px] text-fail">{result.error}</p> : null}
    </div>
  );
}

/** Configured steps bucketed by kind, with kind-less steps under `null`. */
function groupByKind(
  configured: readonly ConfiguredValidation[],
  current: readonly ValidationResultView[],
): Map<ValidationKind | null, ConfiguredValidation[]> {
  const groups = new Map<ValidationKind | null, ConfiguredValidation[]>();
  for (const step of configured) {
    const bucket = groups.get(step.kind) ?? [];
    bucket.push(step);
    groups.set(step.kind, bucket);
  }

  // A run whose project has since been reconfigured still has result rows for
  // steps that are no longer configured. Dropping them would quietly hide a
  // failure, so they are shown under the kind they were recorded with.
  const known = new Set(configured.map((step) => step.key));
  for (const result of current) {
    if (known.has(result.stepKey)) continue;
    if (result.outcome === 'not_configured') continue;
    const bucket = groups.get(result.kind) ?? [];
    bucket.push({
      key: result.stepKey,
      label: result.stepLabel || result.stepKey,
      kind: result.kind,
      command: result.command ?? '',
      blocking: result.blocking,
    });
    groups.set(result.kind, bucket);
  }

  return groups;
}

/**
 * The outcome a group reports.
 *
 * Ordered worst-first. A kind whose steps disagree takes the worse of them,
 * because the summary has to be safe to trust at a glance — and "one of these
 * failed" is the fact that matters.
 */
const SEVERITY: readonly ValidationResultView['outcome'][] = [
  'error',
  'fail',
  'cancelled',
  'running',
  'skipped',
  'pass',
  'not_configured',
];

function worstOutcome(
  outcomes: readonly ValidationResultView['outcome'][],
): ValidationResultView['outcome'] {
  if (outcomes.length === 0) return 'not_configured';
  for (const candidate of SEVERITY) {
    if (outcomes.includes(candidate)) return candidate;
  }
  return 'not_configured';
}
