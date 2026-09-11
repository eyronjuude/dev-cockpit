import { z } from 'zod';

import { startAutoConfigure } from '@/advisors/auto-configure';
import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { AppError } from '@/core/errors';
import { requireProject } from '@/services/projects';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string }> };

const schema = z.object({
  /** Advisor id. Omitted uses the project's stored provider. */
  provider: z.string().max(60).nullable().optional(),
});

/**
 * Drafts, saves and verifies this project's configuration.
 *
 * Unlike `suggest-setup`, this one writes. It is refused unless the project is
 * in `auto` mode, so turning it on is a deliberate act recorded against the
 * project rather than a query parameter anyone could pass.
 *
 * Returns a probe id straight away; the work continues in the background and
 * the form polls `GET .../probe/:probeId`.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { projectId } = await params;
    const project = requireProject(projectId);

    if (project.aiConfigMode !== 'auto') {
      throw new AppError(
        'This project is not set to let AI save and verify its configuration. Change the mode to Auto first.',
        { code: 'ai_config_not_auto' },
      );
    }

    const body = await readJson(request).catch(() => ({}));
    const { provider } = schema.parse(body ?? {});

    return { probeId: startAutoConfigure(projectId, provider ?? null) };
  });
}
