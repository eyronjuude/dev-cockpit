import Link from 'next/link';
import { notFound } from 'next/navigation';

import { NewTaskForm } from '@/components/new-task-form';
import { listProfiles } from '@/orchestrator/profiles';
import { reviewerStatuses } from '@/reviewers/registry';
import { getProject, listProjects, repositoryState } from '@/services/projects';
import { transformerStatuses } from '@/transformers/registry';

export const dynamic = 'force-dynamic';

export default async function NewTaskPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = getProject(projectId);
  if (!project) notFound();

  const [transformers, reviewers, repoState] = await Promise.all([
    transformerStatuses(),
    reviewerStatuses(),
    repositoryState(project),
  ]);

  // Default to whatever is actually usable on this machine: an optional layer
  // that cannot run should not be preselected. Preference order matters —
  // for the reviewer, a different vendor from the implementer is worth more
  // than a familiar one, so codex-cli is tried first.
  const firstAvailable = (
    candidates: readonly { id: string; available: boolean }[],
    order: readonly string[],
  ): string => order.find((id) => candidates.some((c) => c.id === id && c.available)) ?? 'none';

  const defaultTransformer = firstAvailable(transformers, ['codex-cli', 'claude-cli']);
  const defaultReviewer = firstAvailable(reviewers, ['codex-cli', 'claude-cli']);

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <header className="mb-5">
        <div className="flex items-center gap-2 text-[11.5px] text-ink-faint">
          <Link href="/projects" className="hover:text-ink">
            Projects
          </Link>
          <span aria-hidden>/</span>
          <Link href={`/projects/${project.id}`} className="hover:text-ink">
            {project.name}
          </Link>
          <span aria-hidden>/</span>
          <span>New task</span>
        </div>
        <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight">New task</h1>
      </header>

      <NewTaskForm
        project={project}
        projects={listProjects().map((p) => ({ id: p.id, name: p.name }))}
        profiles={listProfiles()}
        transformers={transformers}
        reviewers={reviewers}
        defaultTransformer={defaultTransformer}
        defaultReviewer={defaultReviewer}
        repoState={repoState}
      />
    </div>
  );
}
