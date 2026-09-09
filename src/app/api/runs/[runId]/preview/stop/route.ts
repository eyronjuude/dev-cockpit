import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { getRunPreview, stopRunPreview } from '@/services/previews';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/** Stops a running worktree preview for this run. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);
    const stopped = await stopRunPreview(runId);
    return { stopped, preview: getRunPreview(runId) };
  });
}
