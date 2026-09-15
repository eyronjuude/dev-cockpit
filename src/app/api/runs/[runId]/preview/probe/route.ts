import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { normalisePreviewPath } from '@/domain/preview-targets';
import { probePreviewPaths } from '@/services/previews';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  paths: z.array(z.string().max(2_000)).max(16),
});

/**
 * Checks which of a set of candidate paths this run's preview actually serves.
 *
 * The candidates come from an implementer's closing message, so they are
 * re-validated here rather than trusted from the client: the same guard
 * `domain/preview-targets` applies when parsing them, applied again at the
 * boundary that turns one into an outbound request.
 *
 * A path that does not answer is reported, not removed. A 404 on a page the
 * implementer named usually means the route takes a parameter or sits behind a
 * login, and hiding it would hide that too.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);

    const { paths } = schema.parse(await readJson(request));
    const safe = paths
      .map((path) => normalisePreviewPath(path))
      .filter((path): path is string => path !== null);

    return { unreachable: await probePreviewPaths(runId, safe) };
  });
}
