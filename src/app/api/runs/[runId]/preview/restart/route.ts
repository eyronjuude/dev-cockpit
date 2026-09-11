import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { AppError } from '@/core/errors';
import { restartRunPreview } from '@/services/previews';
import { isRunActive } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/**
 * Stops and restarts this run's preview.
 *
 * One endpoint rather than two calls from the browser: sequencing it there
 * leaves a window where a failed stop still looks like a successful restart.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);
    if (isRunActive(runId)) {
      throw new AppError('Wait for the run to stop before restarting the preview.', {
        code: 'busy',
      });
    }
    return { preview: await restartRunPreview(runId) };
  });
}
