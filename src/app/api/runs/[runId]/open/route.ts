import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { AppError } from '@/core/errors';
import { runLandingDir } from '@/core/paths';
import { planSpawn } from '@/process/exec';
import { requireProject } from '@/services/projects';
import { requireRun } from '@/services/runs';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ runId: string }> };

const schema = z.object({
  target: z.enum(['worktree', 'repository', 'landing']).default('worktree'),
});

/**
 * Opens a run's worktree in the user's normal development environment.
 *
 * The command comes from project configuration (`openCommand`, e.g.
 * `code {path}`), never from a model, and `{path}` becomes a single argument
 * rather than being interpolated into a shell string.
 *
 * `planSpawn` does the launching rather than `shell: true`, because Node's
 * shell mode joins arguments *without* quoting them — which silently truncated
 * every worktree path at its first space, and these paths routinely contain
 * spaces.
 */
export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const { target } = schema.parse(await readJson(request));

    const run = requireRun(runId);
    const project = requireProject(run.projectId);

    const dir =
      target === 'repository'
        ? project.repositoryPath
        : target === 'landing'
          ? runLandingDir(project.id, run.id)
          : run.worktreePath;
    if (!dir) throw new AppError('This run has no worktree yet.');
    if (!fs.existsSync(dir)) {
      throw new AppError(`That directory no longer exists: ${dir}`, { code: 'missing_path' });
    }

    return { opened: true, path: dir, command: launch(project.openCommand, dir) };
  });
}

function launch(openCommand: string | null, dir: string): string {
  const template = openCommand?.trim();

  const [file, ...rest] = template
    ? template.split(/\s+/).filter(Boolean)
    : [platformOpener()];

  if (!file) throw new AppError('The project open command is empty.');

  const args = rest.map((token) =>
    token.includes('{path}') ? token.replace('{path}', dir) : token,
  );
  // A template that never mentions {path} still needs to be given the directory.
  if (!template || !template.includes('{path}')) args.push(dir);

  const plan = planSpawn(file, args);

  spawn(plan.file, plan.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  }).unref();

  return plan.describe;
}

function platformOpener(): string {
  if (process.platform === 'win32') return 'explorer.exe';
  if (process.platform === 'darwin') return 'open';
  return 'xdg-open';
}
