import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import {
  isMultipart,
  readPayloadPart,
  readUploadedFiles,
  type UploadedFile,
} from '@/app/api/_lib/uploads';
import { DEFAULT_WORK_MODE, workModeSchema } from '@/domain/modes';
import { executionProfileSchema, runStatusSchema } from '@/domain/types';
import { getAgent, startRun } from '@/orchestrator/orchestrator';
import { addAttachments } from '@/services/attachments';
import { tryRecordImplementationMap } from '@/services/implementation-map';
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
  /** Overrides the project default and the profile's recommendation. */
  model: z.string().trim().max(120).optional(),
  mode: workModeSchema.optional(),
  agentProvider: z.string().trim().max(60).optional(),
  agentModel: z.string().trim().max(120).nullable().optional(),
  transformer: z.string().max(60).optional(),
  reviewer: z.string().max(60).optional(),
  baseRef: z.string().max(200).optional(),
  /** Create the run without launching it. Used for review before starting. */
  startImmediately: z.boolean().optional(),
});

/**
 * The submitted fields, and any files that came with them.
 *
 * A request with no attachments stays a plain JSON body — that is what every
 * existing caller sends, and multipart for the common case would be ceremony.
 * With attachments the same fields travel as a JSON `payload` part beside the
 * files, and are parsed by the same schema.
 */
async function readCreateRequest(
  request: Request,
): Promise<{ input: z.infer<typeof createSchema>; files: UploadedFile[] }> {
  if (!isMultipart(request)) {
    return { input: createSchema.parse(await readJson(request)), files: [] };
  }

  const form = await request.formData();
  const input = createSchema.parse(readPayloadPart(form));
  // No run exists yet, so nothing is already attached to count against.
  return { input, files: await readUploadedFiles(form, 0) };
}

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
    const { input, files } = await readCreateRequest(request);
    if (input.agentProvider?.trim()) getAgent(input.agentProvider);

    const run = createRun({
      projectId: input.projectId,
      request: input.request,
      title: input.title,
      profile: input.profile ?? 'standard',
      model: input.model,
      mode: input.mode ?? DEFAULT_WORK_MODE,
      agentProvider: input.agentProvider,
      agentModel: input.agentModel,
      transformer: input.transformer,
      reviewer: input.reviewer,
      baseRef: input.baseRef,
    });

    // Before the run is started, not after. The prompt handed to the agent is
    // built from the run as stored, so an attachment recorded a moment later
    // would be one the first iteration never saw.
    if (files.length > 0) await addAttachments(run.id, files);

    if (input.startImmediately !== false) {
      startRun(run.id);
    } else {
      // A run held in DRAFT never reaches the orchestrator, so it would be the
      // one run with no implementation map. It gets the "nothing has happened
      // yet" one instead; execution replaces it with a later pass.
      await tryRecordImplementationMap(run.id);
    }

    return {
      run: {
        id: run.id,
        status: run.status,
        title: run.title,
        mode: run.mode,
        resolvedMode: run.resolvedMode,
        attachmentCount: files.length,
      },
    };
  });
}
