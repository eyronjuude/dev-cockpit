import 'server-only';

import { EventEmitter } from 'node:events';

import type { RunEvent } from '@/domain/events';

/**
 * In-process fan-out for run events.
 *
 * Persistence is the source of truth; this only wakes up connected SSE
 * clients. A subscriber that misses a notification still catches up from the
 * database by sequence number, which is what makes an application restart
 * survivable without any replay machinery.
 */

export interface BusMessage {
  runId: string;
  event: RunEvent;
}

const GLOBAL_KEY = '__devCockpitBus__' as const;
type GlobalWithBus = typeof globalThis & { [GLOBAL_KEY]?: EventEmitter };

function emitter(): EventEmitter {
  const g = globalThis as GlobalWithBus;
  if (!g[GLOBAL_KEY]) {
    const e = new EventEmitter();
    // One listener per open run tab, plus the orchestrator. The default of 10
    // is too low and produces spurious warnings.
    e.setMaxListeners(200);
    g[GLOBAL_KEY] = e;
  }
  return g[GLOBAL_KEY];
}

const CHANNEL = 'run-event';

export function publish(message: BusMessage): void {
  emitter().emit(CHANNEL, message);
  emitter().emit(`${CHANNEL}:${message.runId}`, message);
}

/** Subscribes to one run. Returns an unsubscribe function. */
export function subscribeToRun(
  runId: string,
  listener: (message: BusMessage) => void,
): () => void {
  const channel = `${CHANNEL}:${runId}`;
  emitter().on(channel, listener);
  return () => emitter().off(channel, listener);
}

/** Subscribes to every run, for the runs list. */
export function subscribeToAll(listener: (message: BusMessage) => void): () => void {
  emitter().on(CHANNEL, listener);
  return () => emitter().off(CHANNEL, listener);
}
