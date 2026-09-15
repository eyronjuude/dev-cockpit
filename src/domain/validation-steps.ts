import {
  MAX_RETRIES,
  POSITION_STRIDE,
  VALIDATION_KINDS,
  type RetryOnMode,
  type RunWhenCondition,
  type ValidationKind,
  type ValidationOutcome,
} from './types';

/**
 * Pure rules for a project's validation pipeline.
 *
 * Everything here is a function of stored configuration and stored results, so
 * the engine, the readiness check, the probe and the browser can all reach the
 * same answer without one of them holding an opinion the others cannot see.
 *
 * Nothing in this file touches the filesystem, the database or a child
 * process. That is what makes the ordering and skipping rules testable without
 * a worktree.
 */

/** The subset of a configured step these rules need. */
export interface StepPlanInput {
  key: string;
  label: string;
  kind: ValidationKind | null;
  command: string;
  enabled: boolean;
  profiles: string[];
  position: number;
  runWhen: RunWhenCondition;
  runWhenArg: string | null;
  retries: number;
  retryOn: RetryOnMode;
}

/**
 * Substring path matching, shared with the UI-change policy.
 *
 * Deliberately not globbing. `touchesUi` has always matched this way, the
 * patterns users have already written are substrings, and a silent switch to
 * glob semantics would change what those stored patterns mean.
 */
export function matchesPathPatterns(
  paths: readonly string[],
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return false;
  const lowered = patterns.map((pattern) => pattern.toLowerCase()).filter(Boolean);
  if (lowered.length === 0) return false;
  return paths.some((value) => {
    const normalised = value.replace(/\\/g, '/').toLowerCase();
    return lowered.some((pattern) => normalised.includes(pattern));
  });
}

/**
 * What counts as a UI file when a project has named no patterns of its own.
 *
 * Here rather than in `services/runs`, which is `server-only`: the readiness
 * check, the E2E-for-UI policy and the Preview tab all need the same list, and
 * the browser cannot reach a server-only module to get it.
 */
export const DEFAULT_UI_PATTERNS: readonly string[] = [
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.css',
  '.scss',
  'components/',
  'pages/',
  'app/',
];

/**
 * Parses newline-separated `KEY=VALUE` pairs.
 *
 * The same shape `linkPaths` and `protectedBranches` already use, for the same
 * reason: it stays readable in any sqlite client. A line without `=`, or with
 * an empty key, is dropped rather than guessed at.
 */
export function parseEnvLines(value: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (value ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Serialises an environment map back to the stored line format. */
export function formatEnvLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * Values worth masking on sight, taken from a step's own environment.
 *
 * `redact` scans `process.env`, which a step's configured environment never
 * reaches — so without this the one place a user is most likely to put a
 * credential is the one place it would not be redacted.
 */
const SECRET_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|CREDENTIAL)/i;

export function secretValuesIn(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => value.length >= 4 && SECRET_NAME.test(name))
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

/** Configuration order: explicit position, then key, so ties are stable. */
export function orderSteps<T extends { position: number; key: string }>(steps: readonly T[]): T[] {
  return steps
    .slice()
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

/** The position a step appended to the end of a pipeline should take. */
export function nextPosition(steps: readonly { position: number }[]): number {
  const highest = steps.reduce((acc, step) => Math.max(acc, step.position), -POSITION_STRIDE);
  return highest + POSITION_STRIDE;
}

/** Renumbers a pipeline onto the stride, preserving the order given. */
export function renumber<T extends { position: number }>(steps: readonly T[]): T[] {
  return steps.map((step, index) => ({ ...step, position: index * POSITION_STRIDE }));
}

export type SkipReason =
  | { skipped: false }
  | { skipped: true; reason: string };

/**
 * Whether a step runs, given everything already known about this attempt.
 *
 * `outcomes` holds the steps that have already finished, keyed by step key —
 * which is why order is resolved before this is called rather than inside it.
 */
export function evaluateRunWhen(
  step: StepPlanInput,
  context: {
    changedPaths: readonly string[];
    outcomes: ReadonlyMap<string, ValidationOutcome>;
  },
): SkipReason {
  switch (step.runWhen) {
    case 'always':
      return { skipped: false };

    case 'changed_files_match': {
      const patterns = splitLines(step.runWhenArg);
      // A condition with no patterns would skip the step forever, which is a
      // configuration mistake rather than an instruction. Run it.
      if (patterns.length === 0) return { skipped: false };
      if (matchesPathPatterns(context.changedPaths, patterns)) return { skipped: false };
      return { skipped: true, reason: `no changed file matched ${patterns.join(', ')}` };
    }

    case 'depends_on': {
      const dependency = (step.runWhenArg ?? '').trim();
      if (!dependency) return { skipped: false };
      const outcome = context.outcomes.get(dependency);
      if (outcome === undefined) {
        return { skipped: true, reason: `${dependency} did not run` };
      }
      if (outcome === 'pass') return { skipped: false };
      return { skipped: true, reason: `${dependency} did not pass (${outcome})` };
    }

    default:
      return { skipped: false };
  }
}

/** Whether an outcome is worth another go, given the step's retry policy. */
export function shouldRetry(outcome: ValidationOutcome, retryOn: RetryOnMode): boolean {
  if (outcome === 'error') return retryOn === 'error' || retryOn === 'both';
  if (outcome === 'fail') return retryOn === 'fail' || retryOn === 'both';
  // `cancelled` is a decision, not a flake. `pass`, `skipped` and
  // `not_configured` have nothing to retry.
  return false;
}

export const clampRetries = (value: number): number =>
  Math.max(0, Math.min(MAX_RETRIES, Math.trunc(value)));

/**
 * Which of the six kinds a pipeline covers.
 *
 * Coverage is still reported per kind even though steps are free-form, because
 * that is the distinction the scorecard exists to draw: a project that never
 * set up E2E has not failed E2E. A step carrying no kind contributes to
 * nothing here — it is reported on its own terms instead.
 */
export function coveredKinds(steps: readonly StepPlanInput[]): Set<ValidationKind> {
  const covered = new Set<ValidationKind>();
  for (const step of steps) {
    if (!step.enabled) continue;
    if (!step.command.trim()) continue;
    if (step.kind) covered.add(step.kind);
  }
  return covered;
}

/** The six kinds no enabled step claims. Ordered as the scorecard renders them. */
export function uncoveredKinds(steps: readonly StepPlanInput[]): ValidationKind[] {
  const covered = coveredKinds(steps);
  return VALIDATION_KINDS.filter((kind) => !covered.has(kind));
}

/**
 * Turns a free-form label into a key.
 *
 * Keys reach a filename (`validation/attempt-1-<key>.log`) and a database
 * unique index, so the character set is narrow on purpose.
 */
export function slugifyStepKey(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);
  return slug || 'step';
}

/** Makes a key unique within a pipeline by suffixing a counter. */
export function uniqueStepKey(desired: string, taken: ReadonlySet<string>): string {
  const base = slugifyStepKey(desired);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1_000; n += 1) {
    const candidate = `${base.slice(0, 28)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 24)}-${Date.now().toString(36)}`;
}

export const STEP_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

function splitLines(value: string | null | undefined): string[] {
  return (value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export { splitLines as splitConditionArg };
