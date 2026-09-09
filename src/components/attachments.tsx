'use client';

import { useId, useState } from 'react';

import {
  attachmentLimitsHint,
  attachmentRejection,
  MAX_ATTACHMENTS_PER_RUN,
  safeAttachmentFileName,
} from '@/domain/attachments';
import { formatBytes } from '@/domain/vocabulary';
import type { AttachmentView } from '@/services/attachments';

/**
 * Attachment UI, in two halves.
 *
 * `AttachmentPicker` runs before a request exists, so it holds browser `File`
 * objects and uploads nothing until the request is submitted — nothing on disk
 * to orphan if the user changes their mind and closes the tab.
 *
 * `AttachmentList` runs against a stored request, so every change is a request
 * to the server straight away.
 *
 * Both refuse a file the server would refuse, using the same function it uses.
 * A client-side check is a courtesy — it saves uploading 200 MB to be told no
 * — never the control.
 */

/* ------------------------------------------------------------------ *
 * Icon
 * ------------------------------------------------------------------ */

/** A file glyph, so an image attachment reads differently from a log. */
function KindGlyph({ mimeType }: { mimeType: string }) {
  const glyph = mimeType.startsWith('image/')
    ? '▢'
    : mimeType === 'application/pdf'
      ? '▤'
      : mimeType.startsWith('text/') || mimeType.startsWith('application/')
        ? '▥'
        : '▦';
  return (
    <span className="shrink-0 text-ink-faint" aria-hidden>
      {glyph}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Before the request exists
 * ------------------------------------------------------------------ */

export function AttachmentPicker({
  files,
  onChange,
  disabled = false,
}: {
  files: readonly File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const [rejected, setRejected] = useState<string[]>([]);

  const accept = (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;

    const next = [...files];
    const problems: string[] = [];

    for (const file of Array.from(picked)) {
      const fileName = safeAttachmentFileName(file.name);
      const rejection = attachmentRejection({ fileName, bytes: file.size }, next.length);
      if (rejection) {
        problems.push(rejection);
        continue;
      }
      next.push(file);
    }

    setRejected(problems);
    if (next.length !== files.length) onChange(next);
  };

  const remove = (index: number) => {
    setRejected([]);
    onChange(files.filter((_, i) => i !== index));
  };

  const full = files.length >= MAX_ATTACHMENTS_PER_RUN;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Attachments</h2>
        <span className="text-[11px] text-ink-faint">
          {files.length === 0
            ? 'optional'
            : `${files.length} of ${MAX_ATTACHMENTS_PER_RUN}`}
        </span>
      </div>

      <div className="space-y-2 p-3.5">
        {files.length > 0 ? (
          <ul className="divide-y divide-line rounded border border-line">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${file.size}-${file.lastModified}`}
                className="flex items-center gap-2 px-2.5 py-1.5 text-[12.5px]"
              >
                <KindGlyph mimeType={file.type || 'application/octet-stream'} />
                <span className="mono min-w-0 flex-1 truncate" title={file.name}>
                  {safeAttachmentFileName(file.name)}
                </span>
                <span className="shrink-0 tabular-nums text-ink-faint">
                  {formatBytes(file.size)}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm shrink-0"
                  onClick={() => remove(index)}
                  disabled={disabled}
                  aria-label={`Remove ${file.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center gap-2">
          <label
            className={`btn btn-sm ${disabled || full ? 'opacity-50' : 'cursor-pointer'}`}
            htmlFor={inputId}
          >
            {files.length === 0 ? 'Attach files' : 'Attach more'}
          </label>
          <input
            id={inputId}
            type="file"
            multiple
            className="hidden"
            disabled={disabled || full}
            onChange={(event) => {
              accept(event.target.files);
              // Cleared so picking the same file again still fires a change.
              event.target.value = '';
            }}
          />
          <span className="text-[11.5px] text-ink-faint">
            {full
              ? `That is the limit of ${MAX_ATTACHMENTS_PER_RUN}. Remove one to attach another.`
              : 'Screenshots, logs, a spec, a design file.'}
          </span>
        </div>

        <p className="hint">
          {attachmentLimitsHint()} Nothing is uploaded until you start the run, and attachments
          stay outside the worktree so they never appear in the diff.
        </p>

        {rejected.length > 0 ? (
          <ul className="rounded border border-warn/40 bg-warn-soft px-3 py-2 text-[12px] text-warn">
            {rejected.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * After the request exists
 * ------------------------------------------------------------------ */

export function AttachmentList({
  runId,
  attachments,
  mutable,
  onChanged,
}: {
  runId: string;
  attachments: readonly AttachmentView[];
  mutable: boolean;
  onChanged: () => void;
}) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const full = attachments.length >= MAX_ATTACHMENTS_PER_RUN;

  const failureMessage = async (response: Response, fallback: string): Promise<string> => {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? `${fallback} (${response.status})`;
  };

  const upload = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;

    const form = new FormData();
    const problems: string[] = [];
    let accepted = 0;

    for (const file of Array.from(picked)) {
      const fileName = safeAttachmentFileName(file.name);
      const rejection = attachmentRejection(
        { fileName, bytes: file.size },
        attachments.length + accepted,
      );
      if (rejection) {
        problems.push(rejection);
        continue;
      }
      form.append('attachments', file, fileName);
      accepted += 1;
    }

    if (accepted === 0) {
      setError(problems.join(' ') || 'Nothing was attached.');
      return;
    }

    setBusy(true);
    setError(problems.length > 0 ? problems.join(' ') : null);
    try {
      const response = await fetch(`/api/runs/${runId}/attachments`, {
        method: 'POST',
        body: form,
      });
      if (!response.ok) {
        setError(await failureMessage(response, 'Could not attach the files'));
        return;
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not attach the files');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (attachment: AttachmentView) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/attachments/${attachment.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        setError(await failureMessage(response, `Could not remove ${attachment.fileName}`));
        return;
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the attachment');
    } finally {
      setBusy(false);
    }
  };

  if (attachments.length === 0 && !mutable) return null;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Attachments</h2>
        <span className="text-[11px] text-ink-faint">
          {attachments.length === 0
            ? 'none yet'
            : `${attachments.length} file${attachments.length === 1 ? '' : 's'}, read from disk by the agent`}
        </span>
      </div>

      {attachments.length > 0 ? (
        <ul className="divide-y divide-line">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 px-3.5 py-1.5 text-[12.5px]"
            >
              <KindGlyph mimeType={attachment.mimeType} />
              {attachment.exists ? (
                <a
                  href={`/api/runs/${runId}/attachments/${attachment.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mono min-w-0 flex-1 truncate hover:underline"
                  title={attachment.fileName}
                >
                  {attachment.fileName}
                </a>
              ) : (
                <span className="mono min-w-0 flex-1 truncate text-ink-faint line-through">
                  {attachment.fileName}
                </span>
              )}
              <span className="shrink-0 tabular-nums text-ink-faint">
                {formatBytes(attachment.bytes)}
              </span>
              {attachment.exists ? (
                <a
                  href={`/api/runs/${runId}/attachments/${attachment.id}?download=1`}
                  className="btn btn-ghost btn-sm shrink-0"
                  download
                >
                  Download
                </a>
              ) : (
                <span className="shrink-0 text-[11px] text-warn">missing from disk</span>
              )}
              {mutable ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm shrink-0"
                  disabled={busy}
                  onClick={() => void remove(attachment)}
                  aria-label={`Remove ${attachment.fileName}`}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {mutable ? (
        <div className="space-y-1.5 border-t border-line px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <label
              className={`btn btn-sm ${busy || full ? 'opacity-50' : 'cursor-pointer'}`}
              htmlFor={inputId}
            >
              {busy ? 'Attaching…' : attachments.length === 0 ? 'Attach files' : 'Attach more'}
            </label>
            <input
              id={inputId}
              type="file"
              multiple
              className="hidden"
              disabled={busy || full}
              onChange={(event) => {
                void upload(event.target.files);
                event.target.value = '';
              }}
            />
            <span className="text-[11.5px] text-ink-faint">
              {full
                ? `That is the limit of ${MAX_ATTACHMENTS_PER_RUN}.`
                : 'The next iteration reads whatever is attached when it starts.'}
            </span>
          </div>
          <p className="hint">{attachmentLimitsHint()}</p>
        </div>
      ) : attachments.length > 0 ? (
        <p className="border-t border-line px-3.5 py-1.5 text-[11px] text-ink-faint">
          This run has moved past reading its inputs, so the list is fixed. It is what the agent
          was given.
        </p>
      ) : null}

      {error ? (
        <p className="border-t border-fail/30 bg-fail-soft px-3.5 py-2 text-[12px] text-fail">
          {error}
        </p>
      ) : null}
    </div>
  );
}
