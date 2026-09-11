import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { listRevisions, revertToRevision } from '@/services/config-revisions';
import { requireProject } from '@/services/projects';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string }> };

/** The configuration history, newest first. */
export function GET(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { projectId } = await params;
    requireProject(projectId);
    return { revisions: listRevisions(projectId) };
  });
}

const revertSchema = z.object({ revisionId: z.string().min(1).max(80) });

/**
 * Puts a stored configuration back.
 *
 * This is the undo behind letting the advisor save on its own, and it takes a
 * revision of its own first — realising you wanted the thing you reverted away
 * from is the usual second move.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { projectId } = await params;
    requireProject(projectId);
    const { revisionId } = revertSchema.parse(await readJson(request));
    return { project: revertToRevision(projectId, revisionId) };
  });
}
