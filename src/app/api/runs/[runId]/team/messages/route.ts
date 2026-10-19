import { z } from 'zod';
import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { invalid } from '@/core/errors';
import { effectiveWorkMode } from '@/domain/modes';
import { isTerminal } from '@/domain/types';
import { requireRun } from '@/services/runs';
import { teamActivity } from '@/services/team';

export const dynamic = 'force-dynamic';
const inputSchema = z.object({ text: z.string().trim().min(1).max(8_000) });

export function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return handle(async () => {
    assertLocalRequest(request);
    const { runId } = await params;
    const run = requireRun(runId);
    if (!run.team || effectiveWorkMode(run) !== 'build') throw invalid('This run has no active engineering team');
    if (isTerminal(run.status)) throw invalid('This run is finished');
    const { text } = inputSchema.parse(await readJson(request));
    teamActivity(runId, { role: 'user', to: 'team', kind: 'message', text });
    return { saved: true };
  });
}
