import 'server-only';

import path from 'node:path';

import { errorMessage } from '@/core/errors';
import type { EventType } from '@/domain/events';
import {
  describeImplementationMap,
  renderImplementationMap,
  type ImplementationMapInput,
} from '@/visualisation/implementation-map';
import { listArtifacts, writeTextArtifact, type ArtifactView } from './artifacts';
import { appendEvent, listEvents } from './events';
import { getRun } from './runs';

/**
 * Records the implementation map for a run.
 *
 * Every run gets one, whatever happened to it. A run that failed in preparation
 * still produces a map — it just shows where the pipeline stopped, which is the
 * case where a picture earns its keep most.
 *
 * The map is redrawn from scratch each time rather than patched, because it is
 * a view of stored state and stored state is the thing that changed. Successive
 * passes are numbered instead of overwriting one another, so the map taken
 * before a change request survives alongside the one taken after it.
 */

/** The stages the map reads out of the event log rather than out of the row. */
const STAGE_EVENT_TYPES: readonly EventType[] = [
  'transform.completed',
  'transform.skipped',
  'transform.failed',
  'worktree.prepared',
  'review.completed',
  'review.skipped',
];

export function collectImplementationMapInput(runId: string): ImplementationMapInput | null {
  const run = getRun(runId);
  if (!run) return null;

  // The latest attempt of each, matching what the run screen shows. An older
  // attempt is history, not the current state of the work.
  const validationAttempt = run.validations.reduce((acc, v) => Math.max(acc, v.attempt), 0);
  const findingAttempt = run.findings.reduce((acc, f) => Math.max(acc, f.attempt), 0);

  return {
    run: {
      id: run.id,
      title: run.title,
      request: run.request,
      status: run.status,
      statusReason: run.statusReason,
      profile: run.profile,
      branch: run.branch,
      baseBranch: run.baseBranch,
      baseCommit: run.baseCommit,
      spec: run.spec,
      specProvider: run.specProvider,
      transformerProvider: run.transformerProvider,
      reviewerProvider: run.reviewerProvider,
      costUsd: run.costUsd,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    projectName: run.projectName,
    iterations: run.iterations.map((iteration) => ({
      kind: iteration.kind,
      status: iteration.status,
      numTurns: iteration.numTurns,
    })),
    changedFiles: run.changedFiles.map((file) => ({
      path: file.path,
      changeType: file.changeType,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
    })),
    validations: run.validations
      .filter((v) => v.attempt === validationAttempt)
      .map((v) => ({
        kind: v.kind,
        outcome: v.outcome,
        blocking: v.blocking,
        exitCode: v.exitCode,
        durationMs: v.durationMs,
      })),
    findings: run.findings
      .filter((f) => f.attempt === findingAttempt)
      .map((f) => ({ severity: f.severity })),
    events: listEvents(runId, { types: STAGE_EVENT_TYPES }).map((event) => ({
      type: event.type,
      message: event.message,
    })),
    generatedAt: new Date().toISOString(),
  };
}

export async function recordImplementationMap(runId: string): Promise<ArtifactView | null> {
  const input = collectImplementationMapInput(runId);
  if (!input) return null;

  const pass = listArtifacts(runId).filter((a) => a.kind === 'implementation_map').length + 1;
  const description = describeImplementationMap(input);

  return writeTextArtifact({
    runId,
    kind: 'implementation_map',
    label: pass === 1 ? 'Implementation map' : `Implementation map (pass ${pass})`,
    fileName: path.join('visualisation', `implementation-map-${pass}.svg`),
    content: renderImplementationMap(input),
    mimeType: 'image/svg+xml',
    meta: {
      pass,
      status: input.run.status,
      changedFiles: input.changedFiles.length,
      // Carried on the row so the UI has alt text without parsing the image.
      description,
    },
  });
}

/**
 * Records the map, and never lets a drawing problem take a run down with it.
 *
 * Called from the orchestrator's `finally`, where a throw would replace a real
 * outcome with an unrelated one.
 */
export async function tryRecordImplementationMap(runId: string): Promise<void> {
  try {
    await recordImplementationMap(runId);
  } catch (err) {
    const reason = errorMessage(err);
    try {
      appendEvent({
        runId,
        type: 'visualisation.skipped',
        level: 'notice',
        message: `Could not draw the implementation map: ${reason}`,
        payload: { reason },
      });
    } catch {
      // The run may have been removed underneath us. The map is optional and
      // so is the notice about it; neither may take the outcome down.
    }
  }
}
