import 'server-only';

import { asc, eq } from 'drizzle-orm';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { getDb } from '@/db/client';
import { attachments, runs } from '@/db/schema';
import { newAttachmentId } from '@/core/ids';
import { AppError, invalid, notFound } from '@/core/errors';
import { attachmentsDir, ensureDir, isInside, runAttachmentDir } from '@/core/paths';
import {
  attachmentMimeType,
  attachmentRejection,
  attachmentsMutable,
  isInlineViewableMime,
  safeAttachmentFileName,
} from '@/domain/attachments';
import type { RunStatus } from '@/domain/types';
import { appendEvent } from './events';

/**
 * Files the developer attached to a request.
 *
 * Metadata in SQLite, bytes on disk, matching how artifacts are stored — but
 * under their own root, because an attachment is the only copy the app holds
 * of something the user supplied. See `core/paths.ts`.
 *
 * Nothing here imports `services/runs`: run state is read straight off the
 * `runs` table. `services/runs` hydrates attachments into `RunView`, and one
 * of the two directions has to stay free of the other.
 */

export interface AttachmentView {
  id: string;
  runId: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  bytes: number;
  createdAt: string;
  /** False when the file has been removed from disk since it was recorded. */
  exists: boolean;
  /** Whether the browser may show it rather than download it. */
  inlineViewable: boolean;
}

