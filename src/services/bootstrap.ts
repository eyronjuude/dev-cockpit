import 'server-only';

import { ensureDataDirs } from '@/core/paths';
import { getDb } from '@/db/client';
import { reconcileInterruptedRuns } from './runs';

/**
 * Process startup.
 *
 * Two jobs: make sure the data directory and schema exist, and reconcile runs
 * that were active when the process last stopped. Child processes do not
 * survive a restart, so a run left in IMPLEMENTING is dead — saying so is more
 * useful than a spinner that never resolves.
 *
 * Idempotent, and guarded on globalThis so Next's dev-mode module reloading
 * does not re-run it and clobber a live run.
 */

const GLOBAL_KEY = '__devCockpitBootstrapped__' as const;
type GlobalWithFlag = typeof globalThis & { [GLOBAL_KEY]?: boolean };

export function bootstrap(): void {
  const g = globalThis as GlobalWithFlag;
  if (g[GLOBAL_KEY]) return;
  g[GLOBAL_KEY] = true;

  ensureDataDirs();
  // Opening the database applies any pending migrations.
  getDb();

  const reconciled = reconcileInterruptedRuns();
  if (reconciled > 0) {
    console.info(
      `[dev-cockpit] Marked ${reconciled} run(s) as interrupted by the previous shutdown.`,
    );
  }
}
