import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { retryIteration } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/** Re-runs the run's last implementation prompt, unchanged. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);
    const { ordinal, resuming } = retryIteration(runId);
    return { accepted: true, ordinal, resuming };
  });
}
