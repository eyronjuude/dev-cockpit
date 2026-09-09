'use client';

import { useEffect, useState } from 'react';

import { ARTIFACT_KIND_LABELS } from '@/domain/types';
import type { ArtifactContent, ArtifactView } from '@/services/artifacts';
import { DiffView } from './diff-view';
import { Markdown } from './markdown';
import { formatBytes, formatRelative } from './status';

/**
 * Artifact browser.
 *
 * Artifacts are first-class records, so they get a real browser: pick one from
 * the list and see it rendered, without reading the agent transcript to find
 * out it exists.
 */

/**
 * Loaded content is stored together with the id it belongs to. Artifacts stream
 * in while a run is live, so a plain `content` state would briefly show the
 * previous artifact's body under the newly selected name.
 */
interface LoadState {
  artifactId: string;
  content: ArtifactContent | null;
  message: string | null;
}

export function ArtifactPanel({ artifacts }: { artifacts: readonly ArtifactView[] }) {
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadState | null>(null);

  // Derived rather than synchronised: a selection that no longer exists falls
  // back to the first artifact without an effect writing state during render.
  const selected =
    artifacts.find((a) => a.id === requestedId) ?? artifacts[0] ?? null;

  useEffect(() => {
    if (!selected) return;

    let cancelled = false;
    const artifactId = selected.id;

    const finish = (state: Omit<LoadState, 'artifactId'>) => {
      if (cancelled) return;
      setLoaded({ artifactId, ...state });
    };

    if (!selected.exists) {
      finish({
        content: null,
        // Expiry and loss look identical on disk and read very differently to
        // the person holding the run screen, so they are told apart here.
        message: selected.expiredAt
          ? `Expired under this project's retention policy on ` +
            `${new Date(selected.expiredAt).toLocaleDateString()}. ` +
            `It held ${formatBytes(selected.bytes)}; the record of it is kept.`
          : 'The file recorded for this artifact is no longer on disk.',
      });
      return () => {
        cancelled = true;
      };
    }

    if (selected.mimeType.startsWith('image/')) {
      // Rendered by an <img>; nothing to fetch.
      finish({ content: null, message: null });
      return () => {
        cancelled = true;
      };
    }

    fetch(`/api/artifacts/${artifactId}/content`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((body: { content: ArtifactContent | null; message: string | null }) => {
        finish({ content: body.content, message: body.message });
      })
      .catch((err: unknown) => {
        finish({
          content: null,
          message: err instanceof Error ? err.message : 'Could not read the artifact.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (artifacts.length === 0) {
    return <p className="empty-state">No artifacts collected yet.</p>;
  }

  const current = loaded?.artifactId === selected?.id ? loaded : null;
  const loading = selected !== null && current === null;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] divide-x divide-line">
      <ul className="min-h-0 overflow-y-auto py-1">
        {artifacts.map((artifact) => {
          const active = artifact.id === selected?.id;
          return (
            <li key={artifact.id}>
              <button
                type="button"
                onClick={() => setRequestedId(artifact.id)}
                className={`block w-full px-3 py-1.5 text-left text-[12px] ${
                  active ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface-hover'
                }`}
              >
                <span className="block truncate font-medium">{artifact.label}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                  <span>{ARTIFACT_KIND_LABELS[artifact.kind]}</span>
                  <span aria-hidden>·</span>
                  <span>{formatBytes(artifact.bytes)}</span>
                  {artifact.expiredAt ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="text-ink-faint">expired</span>
                    </>
                  ) : !artifact.exists ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="text-fail">missing</span>
                    </>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex min-h-0 flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-2">
              <div className="min-w-0">
                <p className="truncate text-[12.5px] font-medium">{selected.label}</p>
                <p className="mono truncate text-ink-faint" title={selected.filePath}>
                  {selected.filePath}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="text-[11px] text-ink-faint">
                  {formatRelative(selected.createdAt)}
                </span>
                {selected.previewUrl ? (
                  <a
                    className="btn btn-sm"
                    href={selected.previewUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Preview
                  </a>
                ) : null}
                {selected.exists ? (
                  <a
                    className="btn btn-sm"
                    href={`/api/artifacts/${selected.id}/raw?download=1`}
                    download
                  >
                    Download
                  </a>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {selected.mimeType.startsWith('image/') ? (
                <div className="p-3.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/artifacts/${selected.id}/raw`}
                    alt={altText(selected)}
                    className="max-w-full rounded border border-line"
                  />
                </div>
              ) : loading ? (
                <p className="empty-state">Loading…</p>
              ) : current?.message ? (
                <p className="empty-state">{current.message}</p>
              ) : current?.content?.kind === 'binary' ? (
                <p className="empty-state">
                  Binary file ({formatBytes(current.content.bytes)}). Use Download to open it.
                </p>
              ) : current?.content?.text ? (
                <ArtifactBody artifact={selected} text={current.content.text} />
              ) : (
                <p className="empty-state">This artifact is empty.</p>
              )}
            </div>
          </>
        ) : (
          <p className="empty-state">Select an artifact.</p>
        )}
      </div>
    </div>
  );
}

/**
 * An image artifact that recorded its own description gets it as alt text.
 *
 * The implementation map does: everything the picture says is also written into
 * the row, so the artifact carries meaning rather than only pixels.
 */
function altText(artifact: ArtifactView): string {
  return typeof artifact.meta.description === 'string' && artifact.meta.description.trim()
    ? artifact.meta.description
    : artifact.label;
}

function ArtifactBody({ artifact, text }: { artifact: ArtifactView; text: string }) {
  if (artifact.kind === 'git_diff') {
    return <DiffView patch={text} />;
  }
  if (artifact.mimeType === 'text/markdown') {
    return <Markdown className="p-3.5">{text}</Markdown>;
  }
  return <pre className="log p-3.5">{text}</pre>;
}
