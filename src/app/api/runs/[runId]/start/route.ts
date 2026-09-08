import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { startRun } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/** Starts a run that was created but not launched. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);
    startRun(runId);
    return { started: true };
  });
}
