'use client';

import { defaultTeam, TEAM_LABELS, TEAM_RESPONSIBILITIES, TEAM_ROLES, type TeamConfig, type TeamMember } from '@/domain/team';

export function TeamEditor({ value, onChange }: {
  value: TeamConfig | null; onChange: (value: TeamConfig | null) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head flex flex-wrap items-center justify-between gap-2">
        <h2 className="panel-title">Engineering team</h2>
        <label className="flex cursor-pointer items-center gap-2 text-[12px]">
          <input type="checkbox" checked={value !== null} onChange={(e) => onChange(e.target.checked ? defaultTeam() : null)} />
          Enable six-role team
        </label>
      </div>
      <div className="space-y-3 px-3.5 py-3">
        <p className="text-[12.5px] text-ink-muted">
          A tech lead, engineer, reviewer and three QA specialists share a live team room.
          Build runs follow explicit handoffs, with up to two automatic repair rounds for high or critical findings.
          Ask and Plan use the normal single-agent workflow.
        </p>
        {value ? <>
          <p className="text-[12px] text-ink-muted">
            Each role makes separate model calls using your local CLI login. Blank models use the provider default.
            The Engineer settings below control implementation. Review and QA assess the diff and recorded checks;
            browser and visual testing are not automated. High and critical findings block readiness.
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {TEAM_ROLES.map((role) => {
              const member = value.members[role];
              const update = (patch: Partial<TeamMember>) => onChange({
                ...value, members: { ...value.members, [role]: { ...member, ...patch } },
              });
              return <fieldset key={role} className="min-w-0 rounded border border-line p-3">
                <legend className="px-1 text-[13px] font-semibold">{TEAM_LABELS[role]}</legend>
                <p className="mb-3 text-[12px] text-ink-muted">{TEAM_RESPONSIBILITIES[role]}</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="text-[12px]">Provider
                    <select className="select mt-1" value={member.provider} onChange={(e) => update({ provider: e.target.value as TeamMember['provider'], model: null })}>
                      <option value="claude-code">Claude Code</option><option value="codex-code">Codex CLI</option>
                    </select>
                  </label>
                  <label className="text-[12px]">Model
                    <input className="input mt-1" value={member.model ?? ''} placeholder="Provider default" maxLength={120} onChange={(e) => update({ model: e.target.value.trim() || null })} />
                  </label>
                  <label className="text-[12px]">Effort
                    <select className="select mt-1" value={member.effort} onChange={(e) => update({ effort: e.target.value as TeamMember['effort'] })}>
                      {['low', 'medium', 'high', 'xhigh'].map((effort) => <option key={effort}>{effort}</option>)}
                    </select>
                  </label>
                </div>
                <label className="mt-3 block text-[12px]">Additional instructions
                  <textarea className="input mt-1 min-h-20" rows={2} maxLength={8_000} value={member.instructions} placeholder="Project-specific focus for this teammate" onChange={(e) => update({ instructions: e.target.value })} />
                </label>
              </fieldset>;
            })}
          </div>
        </> : <p className="text-[12px] text-ink-faint">Team disabled. Runs use the existing implementation and optional review pipeline.</p>}
      </div>
    </section>
  );
}
