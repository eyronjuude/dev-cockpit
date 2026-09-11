import 'server-only';

import { eq } from 'drizzle-orm';

import { configProbes } from '@/db/schema';

import { ensureDataDirs } from '@/core/paths';
import { getDb } from '@/db/client';
import { sweepAbandonedProbes } from '@/git/probe';
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

  // A configuration probe holds no state across a restart, so anything left in
  // the probe root is debris from a process that died mid-probe. Nothing else
  // would ever find it: the retention sweep walks runs, and a probe has none.
  void sweepAbandonedProbes()
    .then((removed) => {
      if (removed > 0) {
        console.info(`[dev-cockpit] Removed ${removed} abandoned configuration probe(s).`);
      }
    })
    .catch(() => {
      // Left for the next start rather than failing this one.
    });

  // Marks probes that were running when the process stopped, for the same
  // reason interrupted runs are marked: a spinner that never resolves is worse
  // than a plain statement that it died.
  reconcileInterruptedProbes();
}

function reconcileInterruptedProbes(): void {
  getDb()
    .update(configProbes)
    .set({
      status: 'failed',
      phase: 'failed',
      error: 'Interrupted by a restart. Nothing was left behind; run it again.',
      finishedAt: new Date().toISOString(),
    })
    .where(eq(configProbes.status, 'running'))
    .run();
}
