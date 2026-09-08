import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { DEFAULT_WORK_MODE, workModeSchema } from '@/domain/modes';
import { executionProfileSchema, runStatusSchema } from '@/domain/types';
import { startRun } from '@/orchestrator/orchestrator';
import { createRun, listRuns } from '@/services/runs';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handle(() => {
    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId') ?? undefined;
    const statusParam = url.searchParams.getAll('status');
    const statuses = statusParam
      .map((s) => runStatusSchema.safeParse(s))
      .flatMap((r) => (r.success ? [r.data] : []));

    return {
      runs: listRuns({
        projectId,
        statuses: statuses.length > 0 ? statuses : undefined,
      }),
    };
  });
}

const createSchema = z.object({
  projectId: z.string().min(1),
  request: z.string().trim().min(1).max(20_000),
  title: z.string().trim().max(200).optional(),
  profile: executionProfileSchema.optional(),
  mode: workModeSchema.optional(),
  transformer: z.string().max(60).optional(),
  reviewer: z.string().max(60).optional(),
  baseRef: z.string().max(200).optional(),
  /** Create the run without launching it. Used for review before starting. */
  startImmediately: z.boolean().optional(),
});

/**
 * Creates a run and, by default, starts it.
 *
 * The response returns as soon as the run is persisted and accepted. Actual
 * orchestration continues in the background and the UI follows it over SSE, so
 * a long implementation never depends on a held-open HTTP request.
 */
export function POST(request: Request) {
  return handle(async () => {
    assertLocalRequest(request);
    const input = createSchema.parse(await readJson(request));

    const run = createRun({
      projectId: input.projectId,
      request: input.request,
      title: input.title,
      profile: input.profile ?? 'standard',
      mode: input.mode ?? DEFAULT_WORK_MODE,
      transformer: input.transformer,
      reviewer: input.reviewer,
      baseRef: input.baseRef,
    });

    if (input.startImmediately !== false) {
      startRun(run.id);
    }

    return {
      run: {
        id: run.id,
        status: run.status,
        title: run.title,
        mode: run.mode,
        resolvedMode: run.resolvedMode,
      },
    };
  });
}
