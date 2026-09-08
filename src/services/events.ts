import 'server-only';

import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { events } from '@/db/schema';
import { shortId } from '@/core/ids';
import { redactText } from '@/core/redact';
import type { EventLevel, EventType, NewRunEvent, RunEvent } from '@/domain/events';
import { publish } from './bus';

function hydrate(row: typeof events.$inferSelect): RunEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = { _unparsed: row.payload };
  }
  return {
    seq: row.seq,
    id: row.id,
    runId: row.runId,
    type: row.type as EventType,
    level: row.level as EventLevel,
    message: row.message,
    payload: payload as RunEvent['payload'],
    createdAt: row.createdAt,
  };
}

/**
 * Appends one event and notifies listeners.
 *
 * Messages are redacted on the way in: an event message can carry agent text
 * or a command line, and the stored log is the one the UI renders.
 */
export function appendEvent<T extends EventType>(event: NewRunEvent<T>): RunEvent {
  const db = getDb();
  const id = shortId('evt');
  const payload = event.payload ?? ({} as Record<string, unknown>);

  const row = db
    .insert(events)
    .values({
      id,
      runId: event.runId,
      type: event.type,
      level: event.level ?? 'info',
      message: redactText(event.message).slice(0, 4_000),
      payload: JSON.stringify(payload),
    })
    .returning()
    .get();

  if (!row) throw new Error('Failed to append event');

  const hydrated = hydrate(row);
  publish({ runId: event.runId, event: hydrated });
  return hydrated;
}

export interface ListEventsOptions {
  /** Only events with a sequence greater than this. Used by SSE catch-up. */
  afterSeq?: number;
  limit?: number;
  types?: readonly EventType[];
}

export function listEvents(runId: string, options: ListEventsOptions = {}): RunEvent[] {
  const { afterSeq, limit = 2_000, types } = options;
  const db = getDb();

  const conditions = [eq(events.runId, runId)];
  if (typeof afterSeq === 'number') conditions.push(gt(events.seq, afterSeq));
  if (types && types.length > 0) conditions.push(inArray(events.type, [...types]));

  const rows = db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(asc(events.seq))
    .limit(limit)
    .all();

  return rows.map(hydrate);
}

/** Most recent events first. Used for the compact run-card preview. */
export function latestEvents(runId: string, limit = 20): RunEvent[] {
  const db = getDb();
  const rows = db
    .select()
    .from(events)
    .where(eq(events.runId, runId))
    .orderBy(desc(events.seq))
    .limit(limit)
    .all();
  return rows.map(hydrate).reverse();
}

export function maxSeq(runId: string): number {
  const db = getDb();
  const row = db
    .select({ seq: events.seq })
    .from(events)
    .where(eq(events.runId, runId))
    .orderBy(desc(events.seq))
    .limit(1)
    .get();
  return row?.seq ?? 0;
}
