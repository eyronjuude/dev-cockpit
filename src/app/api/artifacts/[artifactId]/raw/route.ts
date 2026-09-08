import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { artifactsDir, isInside } from '@/core/paths';
import { getArtifact } from '@/services/artifacts';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ artifactId: string }> };

/**
 * Serves an artifact file: screenshots inline, everything else as a download.
 *
 * The path is re-checked against the artifact root on every request rather than
 * trusted from the database row, so a tampered or stale row cannot be used to
 * read an arbitrary file off the machine.
 */
export async function GET(request: Request, { params }: Params) {
  const { artifactId } = await params;
  const artifact = getArtifact(artifactId);

  if (!artifact) return new Response('Artifact not found', { status: 404 });
  if (!isInside(artifactsDir(), artifact.filePath)) {
    return new Response('Artifact path is outside the artifact root', { status: 403 });
  }
  if (!fs.existsSync(artifact.filePath)) {
    return new Response('The artifact file is no longer on disk', { status: 410 });
  }

  const stat = await fs.promises.stat(artifact.filePath);
  const inline = artifact.mimeType.startsWith('image/') || artifact.mimeType === 'application/pdf';
  const download = new URL(request.url).searchParams.get('download') === '1';

  const nodeStream = fs.createReadStream(artifact.filePath);
  const body = Readable.toWeb(nodeStream) as WebReadableStream<Uint8Array>;

  const headers: Record<string, string> = {
    'Content-Type': artifact.mimeType,
    'Content-Length': String(stat.size),
    'Content-Disposition': `${inline && !download ? 'inline' : 'attachment'}; filename="${encodeURIComponent(
      artifact.fileName,
    )}"`,
    // Artifacts are immutable once written.
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };

  // An SVG served inline becomes a *document* when navigated to directly, and a
  // document can run script in this application's own origin. The only SVGs the
  // app produces are its own implementation maps, with every value escaped, so
  // this is defence in depth rather than a known hole. Scoped to SVG because
  // sandboxing a PDF would break the browser's own viewer.
  if (artifact.mimeType === 'image/svg+xml') {
    headers['Content-Security-Policy'] = 'sandbox';
  }

  return new Response(body as unknown as ReadableStream, { headers });
}
