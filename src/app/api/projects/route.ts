import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { createProject, listProjects } from '@/services/projects';

export const dynamic = 'force-dynamic';

export function GET() {
  return handle(() => ({ projects: listProjects() }));
}

export function POST(request: Request) {
  return handle(async () => {
    assertLocalRequest(request);
    const body = await readJson(request);
    const project = await createProject(body as Parameters<typeof createProject>[0]);
    return { project };
  });
}
