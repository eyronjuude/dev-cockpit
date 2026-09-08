import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
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
    const project = updateProject(projectId, body as Parameters<typeof updateProject>[1]);
    return { project };
  });
}
