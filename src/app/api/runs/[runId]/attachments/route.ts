import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { isMultipart, readUploadedFiles } from '@/app/api/_lib/uploads';
import { AppError } from '@/core/errors';
import { isRunActive } from '@/orchestrator/orchestrator';
import {
  addAttachments,
  canModifyAttachments,
  listAttachments,
} from '@/services/attachments';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

/** What is attached to this request, and whether the list can still change. */
export function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { runId } = await params;
    requireRun(runId);
    return {
      attachments: listAttachments(runId),
      mutable: canModifyAttachments(runId) && !isRunActive(runId),
    };
  });
}

/**
 * Attaches files to a request that already exists.
 *
 * The point of allowing this after creation is the follow-up: a screenshot of
 * the bug that came back, attached before "request changes" is pressed, is
 * read by the next iteration.
 *
 * Refused while the run is active. The status gate in the service covers this
 * already — an implementing run is not in a mutable status — but an in-flight
 * run is checked directly too, because the prompt for the current iteration is
 * built by then and a file arriving now would look accepted while reaching
 * nothing.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    requireRun(runId);

    if (isRunActive(runId)) {
      throw new AppError(
        'This run is working right now. Wait for it to stop before attaching anything: the prompt it is using has already been built.',
        { status: 409, code: 'run_active' },
      );
    }

    if (!isMultipart(request)) {
      throw new AppError('Attachments must be uploaded as a multipart/form-data request.');
    }

    const form = await request.formData();
    const existing = listAttachments(runId);
    const files = await readUploadedFiles(form, existing.length);

    if (files.length === 0) {
      throw new AppError('No files were included in the upload.');
    }

    const added = await addAttachments(runId, files);
    return { added, attachments: listAttachments(runId) };
  });
}
