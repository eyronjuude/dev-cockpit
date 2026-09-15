import { notFound } from 'next/navigation';

import { RunView } from '@/components/run-view';
import { buildRunSnapshot } from '@/services/run-snapshot';

export const dynamic = 'force-dynamic';

/**
 * The run screen.
 *
 * Server-rendered with a complete snapshot so the page is useful before any
 * JavaScript runs, then the client component subscribes to the event stream
 * and keeps it current. The snapshot is assembled by the same function the
 * refresh endpoint uses, so the first paint and the first refresh cannot
 * disagree.
 */
export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const initial = buildRunSnapshot(runId);
  if (!initial) notFound();

  return <RunView initial={initial} />;
}
