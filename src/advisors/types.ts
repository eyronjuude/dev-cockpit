/**
 * The setup-advisor boundary.
 *
 * An advisor drafts a project's configuration — the install command, the dev
 * command, and which of the six validation kinds map to which commands — so
 * registering a project does not mean typing ten fields from memory.
 *
 * Deliberately not a transformer. `src/transformers/types.ts` states the rule
 * that layer keeps: "a transformer never sees or produces source code, git
 * diffs, test results, stack traces, file paths, screenshots or exit codes. It
 * handles prose." An advisor deals in exactly file paths and shell commands,
 * which is the thing that rule excludes, so it lives here with its own
 * contract instead of bending that one.
 *
 * Two properties matter more than the model:
 *
 *  - **It cannot read the repository.** The read-only query behind the CLI
 *    providers runs with no tools at all, so the evidence is gathered by
 *    `src/services/repo-evidence.ts` and handed over. A model here refines a
 *    proposal; it never discovers one.
 *  - **It is optional.** `none` is the default and returns the deterministic
 *    proposal untouched, so the feature works on a machine with no CLI and no
 *    API key. Every other provider falls back to that same proposal on any
 *    failure, because a useful draft beats a broken button.
 *
 * Nothing an advisor returns is saved. It fills a form the user reviews.
 */

import type { RepoEvidence, SetupProposal } from '@/services/repo-evidence';

export interface SuggestSetupInput {
  /** Facts read from the repository by our own code, never by the model. */
  evidence: RepoEvidence;
  /** The deterministic proposal, which the model refines rather than replaces. */
  baseline: SetupProposal;
  projectName: string;
  signal?: AbortSignal;
}

export interface SuggestSetupResult {
  proposal: SetupProposal;
  provider: string;
  durationMs: number;
  /**
   * Set when a provider was asked for but could not deliver, and the
   * deterministic proposal was returned instead. The UI shows this: a silent
   * downgrade would make the draft look better-founded than it is.
   */
  fellBackTo: 'deterministic' | null;
  fallbackReason: string | null;
}

export interface ProviderAvailability {
  available: boolean;
  detail: string;
}

export interface SetupAdvisor {
  readonly id: string;
  readonly label: string;
  /** Shown in the form so the user can see what each option needs. */
  readonly requirement: string;

  checkAvailability(): Promise<ProviderAvailability>;

  suggestSetup(input: SuggestSetupInput): Promise<SuggestSetupResult>;
}
