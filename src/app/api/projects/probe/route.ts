import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { probeRepository } from '@/services/projects';

export const dynamic = 'force-dynamic';

const schema = z.object({ repositoryPath: z.string().max(4_000) });

/** Validates a candidate repository path before the project form is submitted. */
export function POST(request: Request) {
  return handle(async () => {
    assertLocalRequest(request);
    const { repositoryPath } = schema.parse(await readJson(request));
    return probeRepository(repositoryPath);
  });
}
