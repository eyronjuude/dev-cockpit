import Link from 'next/link';

import { ProjectForm } from '@/components/project-form';

export const dynamic = 'force-dynamic';

export default function NewProjectPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <header className="mb-5">
        <div className="flex items-center gap-2 text-[11.5px] text-ink-faint">
          <Link href="/projects" className="hover:text-ink">
            Projects
          </Link>
          <span aria-hidden>/</span>
          <span>New</span>
        </div>
        <h1 className="mt-0.5 text-[19px] font-semibold tracking-tight">Register a project</h1>
        <p className="mt-0.5 text-[12.5px] text-ink-muted">
          Only the repository path and a name are required. Everything else can be filled in
          later.
        </p>
      </header>

      <ProjectForm />
    </div>
  );
}
