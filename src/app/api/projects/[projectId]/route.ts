import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { recordRevision } from '@/services/config-revisions';
import { requireProject, updateProject } from '@/services/projects';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string }> };

export function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { projectId } = await params;
    return { project: requireProject(projectId) };
  });
}

export function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { projectId } = await params;
    const body = await readJson(request);

    // Before the write, not after. A history that only records what the
    // advisor did would be missing exactly the revision a user wants back
    // after they overwrite their own pipeline by accident.
    recordRevision(projectId, 'user', 'Replaced by an edit on the project form');

    const project = updateProject(projectId, body as Parameters<typeof updateProject>[1]);
    return { project };
  });
}
