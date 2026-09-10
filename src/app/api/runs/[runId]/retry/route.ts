import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { retryRun } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  agentProvider: z.string().trim().max(60).optional(),
  agentModel: z.string().trim().max(120).nullable().optional(),
});

/**
 * Picks a stopped run back up from wherever it stopped.
 *
 * Where the retry resumes is derived from the run's own stored state, not
 * chosen by the caller. The optional body only applies when that retry reruns
 * the implementation agent.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const input = schema.parse(await readJson(request));
    requireRun(runId);
    const plan = retryRun(runId, input);
    return {
      accepted: true,
      stage: plan.stage,
      reason: plan.reason,
      resumingSession: plan.resumesSession,
    };
  });
}
