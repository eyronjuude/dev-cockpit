import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { restartRun } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  agentProvider: z.string().trim().max(60).optional(),
  agentModel: z.string().trim().max(120).nullable().optional(),
});

/**
 * Stops the run, discards its worktree and runs the whole pipeline again.
 *
 * Awaited rather than detached, unlike every other run action: the cleanup can
 * fail — a locked worktree, an agent that will not exit — and the caller has to
 * hear about that rather than watch a run silently stay where it was.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const input = schema.parse(await readJson(request));
    requireRun(runId);
    const result = await restartRun(runId, input);
    return { accepted: true, ...result };
  });
}
