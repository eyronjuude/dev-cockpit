import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { retryRun } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/**
 * Picks a stopped run back up from wherever it stopped.
 *
 * Takes no body: where the retry resumes is derived from the run's own stored
 * state, not chosen by the caller, so the client cannot ask for a resumption
 * the recorded evidence does not support. The plan is returned so the UI can
 * report what actually happened.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);
    const plan = retryRun(runId);
    return {
      accepted: true,
      stage: plan.stage,
      reason: plan.reason,
      resumingSession: plan.resumesSession,
    };
  });
}
