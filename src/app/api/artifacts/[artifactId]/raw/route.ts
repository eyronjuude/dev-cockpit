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
  // Scoped to the kind as well as the mime type, so a `text/html` file that
  // arrived here some other way still downloads rather than rendering.
  const isOutputPage = artifact.kind === 'html_page' && artifact.mimeType === 'text/html';
  const inline =
    artifact.mimeType.startsWith('image/') || artifact.mimeType === 'application/pdf' || isOutputPage;
  const download = new URL(request.url).searchParams.get('download') === '1';

  const nodeStream = fs.createReadStream(artifact.filePath);
  const body = Readable.toWeb(nodeStream) as WebReadableStream<Uint8Array>;

  const headers: Record<string, string> = {
    'Content-Type': artifact.mimeType,
    'Content-Length': String(stat.size),
    'Content-Disposition': `${inline && !download ? 'inline' : 'attachment'}; filename="${encodeURIComponent(
      artifact.fileName,
    )}"`,
    // Artifacts are immutable once written. `no-transform` keeps Next's
    // response-compression middleware from piping large files through gzip:
    // a big file written faster than the client drains it can pile up
    // concurrent 'drain' listeners on that one Gzip stream and trip
    // MaxListenersExceededWarning.
    'Cache-Control': 'private, max-age=31536000, immutable, no-transform',
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

  /**
   * An agent-authored page, in an opaque origin.
   *
   * The threat is not cookies — this app has no auth. It is that a script on
   * this origin can call an API that spawns coding agents, runs shell commands
   * and merges branches, and `assertLocalRequest` compares only the hostname of
   * the Origin header. An opaque origin sends `Origin: null`, which that check
   * rejects, so every mutation from inside the frame is refused.
   *
   * `allow-scripts` is deliberate: a report that draws a chart is the point.
   * Never pair it with `allow-same-origin` — together they are equivalent to no
   * sandbox at all, because the document can then remove its own.
   *
   * Set on the response as well as on the iframe, because the attribute does
   * nothing for someone who opens this URL directly.
   */
  if (isOutputPage) {
    headers['Content-Security-Policy'] = 'sandbox allow-scripts';
  }

  return new Response(body as unknown as ReadableStream, { headers });
}
