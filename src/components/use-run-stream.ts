'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RunEvent } from '@/domain/events';
import type { ExpiryPlan } from '@/domain/expiry';
import type { ValidationKind } from '@/domain/types';
import type { ArtifactView } from '@/services/artifacts';
import type { ReadinessAssessment, RunView } from '@/services/runs';
import type { RunWorktree } from '@/services/worktrees';

export interface ConfiguredValidation {
  kind: ValidationKind;
  command: string;
  blocking: boolean;
}

export interface RunSnapshot {
  run: RunView;
  readiness: ReadinessAssessment;
  artifacts: ArtifactView[];
  live: { active: boolean; phase: string | null };
  /** This run's worktrees, and whether each is still on disk. */
  worktrees: RunWorktree[];
  /**
   * When retention will reclaim this run's storage. Computed server-side from
   * the project's windows, so the screen and the sweep can never disagree.
   */
  expiry: ExpiryPlan;
  /**
   * Whether the attachment list can still be added to or removed from.
   *
   * Server-decided rather than derived on the client from the status, because
   * it also accounts for whether the orchestrator is mid-flight, which the
   * status alone does not say.
   */
  attachmentsMutable: boolean;
  configuredValidations: ConfiguredValidation[];
  policies: {
    requireValidation: boolean;
    requireE2eForUiChanges: boolean;
    reviewBlocksReady: boolean;
    allowAgentCommit: boolean;
    protectedBranches: string[];
    worktreeRetentionDays: number;
    artifactRetentionDays: number;
  };
}

interface StreamState {
  events: RunEvent[];
  snapshot: RunSnapshot | null;
  connected: boolean;
  error: string | null;
}

/**
 * Subscribes to a run's event stream and keeps a fresh snapshot beside it.
 *
 * Two channels on purpose. Events say what happened, in order, and drive the
 * progress feed. The snapshot says what the state now is, and drives the
 * scorecard and action buttons — so the UI never has to reconstruct run state
 * by folding events, which is where a live view drifts from the database.
 *
 * The stream carries a sequence cursor, so a reconnect resumes rather than
 * restarting, and a reload replays only what the client has not seen.
 */
export function useRunStream(runId: string, initial: RunSnapshot) {
  const [state, setState] = useState<StreamState>({
    events: [],
    snapshot: initial,
    connected: false,
    error: null,
  });

  const cursorRef = useRef(0);
  const seenRef = useRef<Set<number>>(new Set());
  // Coalesces snapshot fetches: a burst of tool events should cause one refresh.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const refreshSnapshot = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch(`/api/runs/${runId}/snapshot`, { cache: 'no-store' });
      if (!response.ok) return;
      const snapshot = (await response.json()) as RunSnapshot;
      setState((prev) => ({ ...prev, snapshot }));
    } catch {
      // A failed refresh is not worth surfacing: the next event triggers another.
    } finally {
      inFlight.current = false;
    }
  }, [runId]);

  const scheduleRefresh = useCallback(
    (delay = 350) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        void refreshSnapshot();
      }, delay);
    },
    [refreshSnapshot],
  );

  // A phase change is not an event — the orchestrator moves from implementing
  // to collecting to validating without writing one — so an active run is
  // polled slowly as well. Without this the progress bar can sit on a finished
  // phase through a long silent stretch.
  const active = state.snapshot?.live.active ?? false;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void refreshSnapshot();
    }, 5_000);
    return () => clearInterval(timer);
  }, [active, refreshSnapshot]);

  useEffect(() => {
    let source: EventSource | null = null;
    let closedByUs = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      source = new EventSource(`/api/runs/${runId}/events?lastSeq=${cursorRef.current}`);

      source.addEventListener('open', () => {
        attempt = 0;
        setState((prev) => ({ ...prev, connected: true, error: null }));
      });

      source.addEventListener('sync', () => {
        // The server finished the catch-up replay; make sure derived state
        // matches what those events implied.
        scheduleRefresh(50);
      });

      source.addEventListener('run-event', (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as RunEvent;
        if (seenRef.current.has(event.seq)) return;
        seenRef.current.add(event.seq);
        cursorRef.current = Math.max(cursorRef.current, event.seq);

        setState((prev) => ({ ...prev, events: [...prev.events, event] }));

        // Status, validation and review events change what the buttons should
        // offer, so those refresh promptly; chatter can wait.
        const urgent =
          event.type.startsWith('run.') ||
          event.type.startsWith('validation.') ||
          event.type.startsWith('review.') ||
          event.type.startsWith('landing.') ||
          event.type === 'agent.completed' ||
          event.type === 'agent.failed' ||
          event.type === 'artifact.created' ||
          event.type === 'worktree.prepared' ||
          event.type === 'transform.completed';

        scheduleRefresh(urgent ? 60 : 900);
      });

      source.addEventListener('error', () => {
        if (closedByUs) return;
        setState((prev) => ({ ...prev, connected: false }));
        source?.close();

        // EventSource reconnects on its own, but not after the server closes a
        // stream cleanly, so reconnect with backoff from the stored cursor.
        attempt += 1;
        const delay = Math.min(1_000 * 2 ** (attempt - 1), 15_000);
        retry = setTimeout(connect, delay);
      });
    };

    connect();

    return () => {
      closedByUs = true;
      source?.close();
      if (retry) clearTimeout(retry);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [runId, scheduleRefresh]);

  return {
    events: state.events,
    snapshot: state.snapshot ?? initial,
    connected: state.connected,
    error: state.error,
    refresh: refreshSnapshot,
  };
}
