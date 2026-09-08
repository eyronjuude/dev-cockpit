import 'server-only';

import { asc, eq } from 'drizzle-orm';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { getDb } from '@/db/client';
import { artifacts } from '@/db/schema';
import { newArtifactId } from '@/core/ids';
import { AppError } from '@/core/errors';
import { artifactsDir, ensureDir, isInside, runArtifactDir } from '@/core/paths';
import { redactText } from '@/core/redact';
import { ARTIFACT_KIND_LABELS, type ArtifactKind } from '@/domain/types';
import { appendEvent } from './events';

export interface ArtifactView {
  id: string;
  runId: string;
  kind: ArtifactKind;
  label: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  previewUrl: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  /** False when the file has been removed from disk since it was recorded. */
  exists: boolean;
  /** Whether the UI can render it inline. */
  inlineViewable: boolean;
}

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = [
  'application/json',
  'application/x-ndjson',
  'application/xml',
  'application/javascript',
];

export function isTextMime(mime: string): boolean {
  return (
    TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix)) || TEXT_MIME_EXACT.includes(mime)
  );
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

function hydrate(row: typeof artifacts.$inferSelect): ArtifactView {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.meta) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const exists = fs.existsSync(row.filePath);
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as ArtifactKind,
    label: row.label,
    filePath: row.filePath,
    fileName: path.basename(row.filePath),
    mimeType: row.mimeType,
    bytes: row.bytes,
    previewUrl: row.previewUrl,
    meta,
    createdAt: row.createdAt,
    exists,
    inlineViewable: exists && (isTextMime(row.mimeType) || isImageMime(row.mimeType)),
  };
}

export interface WriteTextArtifactInput {
  runId: string;
  kind: ArtifactKind;
  label?: string;
  /** Relative to the run's artifact directory. */
  fileName: string;
  content: string;
  mimeType?: string;
  previewUrl?: string | null;
  meta?: Record<string, unknown>;
  /** Text artifacts are redacted by default; set false only for binary paths. */
  redactContent?: boolean;
}

/**
 * Records an artifact as a first-class row plus a file on disk.
 *
 * Metadata lives in SQLite and bytes live on the filesystem, so the database
 * stays small enough to open by hand while a Playwright trace can still be
 * hundreds of megabytes.
 */
export async function writeTextArtifact(input: WriteTextArtifactInput): Promise<ArtifactView> {
  const {
    runId,
    kind,
    fileName,
    content,
    mimeType = 'text/plain',
    previewUrl = null,
    meta = {},
    redactContent = true,
  } = input;

  const dir = ensureDir(runArtifactDir(runId));
  const target = path.resolve(dir, fileName);
  if (!isInside(dir, target)) {
    throw new AppError(`Artifact file name escapes the run directory: ${fileName}`, {
      code: 'unsafe_path',
    });
  }

  ensureDir(path.dirname(target));
  const body = redactContent ? redactText(content) : content;
  await fsp.writeFile(target, body, 'utf8');

  return register({
    runId,
    kind,
    label: input.label ?? ARTIFACT_KIND_LABELS[kind],
    filePath: target,
    mimeType,
    previewUrl,
    meta,
  });
}

export interface RegisterArtifactInput {
  runId: string;
  kind: ArtifactKind;
  label: string;
  /** Absolute path to an existing file, inside the data directory. */
  filePath: string;
  mimeType?: string;
  previewUrl?: string | null;
  meta?: Record<string, unknown>;
}

/** Records a file that already exists, e.g. an agent stream log. */
export async function register(input: RegisterArtifactInput): Promise<ArtifactView> {
  const { runId, kind, label, filePath, mimeType = 'text/plain', previewUrl = null, meta = {} } =
    input;

  const resolved = path.resolve(filePath);
  if (!isInside(artifactsDir(), resolved)) {
    throw new AppError(`Artifact must live under ${artifactsDir()}`, { code: 'unsafe_path' });
  }

  let bytes = 0;
  try {
    bytes = (await fsp.stat(resolved)).size;
  } catch {
    bytes = 0;
  }

  const db = getDb();
  const id = newArtifactId();
  const row = db
    .insert(artifacts)
    .values({
      id,
      runId,
      kind,
      label,
      filePath: resolved,
      mimeType,
      bytes,
      previewUrl,
      meta: JSON.stringify(meta),
    })
    .returning()
    .get();

  if (!row) throw new Error('Failed to record artifact');

  appendEvent({
    runId,
    type: 'artifact.created',
    message: `Artifact: ${label}`,
    payload: { artifactId: id, kind, label, bytes },
  });

  return hydrate(row);
}

export function listArtifacts(runId: string): ArtifactView[] {
  const db = getDb();
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.runId, runId))
    .orderBy(asc(artifacts.createdAt))
    .all()
    .map(hydrate);
}

export function getArtifact(id: string): ArtifactView | null {
  const db = getDb();
  const row = db.select().from(artifacts).where(eq(artifacts.id, id)).get();
  return row ? hydrate(row) : null;
}

export interface ArtifactContent {
  kind: 'text' | 'binary';
  text: string | null;
  bytes: number;
  truncated: boolean;
}

const MAX_INLINE_BYTES = 1_500_000;

/** Reads a text artifact for display, capped so the UI cannot be blown up. */
export async function readArtifactText(id: string): Promise<ArtifactContent | null> {
  const artifact = getArtifact(id);
  if (!artifact) return null;
  if (!isInside(artifactsDir(), artifact.filePath)) return null;
  if (!fs.existsSync(artifact.filePath)) return null;
  if (!isTextMime(artifact.mimeType)) {
    return { kind: 'binary', text: null, bytes: artifact.bytes, truncated: false };
  }

  const handle = await fsp.open(artifact.filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    const readSize = Math.min(size, MAX_INLINE_BYTES);
    const buffer = Buffer.alloc(readSize);
    // Read the tail of an oversized log: the end is where failures are.
    const position = size > MAX_INLINE_BYTES ? size - MAX_INLINE_BYTES : 0;
    await handle.read(buffer, 0, readSize, position);
    let text = buffer.toString('utf8');
    if (position > 0) {
      text = `... [showing the last ${MAX_INLINE_BYTES} bytes of ${size}] ...\n\n${text}`;
    }
    return { kind: 'text', text, bytes: size, truncated: size > MAX_INLINE_BYTES };
  } finally {
    await handle.close();
  }
}

/** Deletes every artifact file for a run. Used by retention cleanup. */
export async function purgeRunArtifacts(runId: string): Promise<void> {
  const dir = runArtifactDir(runId);
  if (!isInside(artifactsDir(), dir)) return;
  await fsp.rm(dir, { recursive: true, force: true });
  const db = getDb();
  db.delete(artifacts).where(eq(artifacts.runId, runId)).run();
}
