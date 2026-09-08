import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { landRun } from '@/orchestrator/orchestrator';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/** Starts the approved-run landing flow. */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);
    landRun(runId);
    return { accepted: true };
  });
}
