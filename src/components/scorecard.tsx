import { isReadOnlyMode, WORK_MODE_LABELS, type ResolvedWorkMode } from '@/domain/modes';
import { VALIDATION_KIND_LABELS, VALIDATION_KINDS, type ValidationKind } from '@/domain/types';
import type { ValidationResultView } from '@/services/runs';
import type { ConfiguredValidation } from './use-run-stream';
import { formatDuration, OutcomeBadge } from './status';

/**
 * The validation scorecard.
 *
 * Always shows all six kinds, and distinguishes three different absences that
 * would otherwise all look the same:
 *
 *  - not configured — the project never defined a command. Not a failure.
 *  - pending — a command exists but has not run yet.
 *  - skipped — configured, but excluded by the selected profile.
 *
 * Collapsing any of those into "fail" would make a gap in setup look like
 * broken code, which is the mistake this component exists to avoid.
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
          {configured.length === 0 ? 'checks' : `${configured.length} configured check(s)`} were
          run. Switch the run to Build mode to have them run against an implementation.
        </p>
      </div>
    );
  }

  const current =
    attempt === null ? [] : validations.filter((v) => v.attempt === attempt);
  const byKind = new Map<ValidationKind, ValidationResultView>();
  for (const result of current) byKind.set(result.kind, result);

  const configuredByKind = new Map<ValidationKind, ConfiguredValidation>();
  for (const command of configured) configuredByKind.set(command.kind, command);

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
        {VALIDATION_KINDS.map((kind) => {
          const result = byKind.get(kind);
          const command = configuredByKind.get(kind);

          // No stored row yet: pending if a command exists, otherwise unset.
          const outcome = result?.outcome ?? (command ? 'running' : 'not_configured');
          const pending = result === undefined && command !== undefined;
          const unset = command === undefined && result?.outcome !== 'pass';

          return (
            <div key={kind} className="px-3.5 py-2">
              <div className="flex items-center gap-2.5">
                <span
                  className={`w-[5.25rem] shrink-0 text-[12.5px] font-medium ${
                    unset ? 'text-ink-faint' : 'text-ink'
                  }`}
                >
                  {VALIDATION_KIND_LABELS[kind]}
                </span>

                {pending ? (
                  <span className="badge badge-idle">Pending</span>
                ) : (
                  <OutcomeBadge outcome={outcome} />
                )}

                <div className="flex-1" />

                {result?.exitCode !== null && result?.exitCode !== undefined ? (
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
                    exit {result.exitCode}
                  </span>
                ) : null}
                {result?.durationMs !== null && result?.durationMs !== undefined ? (
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
                    {formatDuration(result.durationMs)}
                  </span>
                ) : null}
                {(result && !result.blocking && result.outcome !== 'not_configured') ||
                (command && !command.blocking) ? (
                  <span
                    className="badge badge-idle shrink-0"
                    title="A failure here does not block readiness"
                  >
                    advisory
                  </span>
                ) : null}
              </div>

              <div className="mt-0.5 pl-[5.25rem]">
                {result?.command ?? command?.command ? (
                  <code
                    className="mono block truncate text-ink-faint"
                    title={result?.command ?? command?.command ?? ''}
                  >
                    {result?.command ?? command?.command}
                  </code>
                ) : (
                  <span className="text-[11px] text-ink-faint">
                    No command configured for this project
                  </span>
                )}
                {result?.error ? (
                  <p className="mt-0.5 text-[11px] text-fail">{result.error}</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
