'use client';

import { useMemo, useState } from 'react';

/**
 * Unified-diff renderer.
 *
 * The patch is displayed exactly as git produced it — this component colours
 * and groups lines, and changes no content. Long diffs are collapsed per file
 * so a run touching thirty files is still navigable.
 */

interface FileSection {
  header: string;
  path: string;
  lines: string[];
  additions: number;
  deletions: number;
}

function classify(line: string): string {
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  if (
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity ') ||
    line.startsWith('rename ') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('Binary files')
  ) {
    return 'diff-meta';
  }
  return '';
}

function splitByFile(patch: string): FileSection[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const sections: FileSection[] = [];
  let current: FileSection | null = null;

  const pathFromHeader = (header: string): string => {
    // "diff --git a/src/x.ts b/src/x.ts" -> "src/x.ts"
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
    if (match) return match[2] ?? match[1] ?? header;
    return header.replace(/^diff --git\s*/, '');
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current);
      current = {
        header: line,
        path: pathFromHeader(line),
        lines: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }

    if (!current) {
      // Leading --stat output before the first file header.
      if (line.trim() === '') continue;
      current = { header: 'Summary', path: 'Summary', lines: [], additions: 0, deletions: 0 };
    }

    current.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1;
  }

  if (current) sections.push(current);
  return sections;
}

const COLLAPSE_THRESHOLD = 400;

export function DiffView({ patch }: { patch: string }) {
  const sections = useMemo(() => splitByFile(patch), [patch]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    // Collapse anything huge by default; leave normal files open.
    const initial: Record<string, boolean> = {};
    for (const section of splitByFile(patch)) {
      if (section.lines.length > COLLAPSE_THRESHOLD) initial[section.path] = true;
    }
    return initial;
  });

  if (!patch.trim() || patch.trim() === '(no changes)') {
    return <p className="empty-state">No changes recorded for this run.</p>;
  }

  return (
    <div className="diff">
      {sections.map((section, index) => {
        const isCollapsed = collapsed[section.path] ?? false;
        return (
          <div key={`${section.path}-${index}`}>
            <button
              type="button"
              className="diff-line diff-file flex w-full items-center justify-between gap-3 text-left"
              onClick={() =>
                setCollapsed((prev) => ({ ...prev, [section.path]: !isCollapsed }))
              }
              aria-expanded={!isCollapsed}
            >
              <span className="truncate">
                <span className="text-ink-faint">{isCollapsed ? '▸' : '▾'}</span> {section.path}
              </span>
              <span className="shrink-0 text-[11px] font-normal">
                <span className="text-pass">+{section.additions}</span>{' '}
                <span className="text-fail">−{section.deletions}</span>
              </span>
            </button>

            {!isCollapsed &&
              section.lines.map((line, lineIndex) => (
                <code key={lineIndex} className={`diff-line ${classify(line)}`}>
                  {line || ' '}
                </code>
              ))}

            {isCollapsed ? (
              <span className="diff-line diff-meta">
                {section.lines.length} lines hidden — click the filename to expand
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
