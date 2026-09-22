import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { findingSeveritySchema } from '@/domain/types';
import { requireRun, updateRunFields } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  /** Null turns automation off, back to fully manual. */
  minSeverity: findingSeveritySchema.nullable(),
});

/**
 * Changes how a run's review findings get auto-addressed.
 *
 * Changeable at any time, including after findings already exist: it only
 * governs future review passes, and never rewrites past findings or events.
 */
export function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const { minSeverity } = schema.parse(await readJson(request));
    requireRun(runId);
    updateRunFields(runId, { reviewAutoAddressMinSeverity: minSeverity });
    return { reviewAutoAddressMinSeverity: minSeverity };
  });
}
