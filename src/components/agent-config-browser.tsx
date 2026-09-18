'use client';

import { useState } from 'react';

import type { AgentConfigEntry, AgentConfigTool } from '@/services/agent-config';

/**
 * Browses and edits the Claude/Codex configuration files discovered for one
 * scope — the user's own `~/.claude`/`~/.codex`, or one project's repository.
 *
 * A plain textarea rather than a code editor: every file here is markdown,
 * JSON or TOML, and Dev Cockpit has no editor dependency to justify adding
 * for that alone (see `validation-step-editor.tsx` for the same choice).
 */

export type AgentConfigScopeParam = { kind: 'user' } | { kind: 'project'; projectId: string };

const TOOL_LABELS: Record<AgentConfigTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const CATEGORY_LABELS: Record<AgentConfigEntry['category'], string> = {
  skill: 'Skills',
  agent: 'Sub-agents',
  settings: 'Settings',
  instructions: 'Instructions',
  rule: 'Rules',
};

function scopeQuery(scope: AgentConfigScopeParam): string {
  return scope.kind === 'user' ? 'scope=user' : `scope=project&projectId=${scope.projectId}`;
}

function groupEntries(
  entries: readonly AgentConfigEntry[],
): { tool: AgentConfigTool; category: AgentConfigEntry['category']; entries: AgentConfigEntry[] }[] {
  const groups: { tool: AgentConfigTool; category: AgentConfigEntry['category']; entries: AgentConfigEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.tool === entry.tool && last.category === entry.category) {
      last.entries.push(entry);
    } else {
      groups.push({ tool: entry.tool, category: entry.category, entries: [entry] });
    }
  }
  return groups;
}

export function AgentConfigBrowser({
  scope,
  entries,
}: {
  scope: AgentConfigScopeParam;
  entries: AgentConfigEntry[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [content, setContent] = useState('');
  const [loadedContent, setLoadedContent] = useState('');

  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const dirty = selected !== null && selected.editable && content !== loadedContent;

  const select = async (entry: AgentConfigEntry) => {
    setSelectedId(entry.id);
    setError(null);
    setSaved(false);
    setLoading(true);
    try {
      const response = await fetch(
        `/api/agent-config/file?${scopeQuery(scope)}&id=${encodeURIComponent(entry.id)}`,
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Could not load that file (${response.status})`);
        setContent('');
        setLoadedContent('');
        return;
      }
      const body = (await response.json()) as { file: { content: string } };
      setContent(body.file.content);
      setLoadedContent(body.file.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that file.');
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch(
        `/api/agent-config/file?${scopeQuery(scope)}&id=${encodeURIComponent(selected.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Save failed (${response.status})`);
        return;
      }
      const body = (await response.json()) as { file: { content: string } };
      setLoadedContent(body.file.content);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (entries.length === 0) {
    return <p className="empty-state">No Claude or Codex configuration found for this scope.</p>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="panel">
        {groupEntries(entries).map((group) => (
          <div key={`${group.tool}-${group.category}`}>
            <div className="panel-head">
              <h2 className="panel-title">
                {TOOL_LABELS[group.tool]} &middot; {CATEGORY_LABELS[group.category]}
              </h2>
            </div>
            <ul className="divide-y divide-line">
              {group.entries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={`flex w-full items-start gap-2 px-3.5 py-2 text-left hover:bg-surface-hover ${
                      entry.id === selectedId ? 'bg-surface-hover' : ''
                    }`}
                    onClick={() => void select(entry)}
                  >
                    <span className="mono min-w-0 flex-1 truncate text-[12px]">{entry.label}</span>
                    {!entry.editable ? <span className="badge badge-idle">read-only</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="panel flex min-h-96 flex-col">
        {selected ? (
          <>
            <div className="panel-head">
              <span className="mono min-w-0 truncate text-ink-muted">{selected.relativePath}</span>
              <div className="flex items-center gap-2">
                {selected.editable ? null : (
                  <span className="text-[11px] text-ink-faint">
                    {selected.readOnlyReason ?? 'read-only'}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={!selected.editable || !dirty || saving || loading}
                  onClick={() => void save()}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
            <div className="flex-1 p-3.5">
              {loading ? (
                <p className="hint">Loading…</p>
              ) : (
                <textarea
                  className="input input-mono h-full min-h-80"
                  value={content}
                  readOnly={!selected.editable}
                  onChange={(e) => setContent(e.target.value)}
                  spellCheck={false}
                />
              )}
            </div>
            {error ? (
              <p className="border-t border-line px-3.5 py-2 text-[12px] text-fail">{error}</p>
            ) : saved ? (
              <p className="border-t border-line px-3.5 py-2 text-[12px] text-pass">Saved.</p>
            ) : null}
          </>
        ) : (
          <p className="empty-state">Choose a file on the left to view or edit it.</p>
        )}
      </div>
    </div>
  );
}
