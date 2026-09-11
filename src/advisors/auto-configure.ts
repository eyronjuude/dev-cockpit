import 'server-only';

import { errorMessage } from '@/core/errors';
import { collectRepoEvidence, proposeProjectSetup } from '@/services/repo-evidence';
import type { SetupProposal } from '@/services/repo-evidence';
import { recordRevision } from '@/services/config-revisions';
import { replaceValidationSteps, requireProject, updateProject } from '@/services/projects';
import { getAdvisor } from './registry';
import {
  applyRevision,
  createProbeRecord,
  feedbackFrom,
  finishProbe,
  requireProbe,
  runConfigurationProbe,
  type ProbeReport,
} from './probe';

/**
 * `auto` mode: draft a configuration, save it, run it, fix what could not run.
 *
 * This is the only path in the application where a model's shell commands are
 * saved and executed without a human reading them first. Four things make that
 * a reasonable trade rather than a reckless one, and none of them is optional:
 *
 *  1. **Opt-in.** A project is `draft` until someone changes it.
 *  2. **Isolated.** Commands run in a throwaway worktree under `data/probes/`,
 *     never the user's checkout, and it is removed whichever way the probe ends.
 *  3. **Reversible.** A revision snapshot is taken before every save, so the
 *     previous pipeline is one click away.
 *  4. **Grounded.** The model still runs with no tools. Our code executes the
 *     proposal and hands back exit codes; the model corrects against evidence
 *     rather than against another guess.
 *
 * One revision pass, hard-coded — the same shape as the landing repair. A
 * second pass would mostly buy a model another chance to delete a check it
 * could not make pass.
 */

export interface AutoConfigureResult {
  probeId: string;
  applied: SetupProposal;
  report: ProbeReport;
  /** Set when a revision pass ran, naming what it changed. */
  revised: string[];
  revisionId: string | null;
  provider: string;
  fellBackTo: 'deterministic' | null;
  fallbackReason: string | null;
}

/**
 * Starts an auto-configure and returns its probe id immediately.
 *
 * The work continues in the background: a probe installs dependencies and runs
 * a test suite, which is minutes, and holding an HTTP request open for that
 * gives the browser nothing useful to do. The form polls the probe row.
 */
export function startAutoConfigure(projectId: string, provider?: string | null): string {
  const probeId = createProbeRecord(projectId);

  void autoConfigure({ probeId, projectId, provider })
    .then((result) => finishProbe(probeId, 'completed', result.report, null))
    .catch((err: unknown) => finishProbe(probeId, 'failed', null, errorMessage(err)));

  return probeId;
}

export async function autoConfigure(input: {
  probeId: string;
  projectId: string;
  provider?: string | null;
  signal?: AbortSignal;
}): Promise<AutoConfigureResult> {
  const { probeId, projectId, signal } = input;
  const project = requireProject(projectId);

  const evidence = collectRepoEvidence(project.repositoryPath);
  const baseline = proposeProjectSetup(evidence);

  const advisor = getAdvisor(input.provider ?? project.aiConfigProvider);
  const drafted = await advisor.suggestSetup({
    evidence,
    baseline,
    projectName: project.name,
    signal,
  });

  // Save before probing, not after. The probe needs the configuration to exist
  // for the user to watch it run against, and the revision snapshot means the
  // save is not a commitment.
  const firstRevision = recordRevision(projectId, 'advisor', 'Replaced by an AI-drafted setup');
  save(projectId, drafted.proposal);

  const report = await runConfigurationProbe({
    probeId,
    projectId,
    proposal: drafted.proposal,
    signal,
  });

  if (report.configurationSound) {
    return {
      probeId,
      applied: drafted.proposal,
      report,
      revised: [],
      revisionId: firstRevision,
      provider: drafted.provider,
      fellBackTo: drafted.fellBackTo,
      fallbackReason: drafted.fallbackReason,
    };
  }

  // Something could not run. One correction pass, against the exit codes.
  const feedback = feedbackFrom(report);
  const revision = await advisor.suggestSetup({
    evidence,
    baseline: drafted.proposal,
    projectName: project.name,
    probeFeedback: feedback,
    signal,
  });

  // A provider that fell back returned the baseline unchanged, which is not a
  // correction — saving it would undo the draft for no reason.
  if (revision.fellBackTo) {
    return {
      probeId,
      applied: drafted.proposal,
      report,
      revised: [],
      revisionId: firstRevision,
      provider: revision.provider,
      fellBackTo: revision.fellBackTo,
      fallbackReason: revision.fallbackReason,
    };
  }

  const merged = applyRevision(drafted.proposal, revision.proposal, report);
  const changed = describeChanges(drafted.proposal, merged);

  if (changed.length > 0) {
    recordRevision(projectId, 'probe', `Revised after a probe: ${changed.join('; ')}`);
    save(projectId, merged);
  }

  return {
    probeId,
    applied: changed.length > 0 ? merged : drafted.proposal,
    report,
    revised: changed,
    revisionId: firstRevision,
    provider: revision.provider,
    fellBackTo: null,
    fallbackReason: null,
  };
}

/** Writes a proposal onto the project. The only writer in this module. */
function save(projectId: string, proposal: SetupProposal): void {
  updateProject(projectId, {
    setupCommand: proposal.setupCommand,
    developmentCommand: proposal.developmentCommand,
    linkPaths: proposal.linkPaths,
    preview: {
      workingDir: proposal.preview.workingDir,
      readyPath: proposal.preview.readyPath,
    },
  });

  replaceValidationSteps(
    projectId,
    proposal.validationSteps.map((step) => ({
      key: step.key,
      label: step.label,
      kind: step.kind,
      command: step.command,
      workingDir: step.workingDir,
      position: step.position,
      blocking: step.blocking,
    })),
  );
}

/**
 * What the revision actually changed, in words a person can check.
 *
 * Reported rather than summarised as "revised", because the user's next
 * question after an automatic save is always "what did it do".
 */
function describeChanges(before: SetupProposal, after: SetupProposal): string[] {
  const changes: string[] = [];
  const beforeByKey = new Map(before.validationSteps.map((step) => [step.key, step] as const));
  const afterByKey = new Map(after.validationSteps.map((step) => [step.key, step] as const));

  for (const [key, step] of afterByKey) {
    const previous = beforeByKey.get(key);
    if (!previous) {
      changes.push(`added ${key} (${step.command})`);
      continue;
    }
    if (previous.command !== step.command) {
      changes.push(`${key}: ${previous.command} → ${step.command}`);
    } else if ((previous.workingDir ?? '') !== (step.workingDir ?? '')) {
      changes.push(`${key}: working directory → ${step.workingDir ?? '(root)'}`);
    }
  }

  for (const key of beforeByKey.keys()) {
    if (!afterByKey.has(key)) changes.push(`dropped ${key}`);
  }

  if (before.setupCommand !== after.setupCommand) {
    changes.push(`setup command → ${after.setupCommand ?? '(none)'}`);
  }

  return changes;
}

export { requireProbe };
