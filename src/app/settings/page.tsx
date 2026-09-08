import { claudeBinary } from '@/agents/claude-code';
import { dataDir, dbPath } from '@/core/paths';
import {
  DEFAULT_WORK_MODE,
  WORK_MODE_DESCRIPTIONS,
  WORK_MODE_LABELS,
  WORK_MODES,
} from '@/domain/modes';
import { getWorkMode } from '@/orchestrator/modes';
import { listAgents } from '@/orchestrator/orchestrator';
import { listProfiles } from '@/orchestrator/profiles';
import { reviewerStatuses } from '@/reviewers/registry';
import { transformerStatuses } from '@/transformers/registry';

export const dynamic = 'force-dynamic';

/**
 * Settings is a status page, not a preferences screen.
 *
 * Almost everything configurable belongs to a project, so what a global page is
 * actually useful for is telling the truth about this machine: which providers
 * can run, which cannot, and exactly why.
 */
export default async function SettingsPage() {
  const [transformers, reviewers] = await Promise.all([
    transformerStatuses(),
    reviewerStatuses(),
  ]);

  const agents = await Promise.all(
    listAgents().map(async (agent) => {
      const availability = await agent.checkAvailability();
      return { id: agent.id, label: agent.label, ...availability };
    }),
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[19px] font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          Environment and provider status. Per-project configuration lives on each project.
        </p>
      </header>

      <section className="panel mb-4">
        <div className="panel-head">
          <h2 className="panel-title">Environment</h2>
        </div>
        <dl className="divide-y divide-line">
          <Row label="Platform" value={`${process.platform} · Node ${process.version}`} />
          <Row label="Data directory" value={dataDir()} mono />
          <Row label="Database" value={dbPath()} mono />
          <Row label="Claude Code binary" value={claudeBinary()} mono />
          <Row
            label="ANTHROPIC_API_KEY"
            value={process.env.ANTHROPIC_API_KEY ? 'set' : 'not set'}
            hint={
              process.env.ANTHROPIC_API_KEY
                ? 'Enables the anthropic-api transformer and reviewer.'
                : 'Not required. The claude-cli providers use the Claude Code login instead.'
            }
          />
          <Row
            label="Network binding"
            value="127.0.0.1 only"
            hint="Dev Cockpit runs local tools, so it is never bound to a public interface."
          />
        </dl>
      </section>

      <section className="panel mb-4">
        <div className="panel-head">
          <h2 className="panel-title">Implementation agents</h2>
        </div>
        <ul className="divide-y divide-line">
          {agents.map((agent) => (
            <li key={agent.id} className="flex items-start gap-3 px-3.5 py-2.5">
              <span className={`badge ${agent.available ? 'badge-pass' : 'badge-fail'}`}>
                {agent.available ? 'available' : 'unavailable'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium">{agent.label}</p>
                <p className="mono break-all text-ink-faint">{agent.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel mb-4">
        <div className="panel-head">
          <h2 className="panel-title">Transformers</h2>
          <span className="text-[11px] text-ink-faint">optional</span>
        </div>
        <ProviderList providers={transformers} />
      </section>

      <section className="panel mb-4">
        <div className="panel-head">
          <h2 className="panel-title">Reviewers</h2>
          <span className="text-[11px] text-ink-faint">optional, read-only</span>
        </div>
        <ProviderList providers={reviewers} />
      </section>

      <section className="panel mb-4">
        <div className="panel-head">
          <h2 className="panel-title">Working modes</h2>
          <span className="text-[11px] text-ink-faint">chosen per run</span>
        </div>
        <ul className="divide-y divide-line">
          {WORK_MODES.map((id) => {
            // Auto is a choice between the other two rather than a behaviour of
            // its own, so it has no row of phase toggles to show.
            const behaviour = id === 'auto' ? null : getWorkMode(id);
            return (
              <li key={id} className="px-3.5 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-medium">{WORK_MODE_LABELS[id]}</span>
                  {id === DEFAULT_WORK_MODE ? (
                    <span className="badge badge-accent">default</span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[12px] text-ink-muted">{WORK_MODE_DESCRIPTIONS[id]}</p>
                <p className="mt-0.5 text-[11px] text-ink-faint">
                  {behaviour
                    ? `edits files ${behaviour.editsCode ? 'yes' : 'no'} · validation ${
                        behaviour.runValidation ? 'on' : 'off'
                      } · reviewer ${behaviour.runReviewer ? 'on' : 'off'}${
                        behaviour.agentPermissionMode
                          ? ` · permission mode forced to ${behaviour.agentPermissionMode}`
                          : ' · permission mode from the project'
                      }`
                    : 'Decided from the request before the run starts, and recorded with its reason.'}
                </p>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Execution profiles</h2>
          <span className="text-[11px] text-ink-faint">how much effort, not what to produce</span>
        </div>
        <ul className="divide-y divide-line">
          {listProfiles().map((profile) => (
            <li key={profile.id} className="px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-medium">{profile.label}</span>
                {profile.id === 'standard' ? (
                  <span className="badge badge-accent">default</span>
                ) : null}
              </div>
              <p className="mt-0.5 text-[12px] text-ink-muted">{profile.description}</p>
              <p className="mt-0.5 text-[11px] text-ink-faint">
                effort {profile.agentEffort} · timeout{' '}
                {Math.round(profile.agentTimeoutMs / 60_000)}m · reviewer{' '}
                {profile.runReviewer ? 'on' : 'off'}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ProviderList({
  providers,
}: {
  providers: { id: string; label: string; requirement: string; available: boolean; detail: string }[];
}) {
  return (
    <ul className="divide-y divide-line">
      {providers.map((provider) => (
        <li key={provider.id} className="flex items-start gap-3 px-3.5 py-2.5">
          <span className={`badge ${provider.available ? 'badge-pass' : 'badge-idle'}`}>
            {provider.available ? 'ready' : 'not configured'}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium">
              {provider.label} <code className="mono text-ink-faint">{provider.id}</code>
            </p>
            <p className="text-[11.5px] text-ink-muted">{provider.requirement}</p>
            <p className="mono break-all text-ink-faint">{provider.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Row({
  label,
  value,
  mono,
  hint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2">
      <dt className="w-40 shrink-0 text-[12px] text-ink-muted">{label}</dt>
      <dd className="min-w-0 flex-1">
        <span className={`break-all ${mono ? 'mono' : 'text-[12.5px]'}`}>{value}</span>
        {hint ? <span className="block text-[11.5px] text-ink-faint">{hint}</span> : null}
      </dd>
    </div>
  );
}
