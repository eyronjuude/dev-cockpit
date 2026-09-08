import { handle } from '@/app/api/_lib/handler';
import { claudeBinary } from '@/agents/claude-code';
import { dataDir, dbPath } from '@/core/paths';
import { DEFAULT_WORK_MODE, WORK_MODE_LABELS } from '@/domain/modes';
import { listWorkModes } from '@/orchestrator/modes';
import { listAgents } from '@/orchestrator/orchestrator';
import { listProfiles } from '@/orchestrator/profiles';
import { reviewerStatuses } from '@/reviewers/registry';
import { transformerStatuses } from '@/transformers/registry';

export const dynamic = 'force-dynamic';

/**
 * Environment and provider availability.
 *
 * Every optional layer reports whether it can actually run and what it needs,
 * so the Settings screen shows the real state of the machine rather than a
 * list of features that may or may not work.
 */
export function GET() {
  return handle(async () => {
    const agents = await Promise.all(
      listAgents().map(async (agent) => {
        const availability = await agent.checkAvailability();
        return {
          id: agent.id,
          label: agent.label,
          available: availability.available,
          detail: availability.detail,
          version: availability.version,
        };
      }),
    );

    const [transformers, reviewers] = await Promise.all([
      transformerStatuses(),
      reviewerStatuses(),
    ]);

    return {
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
        dataDir: dataDir(),
        databasePath: dbPath(),
        claudeBinary: claudeBinary(),
        anthropicApiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
      },
      agents,
      transformers,
      reviewers,
      profiles: listProfiles(),
      modes: listWorkModes().map((mode) => ({
        ...mode,
        label: WORK_MODE_LABELS[mode.id],
        default: mode.id === DEFAULT_WORK_MODE,
      })),
    };
  });
}
