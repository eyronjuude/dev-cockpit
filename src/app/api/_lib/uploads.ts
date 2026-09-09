import { AppError, invalid } from '@/core/errors';
import { attachmentRejection, safeAttachmentFileName } from '@/domain/attachments';

/**
 * Reading uploaded files off a multipart request.
 *
 * Shared by the two routes that accept attachments — creating a run with them
 * and adding them to one that exists — so both apply the same limits and
 * produce the same message when a file is refused.
 */

export interface UploadedFile {
  fileName: string;
  data: Uint8Array;
}

/** The part name both routes use for files. */
export const ATTACHMENT_FIELD = 'attachments';

/** The part name carrying the JSON fields alongside the files. */
export const PAYLOAD_FIELD = 'payload';

export function isMultipart(request: Request): boolean {
  return (request.headers.get('content-type') ?? '')
    .toLowerCase()
    .includes('multipart/form-data');
}

/**
 * The JSON fields of a multipart request.
 *
 * Files cannot travel in a JSON body and the existing request schemas are Zod
 * over JSON, so a multipart submission keeps its fields in one `payload` part
 * and the route parses that with the schema it already had.
 */
export function readPayloadPart(form: FormData): unknown {
  const payload = form.get(PAYLOAD_FIELD);
  if (typeof payload !== 'string') {
    throw invalid(
      `A multipart request must carry its fields as a JSON \`${PAYLOAD_FIELD}\` part.`,
    );
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new AppError(`The \`${PAYLOAD_FIELD}\` part must be valid JSON.`);
  }
}

/**
 * Uploaded files, validated before any of them is buffered.
 *
 * `File.size` is known without touching the bytes, so an oversized upload is
 * refused before it is read into memory. `existingCount` is how many the run
 * already holds, which is what makes the per-run limit count the total rather
 * than this batch.
 */
export async function readUploadedFiles(
  form: FormData,
  existingCount: number,
): Promise<UploadedFile[]> {
  const entries = form.getAll(ATTACHMENT_FIELD);
  const files: UploadedFile[] = [];

  for (const entry of entries) {
    // A browser posts a string for a text part. An empty one is what an
    // untouched file input serialises to, so it is skipped rather than refused.
    if (typeof entry === 'string') {
      if (entry.trim().length === 0) continue;
      throw invalid(`The \`${ATTACHMENT_FIELD}\` part must carry files, not text.`);
    }

    const fileName = safeAttachmentFileName(entry.name);
    const rejection = attachmentRejection(
      { fileName, bytes: entry.size },
      existingCount + files.length,
    );
    if (rejection) throw invalid(rejection);

    files.push({ fileName, data: new Uint8Array(await entry.arrayBuffer()) });
  }

  return files;
}
