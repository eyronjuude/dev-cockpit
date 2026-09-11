/**
 * What a run changed, and what it cost to change it.
 *
 * A finished run already says which files moved. It has never said anything
 * about the shape of the work behind them, so two runs an order of magnitude
 * apart in cost look identical in the report and the difference goes
 * unexplained.
 *
 * Three numbers explain most of it, and none of them is the dollar figure:
 *
 *  - **average context per turn** — the transcript is re-sent on every turn,
 *    so cost grows with turns *and* with how large the session got. This is
 *    the number that separates a run that explored efficiently from one that
 *    filled its window early and then paid for it on every later turn.
 *  - **cache-read share** — how much of the token spend went on re-reading
 *    what the agent had already seen, rather than on producing anything.
 *  - **cost per turn** — the price of one unit of agent work, which is
 *    comparable across tasks in a way that cost per run is not.
 *
 * Deliberately expressed in tokens rather than money. Prices change and vary
 * by model; a share of tokens is a fact about the run that stays true, and the
 * provider's own `costUsd` is reported alongside it unchanged.
 *
 * Pure: no I/O, no database, no server-only imports. The orchestrator writes
 * the result into an event, the run screen renders the same function's output,
 * and neither can disagree with the other.
 */

export interface ImpactIteration {
  kind: string;
  status: string;
  numTurns: number | null;
  costUsd: number | null;
  settings: {
    model: string | null;
    effort: string | null;
    permissionMode: string | null;
  };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    thinkingTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
  } | null;
}

export interface ImpactInput {
  profile: string;
  /** The run's rolled-up cost, including the optional layers. */
  costUsd: number | null;
  iterations: readonly ImpactIteration[];
  changedFiles: readonly { additions: number; deletions: number }[];
  /** Latest attempt only. An older attempt is history, not the outcome. */
  validations: readonly { outcome: string; blocking: boolean }[];
  findings: readonly { severity: string }[];
}

export interface RunImpact {
  filesChanged: number;
  additions: number;
  deletions: number;

  checksPassed: number;
  checksFailed: number;
  /** Configured for the project but with no command set. */
  checksNotConfigured: number;
  findings: number;

  costUsd: number | null;
  turns: number;
  /** Null when no turn was recorded — dividing by zero helps nobody. */
  costPerTurn: number | null;

  /** Null when no provider on this run reported token counts. */
  tokens: {
    input: number;
    output: number;
    thinking: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  } | null;
  /** `cacheRead / turns`. Null without both. */
  avgContextTokens: number | null;
  /**
   * `cacheRead / total`, 0..1 — a share of *tokens*, not of cost.
   *
   * Kept because it is a fact about the run, but deliberately not in the
   * one-line summary: it measured 96-99% on every run in the sample, so it
   * distinguishes nothing and invites being read as a share of the bill.
   */
  cacheReadShare: number | null;

  settings: RunSettings;
}

export interface RunSettings {
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  profile: string;
}

const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

/**
 * The settings a run executed under.
 *
 * Taken from the last iteration that recorded any, because that is the one the
 * outcome belongs to. A run whose settings changed mid-flight — a mode switch,
 * a fallback to another provider — is described by what it finished with, and
 * `settingsChanged` between two runs is what surfaces the rest.
 */
function settingsOf(input: ImpactInput): RunSettings {
  const recorded = [...input.iterations]
    .reverse()
    .find((it) => it.settings.model || it.settings.effort || it.settings.permissionMode);
  return {
    model: recorded?.settings.model ?? null,
    effort: recorded?.settings.effort ?? null,
    permissionMode: recorded?.settings.permissionMode ?? null,
    profile: input.profile,
  };
}

export function summariseRunImpact(input: ImpactInput): RunImpact {
  const turns = sum(input.iterations.map((it) => it.numTurns));

  const reported = input.iterations.map((it) => it.usage).filter((u) => u !== null);
  const tokens =
    reported.length === 0
      ? null
      : (() => {
          const inputTokens = sum(reported.map((u) => u.inputTokens));
          const output = sum(reported.map((u) => u.outputTokens));
          const cacheRead = sum(reported.map((u) => u.cacheReadTokens));
          const cacheCreation = sum(reported.map((u) => u.cacheCreationTokens));
          return {
            input: inputTokens,
            output,
            thinking: sum(reported.map((u) => u.thinkingTokens)),
            cacheRead,
            cacheCreation,
            total: inputTokens + output + cacheRead + cacheCreation,
          };
        })();

  return {
    filesChanged: input.changedFiles.length,
    additions: sum(input.changedFiles.map((f) => f.additions)),
    deletions: sum(input.changedFiles.map((f) => f.deletions)),

    checksPassed: input.validations.filter((v) => v.outcome === 'pass').length,
    checksFailed: input.validations.filter((v) => v.outcome === 'fail' || v.outcome === 'error')
      .length,
    checksNotConfigured: input.validations.filter((v) => v.outcome === 'not_configured').length,
    findings: input.findings.filter((f) => BLOCKING_SEVERITIES.has(f.severity)).length,

    costUsd: input.costUsd,
    turns,
    costPerTurn: input.costUsd !== null && turns > 0 ? input.costUsd / turns : null,

    tokens,
    avgContextTokens: tokens && turns > 0 ? tokens.cacheRead / turns : null,
    cacheReadShare: tokens && tokens.total > 0 ? tokens.cacheRead / tokens.total : null,

    settings: settingsOf(input),
  };
}

