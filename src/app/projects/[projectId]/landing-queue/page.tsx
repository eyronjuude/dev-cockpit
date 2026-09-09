import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LandingQueuePanel } from '@/components/landing-queue-panel';
import { projectLandingQueue } from '@/services/landing-queue';
import { getProject } from '@/services/projects';

export const dynamic = 'force-dynamic';

export default async function LandingQueuePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project) notFound();

  const queue = projectLandingQueue(project);

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
          <span>Landing queue</span>
        </div>
        <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight">Landing queue</h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          Every approved run that has not merged yet, grouped by the branch it lands on. Runs
          targeting the same branch land one at a time.
        </p>
      </header>

      <LandingQueuePanel projectId={project.id} initial={queue} />
    </div>
  );
}
