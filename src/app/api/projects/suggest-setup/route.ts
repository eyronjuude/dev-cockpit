import { z } from 'zod';

import { suggestProjectSetup } from '@/advisors/suggest';
import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';

export const dynamic = 'force-dynamic';

const schema = z.object({
  repositoryPath: z.string().max(4_000),
  /** Advisor id. Omitted or unknown falls back to deterministic detection. */
  provider: z.string().max(60).nullable().optional(),
});

/**
 * Drafts the setup fields for a candidate repository.
 *
 * Read-only: it inspects manifests and may ask a model to refine what they
 * imply. It writes nothing and saves nothing — the response fills a form the
 * user reviews before saving.
 */
export function POST(request: Request) {
  return handle(async () => {
    assertLocalRequest(request);
    const { repositoryPath, provider } = schema.parse(await readJson(request));
    return suggestProjectSetup({ repositoryPath, provider: provider ?? null });
  });
}
