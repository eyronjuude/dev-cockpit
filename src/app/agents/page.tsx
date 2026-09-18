import { AgentConfigBrowser } from '@/components/agent-config-browser';
import { listAgentConfig } from '@/services/agent-config';

export const dynamic = 'force-dynamic';

/**
 * The user-level Claude Code / Codex configuration on this machine —
 * skills, sub-agents, settings and rules under `~/.claude` and `~/.codex`.
 * Per-project configuration lives on each project's own Agent config tab.
 */
export default function AgentsPage() {
  const entries = listAgentConfig({ kind: 'user' });

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5">
        <h1 className="text-[19px] font-semibold tracking-tight">Agent config</h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          Skills, sub-agents, settings and rules Claude Code and Codex already use on this
          machine. Per-project configuration lives on each project&rsquo;s own Agent config tab.
        </p>
      </header>

      <AgentConfigBrowser scope={{ kind: 'user' }} entries={entries} />
    </div>
  );
}
