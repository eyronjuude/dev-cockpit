import 'server-only';

import path from 'node:path';

import { AppError } from '@/core/errors';
import { collectRepoEvidence, proposeProjectSetup, type SetupProposal } from '@/services/repo-evidence';
import { probeRepository } from '@/services/projects';
import { getAdvisor } from './registry';

/**
 * Drafts a project configuration for a repository path.
 *
 * The path goes back through `probeRepository` rather than being trusted:
 * that is the same validation the form's **Check** button uses, and it is what
 * keeps this from being pointed at an arbitrary directory on the machine.
 */

export interface SuggestedSetup {
  repositoryPath: string;
  suggestedName: string;
  defaultBranch: string | null;
  proposal: SetupProposal;
  provider: string;
  durationMs: number;
  fellBackTo: 'deterministic' | null;
  fallbackReason: string | null;
  /** A short, honest account of what was found, for the UI. */
  evidenceSummary: string;
}

export async function suggestProjectSetup(input: {
  repositoryPath: string;
  provider?: string | null;
  signal?: AbortSignal;
}): Promise<SuggestedSetup> {
  const probe = await probeRepository(input.repositoryPath);
  if (!probe.ok || !probe.resolvedPath) {
    throw new AppError(probe.message, { code: 'invalid_repository' });
  }

  const repositoryPath = probe.resolvedPath;
  const segments = repositoryPath.split(/[\\/]/).filter(Boolean);
  const suggestedName = segments.at(-1) ?? path.basename(repositoryPath);

  const evidence = collectRepoEvidence(repositoryPath);
  const baseline = proposeProjectSetup(evidence);

  const advisor = getAdvisor(input.provider);
  const result = await advisor.suggestSetup({
    evidence,
    baseline,
    projectName: suggestedName,
    signal: input.signal,
  });

  return {
    repositoryPath,
    suggestedName,
    defaultBranch: probe.defaultBranch,
    proposal: result.proposal,
    provider: result.provider,
    durationMs: result.durationMs,
    fellBackTo: result.fellBackTo,
    fallbackReason: result.fallbackReason,
    evidenceSummary: summariseEvidence(evidence),
  };
}

function summariseEvidence(evidence: ReturnType<typeof collectRepoEvidence>): string {
  if (evidence.manifests.length === 0) {
    return 'No recognised manifest at the repository root, so there was nothing to detect.';
  }

  const parts: string[] = [];
  parts.push(
    evidence.ecosystems.length > 0
      ? `Detected ${evidence.ecosystems.join(' + ')}`
      : 'Detected an unfamiliar stack',
  );
  if (evidence.packageManager) {
    parts.push(
      `package manager ${evidence.packageManager}${
        evidence.packageManagerSource ? ` (${evidence.packageManagerSource})` : ''
      }`,
    );
  }
  if (evidence.scripts.length > 0) parts.push(`${evidence.scripts.length} declared script(s)`);
  if (evidence.makeTargets.length > 0) parts.push(`${evidence.makeTargets.length} make target(s)`);
  if (evidence.monorepo) parts.push('workspace layout');

  return `${parts.join(', ')}.`;
}
