import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { assertLocalRequest, handle } from '@/app/api/_lib/handler';
import { AppError } from '@/core/errors';
import { attachmentsDir, isInside } from '@/core/paths';
import { isInlineViewableMime } from '@/domain/attachments';
import { isRunActive } from '@/orchestrator/orchestrator';
import { getRunAttachment, listAttachments, removeAttachment } from '@/services/attachments';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string; attachmentId: string }> };

/**
 * Serves an attachment: images and PDFs in the browser, everything else as a
 * download.
 *
 * The path is re-checked against the attachment root on every request rather
 * than trusted from the database row, so a tampered or stale row cannot be
 * used to read an arbitrary file off the machine. The attachment is looked up
 * through its run, so a link pairing one run with another's attachment is a
 * 404 rather than a served file.
 */
export async function GET(request: Request, { params }: Params) {
  const { runId, attachmentId } = await params;
  const attachment = getRunAttachment(runId, attachmentId);

  if (!attachment) return new Response('Attachment not found', { status: 404 });
  if (!isInside(attachmentsDir(), attachment.filePath)) {
    return new Response('Attachment path is outside the attachment root', { status: 403 });
  }
  if (!fs.existsSync(attachment.filePath)) {
    return new Response('The attachment file is no longer on disk', { status: 410 });
  }

  const stat = await fs.promises.stat(attachment.filePath);
  const download = new URL(request.url).searchParams.get('download') === '1';
  const inline = isInlineViewableMime(attachment.mimeType) && !download;

  const nodeStream = fs.createReadStream(attachment.filePath);
  const body = Readable.toWeb(nodeStream) as WebReadableStream<Uint8Array>;

  const headers: Record<string, string> = {
    'Content-Type': attachment.mimeType,
    'Content-Length': String(stat.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(
      attachment.fileName,
    )}"`,
    // An attachment is never rewritten: removing it is the only edit.
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };

  // An SVG served inline becomes a *document* when navigated to directly, and
  // a document can run script in this application's own origin — which drives
  // Claude Code and shell commands on this machine. Unlike the app's own
  // artifacts, an attachment is an arbitrary file, so this is a real control
  // rather than defence in depth. Scoped to SVG because sandboxing a PDF would
  // break the browser's own viewer.
  if (attachment.mimeType === 'image/svg+xml') {
    headers['Content-Security-Policy'] = 'sandbox';
  }

  return new Response(body as unknown as ReadableStream, { headers });
}

/** Detaches a file from the request and deletes it. */
export function DELETE(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId, attachmentId } = await params;

    if (isRunActive(runId)) {
      throw new AppError(
        'This run is working right now. Wait for it to stop before removing an attachment: the prompt it is using has already been built.',
        { status: 409, code: 'run_active' },
      );
    }

    await removeAttachment(runId, attachmentId);
    return { attachments: listAttachments(runId) };
  });
}
