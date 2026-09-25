import { describe, expect, it } from 'vitest';

import { interpolateRunTokens } from '@/domain/env-tokens';

/**
 * `{runId}` and `{worktree}` in configured env values.
 *
 * The env fields are set once per project, so without tokens two runs going
 * at once shared one `DATABASE_URL` and migrated the same scratch database.
 */

const ctx = { runId: 'run_abc123', worktree: 'run' as const };

describe('interpolateRunTokens', () => {
  it('replaces both tokens, every occurrence', () => {
    expect(
      interpolateRunTokens(
        {
          DATABASE_URL: 'postgres://localhost/app_{runId}_{worktree}',
          LOG_PREFIX: '{runId}:{runId}',
        },
        ctx,
      ),
    ).toEqual({
      DATABASE_URL: 'postgres://localhost/app_run_abc123_run',
      LOG_PREFIX: 'run_abc123:run_abc123',
    });
  });

  it('names the landing worktree apart from the run worktree', () => {
    const env = { DATABASE_URL: 'app_{runId}_{worktree}' };

    expect(interpolateRunTokens(env, { ...ctx, worktree: 'landing' }).DATABASE_URL).toBe(
      'app_run_abc123_landing',
    );
  });

  it('leaves other braces alone', () => {
    const env = { JSON_CONFIG: '{"a":1}', OTHER: '{runid} {RUNID} {project}' };

    expect(interpolateRunTokens(env, ctx)).toEqual(env);
  });

  it('does not touch keys', () => {
    expect(interpolateRunTokens({ '{runId}': 'x' }, ctx)).toEqual({ '{runId}': 'x' });
  });

  it('returns a new object', () => {
    const env = { A: '{runId}' };
    interpolateRunTokens(env, ctx);

    expect(env.A).toBe('{runId}');
  });
});
