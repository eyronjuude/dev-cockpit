import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { rejectRun } from '@/orchestrator/orchestrator';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  note: z.string().trim().max(4_000).optional(),
  /** Removes the worktree and deletes the branch when it holds no commits. */
  cleanUp: z.boolean().optional(),
});

export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const body = schema.parse(await readJson(request));
    const run = await rejectRun(runId, {
      note: body.note ?? null,
      cleanUp: body.cleanUp ?? false,
    });
    return { run: { id: run.id, status: run.status } };
  });
}
