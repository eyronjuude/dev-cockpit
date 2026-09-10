import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { startRun } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  agentProvider: z.string().trim().max(60).optional(),
  agentModel: z.string().trim().max(120).nullable().optional(),
});

/** Starts a run that was created but not launched. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const input = schema.parse(await readJson(request));
    requireRun(runId);
    startRun(runId, input);
    return { started: true };
  });
}
