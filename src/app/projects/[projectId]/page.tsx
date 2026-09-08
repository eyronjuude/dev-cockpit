import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ProjectForm } from '@/components/project-form';
import { formatRelative, RunStatusBadge } from '@/components/status';
import { getProject, recentRunSummaries } from '@/services/projects';
import type { RunStatus } from '@/domain/types';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project) notFound();

  const runs = recentRunSummaries(projectId, 12);

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <header className="mb-5 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11.5px] text-ink-faint">
            <Link href="/projects" className="hover:text-ink">
              Projects
            </Link>
            <span aria-hidden>/</span>
            <span className="truncate">{project.name}</span>
          </div>
          <h1 className="mt-0.5 truncate text-[19px] font-semibold tracking-tight">
            {project.name}
          </h1>
          <p className="mono mt-0.5 truncate text-ink-faint" title={project.repositoryPath}>
            {project.repositoryPath}
          </p>
        </div>
        <Link href={`/projects/${project.id}/new-task`} className="btn btn-primary">
          New task
        </Link>
      </header>

      <section className="panel mb-4">
        <div className="panel-head">
          <h2 className="panel-title">Recent runs</h2>
          <Link href="/runs" className="text-[11px] text-ink-faint hover:text-ink">
            All runs
          </Link>
        </div>
        {runs.length === 0 ? (
          <p className="empty-state">No runs for this project yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/runs/${run.id}`}
                  className="flex items-center gap-3 px-3.5 py-2 hover:bg-surface-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{run.title}</span>
                  <code className="mono hidden shrink-0 text-ink-faint sm:block">
                    {run.branch ?? run.id}
                  </code>
                  <RunStatusBadge status={run.status as RunStatus} />
                  <span className="w-20 shrink-0 text-right text-[11px] text-ink-faint">
                    {formatRelative(run.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h2 className="mb-2.5 text-[14px] font-semibold">Configuration</h2>
      <ProjectForm existing={project} />
    </div>
  );
}