/* ------------------------------------------------------------------ *
 * Which one changed
 * ------------------------------------------------------------------ */

export interface SettingChange {
  setting: keyof RunSettings;
  from: string | null;
  to: string | null;
}

/**
 * The settings that differ between two runs.
 *
 * The point of recording settings at all: when this run cost half what the
 * last one did, the first question is what was different, and answering it
 * from `profiles.ts` at read time would answer it wrongly the moment that file
 * is edited.
 *
 * A setting the earlier run never recorded is not reported as a change — the
 * runs from before this was captured would otherwise each look like a
 * deliberate reconfiguration.
 */
export function settingsChanged(
  current: RunSettings,
  previous: RunSettings | null,
): SettingChange[] {
  if (!previous) return [];
  const keys: (keyof RunSettings)[] = ['profile', 'model', 'effort', 'permissionMode'];
  return keys
    .filter((key) => previous[key] !== null && current[key] !== previous[key])
    .map((key) => ({ setting: key, from: previous[key], to: current[key] }));
}

/* ------------------------------------------------------------------ *
 * Wording
 * ------------------------------------------------------------------ */

const SETTING_LABELS: Record<keyof RunSettings, string> = {
  model: 'model',
  effort: 'effort',
  permissionMode: 'permission mode',
  profile: 'profile',
};

function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

function money(value: number): string {
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

/**
 * The report, as the lines a person reads.
 *
 * One function so the event message, the run screen and any later export say
 * the same thing. Anything the run did not record is left out rather than
 * printed as zero.
 */
export function describeRunImpact(impact: RunImpact, changes: readonly SettingChange[] = []): string[] {
  const lines: string[] = [];

  const files =
    impact.filesChanged === 0
      ? 'No files changed'
      : `${impact.filesChanged} file(s) changed, +${impact.additions}/-${impact.deletions}`;
  const checks =
    impact.checksPassed + impact.checksFailed === 0
      ? impact.checksNotConfigured > 0
        ? 'no checks configured'
        : 'no checks run'
      : `${impact.checksPassed} passed / ${impact.checksFailed} failed`;
  lines.push(
    `${files} · ${checks}${impact.findings > 0 ? ` · ${impact.findings} blocking finding(s)` : ''}`,
  );

  const cost: string[] = [];
  if (impact.costUsd !== null) cost.push(money(impact.costUsd));
  if (impact.turns > 0) cost.push(`${impact.turns} turns`);
  if (impact.costPerTurn !== null) cost.push(`${money(impact.costPerTurn)}/turn`);
  if (impact.avgContextTokens !== null) {
    cost.push(`avg context ${tokens(Math.round(impact.avgContextTokens))}`);
  }
  /**
   * Total, not the cache-read share. The share is 96-99% on every run measured,
   * so it separates nothing and reads like a share of cost, which it is not.
   * It stays on the object for anything that wants it; the line carries the
   * magnitude instead, which varies by an order of magnitude between runs.
   */
  if (impact.tokens) cost.push(`${tokens(impact.tokens.total)} tokens`);
  if (cost.length > 0) lines.push(cost.join(' · '));

  const settings = [
    impact.settings.model,
    `${impact.settings.profile} profile`,
    impact.settings.effort ? `effort ${impact.settings.effort}` : null,
    impact.settings.permissionMode,
  ].filter((s): s is string => Boolean(s));
  if (settings.length > 0) lines.push(settings.join(' · '));

  if (changes.length > 0) {
    lines.push(
      `Changed since the last run: ${changes
        .map((c) => `${SETTING_LABELS[c.setting]} ${c.from} → ${c.to}`)
        .join(', ')}`,
    );
  }

  return lines;
}
