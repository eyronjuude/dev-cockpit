import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { retryIteration } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  agentProvider: z.string().trim().max(60).optional(),
  agentModel: z.string().trim().max(120).nullable().optional(),
});

/** Re-runs the run's last implementation prompt, unchanged. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const input = schema.parse(await readJson(request));
    requireRun(runId);
    const { ordinal, resuming } = retryIteration(runId, input);
    return { accepted: true, ordinal, resuming };
  });
}
