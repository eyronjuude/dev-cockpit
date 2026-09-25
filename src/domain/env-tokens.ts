/**
 * Per-run tokens in configured `KEY=VALUE` values.
 *
 * Every env field is set once, on the project or on a step, but runs happen
 * in parallel. Without a way to name the run, two runs got the same
 * `DATABASE_URL` and migrated the same scratch database — each seeing the
 * other's half-applied schema.
 *
 *  - `{runId}` — the run's id, e.g. `run_mugft89u3f2a1b4c5d`. Lowercase
 *    letters, digits and one underscore, so it is a valid Postgres identifier
 *    and file name as it stands.
 *  - `{worktree}` — `run` or `landing`. The landing worktree merges the
 *    target branch in, so it needs a fresh database of its own: reusing the
 *    run's would put the target's newer migrations behind ones already
 *    applied, and a migrator that tracks the last applied entry skips them.
 *
 * Exact, case-sensitive matches only. Anything else in braces — JSON, a
 * template the project resolves itself — passes through untouched. Only
 * values are rewritten; a key is a name, not a place to put a run id.
 */

export type WorktreeKind = 'run' | 'landing';

export interface RunTokenContext {
  runId: string;
  worktree: WorktreeKind;
}

const TOKEN = /\{(runId|worktree)\}/g;

export function interpolateRunTokens(
  env: Record<string, string>,
  context: RunTokenContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(TOKEN, (_, name: 'runId' | 'worktree') => context[name]);
  }
  return out;
}
