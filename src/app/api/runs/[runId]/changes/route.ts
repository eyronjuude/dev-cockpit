import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { effectiveWorkMode, resolvedWorkModeSchema } from '@/domain/modes';
import { requestChanges } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  feedback: z.string().trim().min(1).max(20_000),
  /**
   * Run this iteration in a different mode. Omitted keeps the run's current
   * mode, which is what "Request changes" does.
   */
  mode: resolvedWorkModeSchema.optional(),
});

/**
 * Sends the run back to the implementer with feedback.
 *
 * Continues the existing agent session when one is recorded, so the
 * implementation context built during the first pass is not thrown away. That
 * is also what makes a mode switch worth having: "implement this plan" resumes
 * the session that wrote the plan rather than starting cold.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const { feedback, mode } = schema.parse(await readJson(request));
    const run = requireRun(runId);
    requestChanges(run.id, feedback, { mode });
    return {
      accepted: true,
      resuming: run.agentSessionId !== null,
      mode: mode ?? effectiveWorkMode(run),
    };
  });
}
