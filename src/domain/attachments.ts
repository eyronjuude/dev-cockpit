import type { RunStatus } from './types';
import { formatBytes } from './vocabulary';

/**
 * Rules for files attached to a development request.
 *
 * Pure and dependency-free on purpose: the browser needs them to reject a
 * hopeless file before spending a minute uploading it, and the server needs
 * them because a client-side check is a courtesy, not a control. Both import
 * from here so the two answers cannot drift.
 */

/** Per file. Generous because the disk is the user's own. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Per run. A cap exists so a stray multi-select cannot bury the prompt: every
 * attachment is listed to the agent, and a hundred of them would crowd out the
 * request itself.
 */
export const MAX_ATTACHMENTS_PER_RUN = 10;

/** Longest stored file name, extension included. Well under every path limit. */
const MAX_FILE_NAME_LENGTH = 120;

/**
 * How a file is served, keyed by extension.
 *
 * There is no allow-list of *permitted* types. The user picked these files off
 * their own machine and nothing here executes them, so refusing a `.zip`
 * because it is not on a list would be theatre. What the type decides is how
 * the download route serves the bytes, and that is a real decision:
 *
 * - HTML and friends map to `text/plain` deliberately. Served as a document
 *   they would run script in this application's own origin, and the app drives
 *   Claude Code and shell commands on this machine.
 * - SVG keeps its real type, because an inline preview is worth having, and
 *   the route serves it under `Content-Security-Policy: sandbox`.
 * - Anything unlisted becomes `application/octet-stream`, which the route
 *   always sends as a download.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  // Prose and data
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.ndjson': 'application/x-ndjson',
  '.jsonl': 'application/x-ndjson',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.env': 'text/plain',
  '.xml': 'application/xml',
  '.sql': 'text/plain',
  '.diff': 'text/plain',
  '.patch': 'text/plain',

  // Source, so a pasted-in file reads inline rather than downloading
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.js': 'text/plain',
  '.jsx': 'text/plain',
  '.mjs': 'text/plain',
  '.cjs': 'text/plain',
  '.css': 'text/plain',
  '.scss': 'text/plain',
  '.py': 'text/plain',
  '.rb': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.java': 'text/plain',
  '.kt': 'text/plain',
  '.swift': 'text/plain',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cpp': 'text/plain',
  '.cs': 'text/plain',
  '.php': 'text/plain',
  '.sh': 'text/plain',
  '.ps1': 'text/plain',
  '.liquid': 'text/plain',

  // Markup that must never render as a document in this origin
  '.html': 'text/plain',
  '.htm': 'text/plain',
  '.xhtml': 'text/plain',
  '.svgz': 'application/octet-stream',

  // Images and documents
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

/** Types the download route may show in the browser instead of downloading. */
export function isInlineViewableMime(mime: string): boolean {
  return mime.startsWith('image/') || mime === 'application/pdf';
}

/** File extension of a name, lowercased and including the dot. */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return '';
  return fileName.slice(dot).toLowerCase();
}

/**
 * The type an attachment is stored and served as.
 *
 * Derived from the extension rather than taken from the browser's `File.type`,
 * which is client-controlled: a page could otherwise declare a payload as a
 * type the download route treats more permissively than it deserves.
 */
export function attachmentMimeType(fileName: string): string {
  return MIME_BY_EXTENSION[fileExtension(fileName)] ?? 'application/octet-stream';
}

/**
 * Characters that must not reach a file name: the C0 and C1 control ranges,
 * DEL, and the set Windows refuses outright.
 *
 * Tested by code point rather than by a character class, because a regex
 * literal holding raw control characters is unreadable and easy to corrupt in
 * an editor that trims them.
 */
function isUnsafeFileNameChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x1f) return true;
  if (code >= 0x7f && code <= 0x9f) return true;
  return '<>:"|?*'.includes(char);
}

/**
 * A file name safe to write to disk and to render in the UI.
 *
 * Strips directory components and unsafe characters, then caps the length
 * while keeping the extension — an attachment whose extension was truncated
 * away would be served as the wrong type.
 */
export function safeAttachmentFileName(rawName: string): string {
  const base = rawName.split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(base)
    .map((char) => (isUnsafeFileNameChar(char) ? '_' : char))
    .join('')
    // A leading dot would make the file hidden, and `..` is the whole reason
    // traversal works, so neither survives.
    .replace(/^[.]+/, '')
    .trim();

  if (cleaned.length === 0) return 'attachment';
  if (cleaned.length <= MAX_FILE_NAME_LENGTH) return cleaned;

  const extension = fileExtension(cleaned);
  const stem = cleaned.slice(0, cleaned.length - extension.length);
  return stem.slice(0, Math.max(1, MAX_FILE_NAME_LENGTH - extension.length)) + extension;
}

export interface AttachmentCandidate {
  fileName: string;
  bytes: number;
}

/**
 * Why a file cannot be attached, or null when it can.
 *
 * `existingCount` is how many the run already holds, so the count limit is
 * checked against the total rather than against this batch alone.
 */
export function attachmentRejection(
  candidate: AttachmentCandidate,
  existingCount: number,
): string | null {
  if (candidate.bytes <= 0) {
    return `${candidate.fileName} is empty, so there would be nothing to read.`;
  }
  if (candidate.bytes > MAX_ATTACHMENT_BYTES) {
    return `${candidate.fileName} is ${formatBytes(candidate.bytes)}, over the ${formatBytes(
      MAX_ATTACHMENT_BYTES,
    )} limit for one attachment.`;
  }
  if (existingCount >= MAX_ATTACHMENTS_PER_RUN) {
    return `A request can carry ${MAX_ATTACHMENTS_PER_RUN} attachments; ${candidate.fileName} would be one too many.`;
  }
  return null;
}

/**
 * A plain-language statement of the limits, for the compose form and the
 * attachment list. One sentence, so both say the same thing.
 */
export function attachmentLimitsHint(): string {
  return `Up to ${MAX_ATTACHMENTS_PER_RUN} files, ${formatBytes(MAX_ATTACHMENT_BYTES)} each. Any type; the agent reads them from disk.`;
}

/**
 * Statuses whose attachments may still be added to or removed.
 *
 * Every one of these can re-enter implementation, so a file attached now still
 * reaches an agent — attaching the screenshot of a bug and then asking for
 * changes is the whole point of allowing this after creation.
 *
 * The rest are excluded because the list would be a record rather than an
 * input: while a run is implementing the prompt is already built, and once it
 * has landed or been rejected nothing further reads it.
 */
export const ATTACHMENT_MUTABLE_STATUSES: readonly RunStatus[] = [
  'DRAFT',
  'NEEDS_CHANGES',
  'READY',
  'FAILED',
  'CANCELLED',
];

export function attachmentsMutable(status: RunStatus): boolean {
  return ATTACHMENT_MUTABLE_STATUSES.includes(status);
}
