import { handle } from '@/app/api/_lib/handler';
import { projectLandingQueue } from '@/services/landing-queue';
import { requireProject } from '@/services/projects';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string }> };

/**
 * The project's landing queue as it stands right now.
 *
 * Polled rather than streamed. This lives in process memory and changes
 * without writing a run event, so there is nothing for the run event stream
 * to carry.
 */
export function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { projectId } = await params;
    return projectLandingQueue(requireProject(projectId));
  });
}
