import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { isRunActive } from '@/orchestrator/orchestrator';
import { sweepExpiredRuns } from '@/services/expiry';

export const dynamic = 'force-dynamic';

const schema = z.object({
  /** Report what would be reclaimed and change nothing. */
  dryRun: z.boolean().optional(),
  /** Limit the sweep to one project. */
  projectId: z.string().trim().min(1).optional(),
});

/**
 * The retention sweep, on demand.
 *
 * `GET` always previews and `POST` acts, so the destructive verb is the only
 * one that removes anything. Both hand the sweep the orchestrator's live set:
 * a run can hold a finished status while its process winds down, and its
 * worktree is not free until that is over.
 */
export function GET(request: Request) {
  return handle(async () => {
    const projectId = new URL(request.url).searchParams.get('projectId') ?? undefined;
    return sweepExpiredRuns({ dryRun: true, projectId, isBusy: isRunActive });
  });
}

export function POST(request: Request) {
  return handle(async () => {
    assertLocalRequest(request);
    const body = schema.parse(await readJson(request));

    return sweepExpiredRuns({
      dryRun: body.dryRun ?? false,
      projectId: body.projectId,
      isBusy: isRunActive,
    });
  });
}
