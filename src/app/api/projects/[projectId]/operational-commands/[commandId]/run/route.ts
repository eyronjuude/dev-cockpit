import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import {
  listOperationalCommandRuns,
  runOperationalCommand,
} from '@/services/operational-commands';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ projectId: string; commandId: string }> };

const schema = z.object({
  runId: z.string().trim().min(1).optional(),
  /**
   * Set only once the UI has shown the command, its target, and (for
   * `production`) collected the extra typed confirmation. The service
   * refuses to run without this regardless of what the UI did or did not
   * show — see `runOperationalCommand`.
   */
  confirmed: z.boolean(),
});

export function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const { commandId } = await params;
    return { runs: listOperationalCommandRuns(commandId) };
  });
}

export function POST(request: Request, { params }: Params) {
  return handle(async () => {
    assertLocalRequest(request);
    const { commandId } = await params;
    const body = schema.parse(await readJson(request));
    const run = await runOperationalCommand(commandId, {
      runId: body.runId,
      confirmed: body.confirmed,
    });
    return { run };
  });
}
