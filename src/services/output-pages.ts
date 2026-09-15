import 'server-only';

import fsp from 'node:fs/promises';
import path from 'node:path';

import { errorMessage } from '@/core/errors';
import { isInside } from '@/core/paths';
import { effectiveWorkMode } from '@/domain/modes';
import { PAGE_KIND, selectStandalonePages } from '@/domain/outputs';
import { listArtifacts, writeTextArtifact } from './artifacts';
import { appendEvent } from './events';
import type { RunView } from './runs';

/**
 * Copies a standalone page a run wrote into its artifacts.
 *
 * Sometimes the thing asked for is not a change to the product but a page about
 * it — a report, a visualisation of a plan. That page is a deliverable, and a
 * deliverable belongs beside the others: it outlives the worktree, retention
 * knows how to reclaim it, and the Preview tab can render it without reaching
 * into a checkout.
 *
 * Deliberately narrow. Which files qualify is decided by a pure function in
 * `domain/outputs` so it is testable without a worktree; this module only reads
 * bytes and records rows, and its failure can never take a run down.
 */

/** Larger than this is not a report. `/raw` streams without the inline cap. */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** More than a handful means the run produced a site, not a deliverable. */
const MAX_PAGES = 5;

/**
 * Whether a page can stand on its own once separated from the worktree.
 *
 * Only the file itself is copied, so a relative reference to a sibling will not
 * resolve. Recording that here lets the tab say so instead of rendering a page
 * with no styles and leaving the reader to wonder.
 */
const RELATIVE_REFERENCE = /(?:src|href)\s*=\s*["'](?!https?:|data:|#|\/\/|\/)[^"']+["']|url\(\s*["']?(?!https?:|data:|\/\/|\/)[^)"']+["']?\s*\)/i;

/** A path inside the worktree turned into one flat, safe artifact file name. */
function artifactFileName(sourcePath: string): string {
  const flattened = sourcePath
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return path.join('pages', flattened || 'page.html');
}

export interface RecordedPage {
  sourcePath: string;
  artifactId: string;
}

/**
 * Records every standalone page in this run's current diff.
 *
 * Idempotent across passes: a page whose bytes have not changed since it was
 * last recorded is skipped, so a second collect does not leave two copies of
 * the same report.
 */
export async function recordOutputPages(run: RunView): Promise<RecordedPage[]> {
  if (!run.worktreePath) return [];
  if (effectiveWorkMode(run) !== 'build') return [];

  const candidates = selectStandalonePages({
    mode: 'build',
    status: run.status,
    active: false,
    request: run.request,
    changedFiles: run.changedFiles.map((file) => ({
      path: file.path,
      changeType: file.changeType,
    })),
    artifacts: [],
    preview: { configured: false, running: false },
    hasWorktree: true,
    uiPathPatterns: [],
  });

  if (candidates.length === 0) return [];

  // Shallowest first: a page at the root is more likely the deliverable than
  // one buried several directories down.
  const ordered = [...candidates]
    .sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b))
    .slice(0, MAX_PAGES);

  const existing = new Map(
    listArtifacts(run.id)
      .filter((artifact) => artifact.kind === PAGE_KIND)
      .map((artifact) => [String(artifact.meta.sourcePath ?? ''), artifact] as const),
  );

  const iterationId = run.iterations.at(-1)?.id ?? null;
  const recorded: RecordedPage[] = [];

  for (const sourcePath of ordered) {
    const absolute = path.resolve(run.worktreePath, sourcePath);
    // Re-checked rather than trusted: a changed-file row is data, and this is
    // the point where it becomes a file read.
    if (!isInside(run.worktreePath, absolute)) continue;

    const stat = await fsp.stat(absolute).catch(() => null);
    if (!stat?.isFile()) continue;

    if (stat.size > MAX_PAGE_BYTES) {
      appendEvent({
        runId: run.id,
        type: 'output.skipped',
        level: 'notice',
        message: `${sourcePath} is too large to preview (${Math.round(stat.size / 1024)} KB)`,
        payload: { reason: 'larger than the preview limit', path: sourcePath },
      });
      continue;
    }

    const previous = existing.get(sourcePath);
    if (previous && previous.exists && previous.bytes === stat.size) continue;

    const content = await fsp.readFile(absolute, 'utf8').catch(() => null);
    if (content === null) continue;

    const artifact = await writeTextArtifact({
      runId: run.id,
      kind: PAGE_KIND,
      label: sourcePath,
      fileName: artifactFileName(sourcePath),
      content,
      mimeType: 'text/html',
      // Redacted like every other text artifact. The patterns match secret
      // shapes rather than markup, and a rendered page is the worst place for
      // a leaked key to sit.
      meta: {
        sourcePath,
        iterationId,
        selfContained: !RELATIVE_REFERENCE.test(content),
      },
    });

    recorded.push({ sourcePath, artifactId: artifact.id });
  }

  return recorded;
}

/**
 * The same, with failure swallowed.
 *
 * A page that could not be copied is not a reason to fail a run that has
 * already done its work — the same arrangement the implementation map uses.
 */
export async function tryRecordOutputPages(run: RunView): Promise<void> {
  try {
    await recordOutputPages(run);
  } catch (err) {
    const reason = errorMessage(err);
    try {
      appendEvent({
        runId: run.id,
        type: 'output.skipped',
        level: 'notice',
        message: `Could not capture this run's HTML output: ${reason}`,
        payload: { reason, path: null },
      });
    } catch {
      // The run may have been removed underneath us. Both the capture and the
      // notice about it are optional; neither may take the outcome down.
    }
  }
}
