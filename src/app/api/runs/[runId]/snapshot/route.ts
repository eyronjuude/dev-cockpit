import { handle } from '@/app/api/_lib/handler';
import { notFound } from '@/core/errors';
import { buildRunSnapshot } from '@/services/run-snapshot';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/**
 * The full current state of a run.
 *
 * The event stream tells the client that something changed; this tells it what
 * the state now is. Keeping the two separate means the UI never has to rebuild
 * run state by folding events, which is where drift creeps in.
 *
 * Assembled by the same function that server-renders the page, so the two can
 * never carry different fields.
 */
export function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { runId } = await params;
    const snapshot = buildRunSnapshot(runId);
    if (!snapshot) throw notFound('Run');
    return snapshot;
  });
}
