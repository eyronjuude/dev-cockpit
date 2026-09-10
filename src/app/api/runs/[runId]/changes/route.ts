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
  /** Implementation agent/model for this next pass. */
  agentProvider: z.string().trim().max(60).optional(),
  agentModel: z.string().trim().max(120).nullable().optional(),
});

/**
 * Sends the run back to the implementer with feedback.
 *
 * Continues the existing agent session when one is recorded and the provider
 * is unchanged, so the implementation context built during the first pass is
 * not thrown away. A deliberate provider switch starts cold, because sessions
 * are provider-specific.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const { feedback, mode, agentProvider, agentModel } = schema.parse(await readJson(request));
    const run = requireRun(runId);
    requestChanges(run.id, feedback, { mode, agentProvider, agentModel });

    const selectedProvider = agentProvider?.trim() || run.agentProvider;
    return {
      accepted: true,
      resuming: run.agentSessionId !== null && selectedProvider === run.agentProvider,
      mode: mode ?? effectiveWorkMode(run),
    };
  });
}
