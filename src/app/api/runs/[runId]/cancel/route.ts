import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { cancelRun } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/** Kills the run's in-flight process tree. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);
    const cancelled = cancelRun(runId);
    return { cancelled };
  });
}
