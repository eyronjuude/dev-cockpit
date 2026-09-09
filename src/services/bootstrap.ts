import 'server-only';

import { ensureDataDirs } from '@/core/paths';
import { getDb } from '@/db/client';
import { scheduleExpirySweeps } from './expiry';
import { reconcileInterruptedRuns } from './runs';

/**
 * Process startup.
 *
 * Three jobs: make sure the data directory and schema exist, reconcile runs
 * that were active when the process last stopped, and start the retention
 * sweep. Child processes do not survive a restart, so a run left in
 * IMPLEMENTING is dead — saying so is more useful than a spinner that never
 * resolves.
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

  // Reconciliation first: a run this restart has just marked FAILED gets its
  // finished timestamp before retention judges how long ago it finished.
  // Asynchronous and never awaited — reclaiming disk must not delay the first
  // page render, and a sweep that throws leaves storage in place.
  scheduleExpirySweeps();
}
