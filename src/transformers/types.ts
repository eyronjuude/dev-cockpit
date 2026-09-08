/**
 * The transformer boundary.
 *
 * A transformer turns a natural-language request into a clearer engineering
 * specification, and turns raw agent output into concise human-facing language.
 *
 * Hard rule, enforced by keeping factual data out of these signatures: a
 * transformer never sees or produces source code, git diffs, test results,
 * stack traces, file paths, screenshots or exit codes. It handles prose.
 * Everything factual flows around it, not through it.
 *
 * The whole layer is optional. With no provider configured the orchestrator
 * uses the request verbatim, and nothing downstream behaves differently.
 */

export interface TransformRequestInput {
  /** Exactly what the user typed. */
  request: string;
  /** Project name and a one-line description of the stack, for orientation. */
  projectName: string;
  projectSummary?: string | null;
  /** Which validation kinds the project has configured, by name only. */
  configuredValidations: readonly string[];
  profile: string;
  signal?: AbortSignal;
}

export interface TransformRequestResult {
  /** Markdown specification. */
  spec: string;
  /** Short title for the run, when the provider produced one. */
  title: string | null;
  provider: string;
  durationMs: number;
}

export interface SummariseInput {
  /**
   * Human-facing agent text only. Callers must not pass diffs, logs or
   * command output: those are evidence and stay unmodified.
   */
  agentText: string;
  request: string;
  signal?: AbortSignal;
}

export interface SummariseResult {
  summary: string;
  provider: string;
  durationMs: number;
}

export interface ProviderAvailability {
  available: boolean;
  detail: string;
}

export interface TransformerProvider {
  readonly id: string;
  readonly label: string;
  /** Shown in Settings so the user can see what each option needs. */
  readonly requirement: string;

  checkAvailability(): Promise<ProviderAvailability>;

  transformRequest(input: TransformRequestInput): Promise<TransformRequestResult>;

  /** Optional: providers that cannot summarise may omit this. */
  summariseOutcome?(input: SummariseInput): Promise<SummariseResult>;
}
