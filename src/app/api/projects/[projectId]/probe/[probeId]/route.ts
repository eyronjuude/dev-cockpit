import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { requireProbe } from '@/advisors/probe';
import { notFound } from '@/core/errors';
import { requireProject } from '@/services/projects';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string; probeId: string }> };

/**
 * Progress and outcome of one configuration probe.
 *
 * Polled rather than streamed. `events.run_id` is a NOT NULL foreign key to
 * `runs` and a probe has no run, so putting probe progress on the event bus
 * would mean either a nullable foreign key or a second event system — both
 * more than a progress line is worth.
 */
export function GET(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { projectId, probeId } = await params;
    requireProject(projectId);

    const probe = requireProbe(probeId);
    // A probe id from another project would otherwise be readable by guessing.
    if (probe.projectId !== projectId) throw notFound(`Probe ${probeId}`);

    return { probe };
  });
}
