import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { AppError, errorMessage } from '@/core/errors';
import { planSpawn, spawnDetached } from '@/process/exec';

export const dynamic = 'force-dynamic';

const schema = z.object({ path: z.string().min(1).max(4_000) });

/**
 * Opens a candidate repository path in the OS's native file explorer, before
 * the project it would belong to exists.
 *
 * Always uses the platform opener (never a project's `openCommand`, e.g.
 * `code {path}`) — this route runs during registration, so there is no
 * project yet, and "File Explorer" should mean the OS file browser
 * regardless of what editor a project is later configured to open with.
 */
export function POST(request: Request) {
  return handle(async () => {
    assertLocalRequest(request);
    const { path: candidate } = schema.parse(await readJson(request));

    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new AppError(`That directory does not exist: ${resolved}`, { code: 'missing_path' });
    }

    const plan = planSpawn(platformOpener(), [resolved]);
    try {
      await spawnDetached(plan);
    } catch (err) {
      throw new AppError(errorMessage(err));
    }

    return { opened: true, path: resolved };
  });
}

function platformOpener(): string {
  if (process.platform === 'win32') return 'explorer.exe';
  if (process.platform === 'darwin') return 'open';
  return 'xdg-open';
}