function hydrate(row: typeof attachments.$inferSelect): AttachmentView {
  const exists = fs.existsSync(row.filePath);
  return {
    id: row.id,
    runId: row.runId,
    fileName: row.fileName,
    filePath: row.filePath,
    mimeType: row.mimeType,
    bytes: row.bytes,
    createdAt: row.createdAt,
    exists,
    inlineViewable: exists && isInlineViewableMime(row.mimeType),
  };
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export function listAttachments(runId: string): AttachmentView[] {
  const db = getDb();
  return db
    .select()
    .from(attachments)
    .where(eq(attachments.runId, runId))
    .orderBy(asc(attachments.createdAt), asc(attachments.id))
    .all()
    .map(hydrate);
}

export function getAttachment(id: string): AttachmentView | null {
  const db = getDb();
  const row = db.select().from(attachments).where(eq(attachments.id, id)).get();
  return row ? hydrate(row) : null;
}

/**
 * An attachment, but only if it belongs to the run named in the URL.
 *
 * Every route addresses an attachment through its run, so a mismatched pair is
 * a bug or a stale link rather than something to serve anyway.
 */
export function getRunAttachment(runId: string, attachmentId: string): AttachmentView | null {
  const attachment = getAttachment(attachmentId);
  if (!attachment || attachment.runId !== runId) return null;
  return attachment;
}

/** Run status, read without going through `services/runs`. */
function runStatus(runId: string): RunStatus {
  const db = getDb();
  const row = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
  if (!row) throw notFound(`Run ${runId}`);
  return row.status as RunStatus;
}

/** Whether this run's attachments may still be added to or removed. */
export function canModifyAttachments(runId: string): boolean {
  return attachmentsMutable(runStatus(runId));
}

function assertModifiable(runId: string): void {
  const status = runStatus(runId);
  if (attachmentsMutable(status)) return;
  throw new AppError(
    `Attachments cannot be changed while this run is ${status}. They are an input to the request, and this run has already moved past reading them.`,
    { status: 409, code: 'attachments_locked' },
  );
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

export interface AddAttachmentInput {
  runId: string;
  /** The name as the browser reported it. Sanitised before use. */
  fileName: string;
  data: Uint8Array;
}

/**
 * Records one attachment: bytes to disk, a row in SQLite, an event in the log.
 *
 * The bytes are written verbatim. Text artifacts are redacted on the way in
 * because they are machine output that may have picked up a secret; an
 * attachment is a file the developer chose to hand over, and rewriting it
 * would corrupt a screenshot and falsify a log.
 */
export async function addAttachment(input: AddAttachmentInput): Promise<AttachmentView> {
  const { runId, data } = input;
  assertModifiable(runId);

  const fileName = safeAttachmentFileName(input.fileName);
  const bytes = data.byteLength;

  const rejection = attachmentRejection({ fileName, bytes }, listAttachments(runId).length);
  if (rejection) throw invalid(rejection);

  // The run id reaches here from a URL segment. `assertModifiable` has already
  // 404'd an id no run has, so this cannot trip today — but the next line
  // creates a directory, and a check before an mkdir costs nothing.
  const dir = runAttachmentDir(runId);
  if (!isInside(attachmentsDir(), dir)) {
    throw new AppError(`Attachment directory escapes the attachment root: ${runId}`, {
      code: 'unsafe_path',
    });
  }
  ensureDir(dir);

  const id = newAttachmentId();

  // The id prefix guarantees uniqueness, so attaching two files with the same
  // name keeps both, and makes the row a file is recorded in obvious on disk.
  const target = path.resolve(dir, `${id}__${fileName}`);
  if (!isInside(dir, target)) {
    // Unreachable while `safeAttachmentFileName` strips separators. Kept
    // because the check is cheap and the consequence of it being wrong is a
    // write anywhere on the machine.
    throw new AppError(`Attachment file name escapes the run directory: ${fileName}`, {
      code: 'unsafe_path',
    });
  }

  await fsp.writeFile(target, data);

  const mimeType = attachmentMimeType(fileName);
  const db = getDb();
  const row = db
    .insert(attachments)
    .values({ id, runId, fileName, filePath: target, mimeType, bytes })
    .returning()
    .get();

  if (!row) throw new Error('Failed to record attachment');

  appendEvent({
    runId,
    type: 'attachment.added',
    message: `Attachment: ${fileName}`,
    payload: { attachmentId: id, fileName, mimeType, bytes },
  });

  return hydrate(row);
}

/**
 * Adds several attachments, stopping at the first one that cannot be taken.
 *
 * Sequential rather than concurrent on purpose: the per-run count limit is
 * checked against what is already stored, and a parallel batch would race past
 * it. Files accepted before the failure are kept — they are already recorded
 * and the caller is told which one broke.
 */
export async function addAttachments(
  runId: string,
  files: readonly { fileName: string; data: Uint8Array }[],
): Promise<AttachmentView[]> {
  const added: AttachmentView[] = [];
  for (const file of files) {
    added.push(await addAttachment({ runId, fileName: file.fileName, data: file.data }));
  }
  return added;
}

/** Removes one attachment: the row, the file, and a line in the event log. */
export async function removeAttachment(runId: string, attachmentId: string): Promise<void> {
  const attachment = getRunAttachment(runId, attachmentId);
  if (!attachment) throw notFound('Attachment');
  assertModifiable(runId);

  // Re-checked against the root rather than trusted from the row: a tampered
  // or stale `file_path` must not turn a delete into an arbitrary unlink.
  if (isInside(attachmentsDir(), attachment.filePath)) {
    await fsp.rm(attachment.filePath, { force: true });
  }

  const db = getDb();
  db.delete(attachments).where(eq(attachments.id, attachmentId)).run();

  appendEvent({
    runId,
    type: 'attachment.removed',
    message: `Attachment removed: ${attachment.fileName}`,
    payload: { attachmentId, fileName: attachment.fileName },
  });
}

/**
 * Deletes every attachment file for a run.
 *
 * Not called by artifact retention, which is about disk spent on evidence.
 * This exists for the paths that discard a run outright.
 */
export async function purgeRunAttachments(runId: string): Promise<void> {
  const dir = runAttachmentDir(runId);
  if (!isInside(attachmentsDir(), dir)) return;
  await fsp.rm(dir, { recursive: true, force: true });
  const db = getDb();
  db.delete(attachments).where(eq(attachments.runId, runId)).run();
}
