import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { approveRun } from '@/orchestrator/orchestrator';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  note: z.string().trim().max(4_000).optional(),
  /** Creates a local commit on the run's own branch. Never merges or pushes. */
  createCommit: z.boolean().optional(),
  commitMessage: z.string().trim().max(2_000).optional(),
});

export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const body = schema.parse(await readJson(request));
    const run = await approveRun(runId, {
      note: body.note ?? null,
      createCommit: body.createCommit ?? true,
      commitMessage: body.commitMessage,
    });
    return { run: { id: run.id, status: run.status, commitSha: run.commitSha } };
  });
}
