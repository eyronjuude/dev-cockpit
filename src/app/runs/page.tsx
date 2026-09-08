import Link from 'next/link';

import { formatRelative, RunStatusBadge } from '@/components/status';
import { effectiveWorkMode, WORK_MODE_LABELS } from '@/domain/modes';
import { listProjects } from '@/services/projects';
import { listRuns } from '@/services/runs';

export const dynamic = 'force-dynamic';

export default function RunsPage() {
  const runs = listRuns({ limit: 200 });
  const projects = listProjects();

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Runs</h1>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            Every development request, with the evidence it produced.
          </p>
        </div>

        {projects.length > 0 ? (
          <Link href={`/projects/${projects[0]!.id}/new-task`} className="btn btn-primary">
            New task
          </Link>
        ) : (
          <Link href="/projects/new" className="btn btn-primary">
            Register a project
          </Link>
        )}
      </header>

      {projects.length === 0 ? (
        <div className="panel p-8 text-center">
          <h2 className="text-[14px] font-semibold">No projects yet</h2>
          <p className="mx-auto mt-1.5 max-w-md text-[12.5px] text-ink-muted">
            Register a local Git repository to start. Dev Cockpit creates an isolated worktree
            per run, so your working tree is never touched.
          </p>
          <Link href="/projects/new" className="btn btn-primary mt-4">
            Register a project
          </Link>
        </div>
      ) : runs.length === 0 ? (
        <div className="panel p-8 text-center">
          <h2 className="text-[14px] font-semibold">No runs yet</h2>
          <p className="mt-1.5 text-[12.5px] text-ink-muted">
            Start a task from a project to create your first run.
          </p>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-muted">
                <th className="px-3.5 py-2 font-semibold">Run</th>
                <th className="w-40 px-2 py-2 font-semibold">Project</th>
                <th className="w-36 px-2 py-2 font-semibold">Status</th>
                <th className="w-28 px-2 py-2 font-semibold">Validation</th>
                <th className="w-20 px-2 py-2 text-right font-semibold">Files</th>
                <th className="w-24 px-3.5 py-2 text-right font-semibold">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-surface-hover">
                  <td className="px-3.5 py-2">
                    <Link href={`/runs/${run.id}`} className="block">
                      <span className="block truncate font-medium hover:text-accent">
                        {run.title}
                      </span>
                      <code className="mono text-ink-faint">
                        {run.branch ?? run.id} ·{' '}
                        {WORK_MODE_LABELS[effectiveWorkMode(run)].toLowerCase()}
                        {run.mode === 'auto' ? ' (auto)' : ''} · {run.profile}
                      </code>
                    </Link>
                  </td>
                  <td className="px-2 py-2">
                    <Link
                      href={`/projects/${run.projectId}`}
                      className="text-ink-muted hover:text-ink"
                    >
                      {run.projectName}
                    </Link>
                  </td>
                  <td className="px-2 py-2">
                    <RunStatusBadge status={run.status} />
                  </td>
                  <td className="px-2 py-2">
                    <ValidationSummary summary={run.validationSummary} />
                    {run.blockingFindings > 0 ? (
                      <span className="mt-0.5 block text-[10.5px] text-warn">
                        {run.blockingFindings} finding
                        {run.blockingFindings === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-muted">
                    {run.changedFileCount || '—'}
                  </td>
                  <td className="px-3.5 py-2 text-right text-ink-faint">
                    {formatRelative(run.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ValidationSummary({
  summary,
}: {
  summary: { passed: number; failed: number; running: number };
}) {
  if (summary.passed === 0 && summary.failed === 0 && summary.running === 0) {
    return <span className="text-ink-faint">—</span>;
  }
  return (
    <span className="flex items-center gap-1.5 tabular-nums">
      {summary.passed > 0 ? <span className="text-pass">{summary.passed} pass</span> : null}
      {summary.failed > 0 ? <span className="text-fail">{summary.failed} fail</span> : null}
      {summary.running > 0 ? <span className="text-running">{summary.running} running</span> : null}
    </span>
  );
}
