import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { AppError } from '@/core/errors';
import { isRunActive } from '@/orchestrator/orchestrator';
import { startRunPreview } from '@/services/previews';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/** Starts the project's development command inside the run worktree. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);
    if (isRunActive(runId)) {
      throw new AppError('Wait for the run to stop before starting a preview.', {
        code: 'busy',
      });
    }
    return { preview: await startRunPreview(runId) };
  });
}
