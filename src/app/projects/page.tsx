import Link from 'next/link';

import { VALIDATION_KIND_LABELS } from '@/domain/types';
import { formatRelative } from '@/components/status';
import { landingQueueCounts } from '@/services/landing-queue';
import { listProjects, projectRunCounts } from '@/services/projects';

export const dynamic = 'force-dynamic';

const NO_LANDINGS = { live: 0, pending: 0, total: 0 };

export default function ProjectsPage() {
  const projects = listProjects();
  // One query for the whole list rather than one per card.
  const landings = landingQueueCounts(projects);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Projects</h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            Local Git repositories Dev Cockpit can run against.
          </p>
        </div>
        <Link href="/projects/new" className="btn btn-primary">
          Register a project
        </Link>
      </header>

      {projects.length === 0 ? (
        <div className="panel p-8 text-center">
          <h2 className="text-[14px] font-semibold">Nothing registered yet</h2>
          <p className="mx-auto mt-1.5 max-w-md text-[12.5px] text-ink-muted">
            Point Dev Cockpit at a local Git repository and give it the commands you already
            use for typechecking, linting and testing.
          </p>
          <Link href="/projects/new" className="btn btn-primary mt-4">
            Register a project
          </Link>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {projects.map((project) => {
            const counts = projectRunCounts(project.id);
            const landing = landings.get(project.id) ?? NO_LANDINGS;
            const configured = project.validationCommands.filter((c) => c.enabled);

            return (
              <div key={project.id} className="panel flex flex-col">
                <div className="panel-head">
                  <Link
                    href={`/projects/${project.id}`}
                    className="truncate text-[13.5px] font-semibold hover:text-accent"
                  >
                    {project.name}
                  </Link>
                  <span className="shrink-0 text-[11px] text-ink-faint">
                    {counts.total} run{counts.total === 1 ? '' : 's'}
                    {counts.active > 0 ? ` · ${counts.active} active` : ''}
                  </span>
                </div>

                <div className="flex-1 space-y-2.5 px-3.5 py-2.5">
                  <p className="mono truncate text-ink-faint" title={project.repositoryPath}>
                    {project.repositoryPath}
                  </p>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="badge badge-idle">{project.defaultBranch}</span>
                    {configured.length === 0 ? (
                      <span className="badge badge-warn">no validation configured</span>
                    ) : (
                      configured.map((command) => (
                        <span key={command.kind} className="badge badge-accent">
                          {VALIDATION_KIND_LABELS[command.kind]}
                        </span>
                      ))
                    )}
                  </div>

                  <p className="text-[11.5px] text-ink-faint">
                    Registered {formatRelative(project.createdAt)}
                  </p>
                </div>

                <div className="flex items-center gap-1.5 border-t border-line px-3.5 py-2">
                  <Link href={`/projects/${project.id}/new-task`} className="btn btn-sm btn-primary">
                    New task
                  </Link>
                  <Link href={`/projects/${project.id}`} className="btn btn-sm">
                    Configure
                  </Link>
                  <Link href={`/projects/${project.id}/landing-queue`} className="btn btn-sm">
                    Landing queue
                    {landing.total > 0 ? (
                      <span
                        className={`badge ${landing.live > 0 ? 'badge-running' : 'badge-idle'}`}
                      >
                        {landing.total}
                      </span>
                    ) : null}
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
