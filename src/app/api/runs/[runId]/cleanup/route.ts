import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { AppError } from '@/core/errors';
import { isRunActive } from '@/orchestrator/orchestrator';
import { cleanUpRunWorktrees } from '@/services/worktrees';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  /** Discards uncommitted changes in the worktrees. */
  force: z.boolean().optional(),
  /** Deletes the run and landing branches, when Git agrees nothing is unmerged. */
  deleteBranches: z.boolean().optional(),
});

/** Reclaims the worktrees of a run that is over. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const body = schema.parse(await readJson(request));

    if (isRunActive(runId)) {
      throw new AppError('Cancel the run before removing its worktrees.', { code: 'busy' });
    }

    return cleanUpRunWorktrees(runId, {
      force: body.force ?? false,
      deleteBranches: body.deleteBranches ?? true,
    });
  });
}
