'use client';

import { useEffect, useRef, useState } from 'react';
import type { RunEvent } from '@/domain/events';
import { TEAM_LABELS, TEAM_ROLES, type TeamActivity, type TeamConfig } from '@/domain/team';
import { Markdown } from './markdown';

export function TeamRoom({ runId, team, events, active, connected, readOnly, canSend, onEvidence }: {
  runId: string; team: TeamConfig | null; events: RunEvent[]; active: boolean; connected: boolean;
  readOnly: boolean; canSend: boolean; onEvidence: (tab: 'Diff' | 'Tests' | 'Overview') => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const tail = useRef<HTMLDivElement>(null);
  const entries = events.filter((e) => e.type === 'team.activity');
  useEffect(() => {
    if (follow) tail.current?.scrollIntoView({ block: 'nearest' });
  }, [entries.length, follow]);

  if (!team) return <div className="p-5 text-[13px] text-ink-muted">No team was configured for this run. Enable Engineering team in project settings or when creating a new task.</div>;

  async function send() {
    if (!text.trim() || sending) return;
    setSending(true); setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/team/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not send direction');
      setText(''); setFollow(true);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSending(false); }
  }

  return <div className="space-y-4 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="text-[15px] font-semibold">Team room</h2>
        <p className="mt-1 text-[12px] text-ink-muted">Plan → implement → review & QA → repair → your approval</p>
      </div>
      <span className={`badge ${active ? 'badge-running' : 'badge-idle'}`}>{active ? (connected ? 'Live' : 'Reconnecting') : 'Run stopped'}</span>
    </div>
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {TEAM_ROLES.map((role) => {
        const last = entries.findLast((entry) => (entry.payload as TeamActivity).role === role);
        const activity = last?.payload as TeamActivity | undefined;
        const member = team.members[role];
        const working = activity?.kind === 'started' && active;
        const state = readOnly ? 'Not used in this mode' : working ? 'Working' : activity?.kind === 'failed' ? 'Blocked' : activity?.kind === 'completed' ? 'Finished handoff' : activity ? (active ? 'Contributing' : 'Stopped') : 'Waiting';
        return <div key={role} className={`rounded border p-2.5 ${working ? 'border-accent bg-accent-soft' : 'border-line'}`}>
          <div className="flex justify-between gap-2 text-[12px]"><strong>{TEAM_LABELS[role]}</strong><span className="text-ink-muted">{state}</span></div>
          <p className="mt-1 break-words text-[11px] text-ink-faint">{activity?.provider ?? member.provider} · {(activity?.model === undefined ? member.model : activity.model) ?? 'provider default'} · {activity?.effort === undefined ? member.effort : activity.effort ?? 'no effort setting'}</p>
          {activity?.kind === 'completed' ? <p className="mt-1 text-[11px] text-ink-muted">
            Last handoff: {activity.durationMs === undefined ? '' : `${(activity.durationMs / 1000).toFixed(1)}s · `}
            {activity.costUsd == null ? 'cost not reported' : `$${activity.costUsd.toFixed(4)}`}
          </p> : null}
        </div>;
      })}
    </div>
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className="text-ink-muted">Evidence</span>
      <button className="btn btn-ghost" onClick={() => onEvidence('Diff')}>Code diff</button>
      <button className="btn btn-ghost" onClick={() => onEvidence('Tests')}>Recorded checks</button>
      <button className="btn btn-ghost" onClick={() => onEvidence('Overview')}>Findings & approval</button>
      <label className="ml-auto flex items-center gap-1.5"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />Follow conversation</label>
    </div>
    <p className="text-[12px] text-ink-muted">Public updates and evidence assessments. QA has no automated browser or visual verification.</p>
    <div className="space-y-3" aria-live="polite" aria-relevant="additions" role="log" aria-label="Engineering team conversation">
      {entries.length === 0 ? <p className="rounded border border-dashed border-line p-5 text-[13px] text-ink-muted">{readOnly ? 'Ask and Plan use the single-agent workflow. The team joins when you switch to Build.' : 'The conversation will appear here as the team starts. You can add direction before its first handoff.'}</p> : null}
      {entries.map((entry) => {
        const item = entry.payload as TeamActivity;
        return <article key={entry.id} className={`rounded border p-3 ${item.role === 'user' ? 'border-accent bg-accent-soft' : 'border-line bg-surface-raised'}`}>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
            <strong>{item.role === 'user' ? 'You' : TEAM_LABELS[item.role]}</strong>
            {item.kind === 'message' ? <span className="text-ink-faint">→ {item.to === 'team' ? 'Team' : TEAM_LABELS[item.to]}</span> : <span className="text-ink-faint">{item.kind}</span>}
            <time className="ml-auto text-[11px] text-ink-faint" dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleTimeString()}</time>
          </div>
          {item.kind === 'message' ? <Markdown>{item.text}</Markdown> : <p className={`text-[12px] ${item.kind === 'failed' ? 'text-fail' : 'text-ink-muted'}`}>{item.text}</p>}
        </article>;
      })}
      <div ref={tail} />
    </div>
    <form className="space-y-2 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label className="label" htmlFor="team-direction">Your direction to the team</label>
      <textarea id="team-direction" className="input min-h-20" value={text} maxLength={8_000} disabled={!canSend || readOnly} onChange={(e) => setText(e.target.value)} placeholder="Add constraints, answer a question, or clarify the expected behavior…" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11.5px] text-ink-muted">Saved to this room. Read at the next agent handoff or implementation pass; this does not interrupt an agent or start a run.</p>
        <button type="submit" className="btn btn-primary" disabled={sending || !text.trim() || !canSend || readOnly}>{sending ? 'Saving…' : 'Add direction'}</button>
      </div>
      {error ? <p role="alert" className="text-[12px] text-fail">{error}</p> : null}
    </form>
  </div>;
}
