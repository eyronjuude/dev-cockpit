import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AgentConfigBrowser } from '@/components/agent-config-browser';
import { listAgentConfig } from '@/services/agent-config';
import { getProject } from '@/services/projects';

export const dynamic = 'force-dynamic';

export default async function ProjectAgentConfigPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project) notFound();

  const entries = listAgentConfig({
    kind: 'project',
    projectId: project.id,
    repositoryPath: project.repositoryPath,
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5">
        <div className="flex items-center gap-2 text-[11.5px] text-ink-faint">
          <Link href="/projects" className="hover:text-ink">
            Projects
          </Link>
          <span aria-hidden>/</span>
          <Link href={`/projects/${project.id}`} className="truncate hover:text-ink">
            {project.name}
          </Link>
          <span aria-hidden>/</span>
          <span>Agent config</span>
        </div>
        <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight">Agent config</h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          Claude Code and Codex configuration stored in this repository &mdash;{' '}
          <span className="mono">CLAUDE.md</span>, <span className="mono">AGENTS.md</span>,{' '}
          <span className="mono">.claude/</span> and <span className="mono">.codex/</span>.
        </p>
      </header>

      <AgentConfigBrowser scope={{ kind: 'project', projectId: project.id }} entries={entries} />
    </div>
  );
}
