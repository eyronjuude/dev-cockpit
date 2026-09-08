import { z } from 'zod';

/**
 * Working modes.
 *
 * A mode answers "what should this run try to produce" — an answer, a plan, or
 * a change. That is a different question from the execution profile, which
 * answers "how much effort should it spend". The two compose: a Deep Plan run
 * thinks harder about the plan, a Quick Build run makes a small change with
 * less validation.
 *
 * `auto` is not a fourth behaviour. It is a choice between the other three,
 * made from the request text before the run starts and recorded with its
 * reason, so a run always says which mode it actually executed in.
 *
 * This module is pure vocabulary and a pure classifier: no I/O, no database, no
 * server-only imports. The New Task form runs `resolveWorkMode` in the browser
 * to show what Auto would pick before anything is created.
 */

export const WORK_MODES = ['ask', 'plan', 'build', 'auto'] as const;
export type WorkMode = (typeof WORK_MODES)[number];
export const workModeSchema = z.enum(WORK_MODES);

/** The modes a run can actually execute in. `auto` always resolves to one. */
export const RESOLVED_WORK_MODES = ['ask', 'plan', 'build'] as const;
export type ResolvedWorkMode = (typeof RESOLVED_WORK_MODES)[number];
export const resolvedWorkModeSchema = z.enum(RESOLVED_WORK_MODES);

/**
 * Build, deliberately.
 *
 * Every run that existed before modes were added was a build run, and a
 * keyword heuristic quietly turning a change request into a document is a worse
 * surprise than the reverse. Auto is opt-in.
 */
export const DEFAULT_WORK_MODE: WorkMode = 'build';

export const WORK_MODE_LABELS: Record<WorkMode, string> = {
  ask: 'Ask',
  plan: 'Plan',
  build: 'Build',
  auto: 'Auto',
};

export const WORK_MODE_DESCRIPTIONS: Record<WorkMode, string> = {
  ask: 'Answers a question about the code. Changes nothing, runs no checks.',
  plan: 'Writes a plan for a change. Changes nothing, runs no checks.',
  build: 'Implements the change, then validates and reviews it.',
  auto: 'Reads the request and picks a mode before the run starts.',
};

/**
 * The words each mode is described with.
 *
 * Kept here rather than in the orchestrator because three layers need the same
 * nouns — readiness reasons in `services/runs`, event messages in the
 * orchestrator, and UI copy — and three copies would drift.
 */
export interface WorkModeWording {
  /** Live phase label while the agent is working: "planning…". */
  activity: string;
  /** Sentence-initial noun for a progress message: "Planning finished in 3s". */
  progressNoun: string;
  /** What the run produces: "No answer was produced". */
  deliverable: string;
  /** What the agent is called in copy: "the planner is still working". */
  agentNoun: string;
}

export const WORK_MODE_WORDING: Record<ResolvedWorkMode, WorkModeWording> = {
  ask: {
    activity: 'answering',
    progressNoun: 'Answering',
    deliverable: 'answer',
    agentNoun: 'agent',
  },
  plan: {
    activity: 'planning',
    progressNoun: 'Planning',
    deliverable: 'plan',
    agentNoun: 'planner',
  },
  build: {
    activity: 'implementing',
    progressNoun: 'Implementation',
    deliverable: 'implementation',
    agentNoun: 'implementer',
  },
};

export interface WorkModeResolution {
  mode: ResolvedWorkMode;
  /** Why this mode is in effect, as a sentence fragment for an event message. */
  reason: string;
  /** True when Auto made the choice rather than the user. */
  automatic: boolean;
}

/* ------------------------------------------------------------------ *
 * Auto
 * ------------------------------------------------------------------ */

/**
 * The Auto rule, in two steps.
 *
 * **Is this read-only?** Yes if the request forbids code changes, or names a
 * plan as its deliverable, or — with no change verb anywhere — asks a question
 * or asks for a judgement. Otherwise it is a Build run.
 *
 * **Which read-only mode?** Ask when the request asks about code that already
 * exists. Plan when it asks what to do next.
 *
 * The ordering carries the whole design. A stated deliverable beats a change
 * verb, so "plan how to fix the login bug" is a Plan run. A change verb beats a
 * question, so "explain why login 500s and fix it" is a Build run that happens
 * to start with reading. And a request for judgement beats a bare question, so
 * "what's the best way to model this" is a Plan run rather than an Ask.
 *
 * The list is a heuristic and will be wrong sometimes. That is survivable
 * because the choice is shown before the run starts and recorded after it, and
 * because a run can switch mode without losing its session.
 */

/** An explicit instruction not to touch code. */
const NO_CODE_SIGNALS: readonly RegExp[] = [
  /\b(?:do not|don't|dont)\s+(?:write|change|edit|modify|touch|implement|create)\b/,
  /\bno\s+code\s+changes?\b/,
  /\bwithout\s+(?:writing|changing|editing|modifying|touching)\b/,
  /\bplan\s+only\b/,
  /\bplan\s+mode\b/,
  /\b(?:just|only)\s+(?:a\s+|the\s+)?plan\b/,
  /\bread[\s-]only\b/,
];

/** A plan, proposal or approach named as the thing to hand back. */
const PLAN_DELIVERABLE_SIGNALS: readonly RegExp[] = [
  /\b(?:write|draft|produce|prepare|propose|outline|sketch|give|suggest)\b[^.!?]{0,40}?\b(?:plan|proposal|design\s+doc(?:ument)?|approach|strategy|rfc|adr)\b/,
  /\bplan\s+(?:out\s+)?(?:how|the|a|an|this|it|what|for)\b/,
  /\bimplementation\s+plan\b/,
  /\bstep[\s-]by[\s-]step\s+plan\b/,
];

/** Verbs that name a change to make. */
const CHANGE_SIGNALS: readonly RegExp[] = [
  /\b(?:implement|fix|fixes|patch|add|adds|remove|delete|rename|refactor|rewrite|migrate|upgrade|downgrade|bump|extract|replace|update|correct|repair|revert)\b/,
  /\b(?:wire|hook|set)\s+up\b/,
  /\bmake\s+(?:it|this|the|them|sure)\b/,
];

/** Questions about code that already exists. */
const QUESTION_SIGNALS: readonly RegExp[] = [
  /\b(?:explain|describe|clarify|summarise|summarize)\b/,
  /\bwalk\s+(?:me\s+)?through\b/,
  /\bwhat\s+(?:does|do|is|are|happens)\b/,
  /\bwhere\s+(?:is|are|does|do)\b/,
  /\bhow\s+(?:does|do|is|are)\b/,
  /\bwhy\s+(?:does|do|is|are|did|was)\b/,
  /\bwhich\s+(?:file|files|module|function|component|class|test|tests)\b/,
  /\bwho\s+(?:calls|uses)\b/,
  /\bis\s+there\s+(?:a|an|any)\b/,
  /\bdo\s+we\s+(?:have|already)\b/,
];

/** Asks that want reading and judgement about what to do next. */
const INVESTIGATION_SIGNALS: readonly RegExp[] = [
  /\b(?:investigate|research|explore|evaluate|assess|audit|compare|survey)\b/,
  /\bhow\s+(?:should|would|do|can)\s+(?:we|i|you)\b/,
  /\bwhat(?:'s| is| are)\s+the\s+(?:best|right|cleanest|simplest)\s+(?:way|approach|option)/,
  /\bwhich\s+(?:approach|option|library|package|pattern)\b/,
  /\bshould\s+(?:we|i)\b/,
  /\boptions?\s+for\b/,
  /\btrade[\s-]?offs?\b/,
  /\bpros\s+and\s+cons\b/,
  /\bfeasib(?:le|ility)\b/,
];

/** Lowercased, with typographic apostrophes folded so `don't` matches. */
function normalise(request: string): string {
  return request.toLowerCase().replace(/[‘’]/g, "'");
}

const matches = (text: string, signals: readonly RegExp[]): boolean =>
  signals.some((pattern) => pattern.test(text));

/** What Auto would pick for a request, and why. Pure. */
export function classifyRequest(request: string): { mode: ResolvedWorkMode; reason: string } {
  const text = normalise(request);

  const forbidsChanges = matches(text, NO_CODE_SIGNALS);
  const wantsPlan = matches(text, PLAN_DELIVERABLE_SIGNALS);
  const namesChange = matches(text, CHANGE_SIGNALS);
  const asksQuestion = matches(text, QUESTION_SIGNALS);
  const wantsJudgement = matches(text, INVESTIGATION_SIGNALS);

  const readOnly =
    forbidsChanges || wantsPlan || (!namesChange && (asksQuestion || wantsJudgement));

  if (!readOnly) {
    return namesChange
      ? { mode: 'build', reason: 'the request names a change to make' }
      : { mode: 'build', reason: 'nothing in the request asks for a plan or an answer' };
  }

  if (asksQuestion && !wantsPlan && !wantsJudgement) {
    return { mode: 'ask', reason: 'the request asks about code that already exists' };
  }
  if (wantsPlan) {
    return { mode: 'plan', reason: 'the request asks for a plan as the deliverable' };
  }
  if (forbidsChanges) {
    return { mode: 'plan', reason: 'the request says not to change code' };
  }
  return { mode: 'plan', reason: 'the request asks for investigation rather than a change' };
}

/** Turns the selected mode into the mode a run will execute in. */
export function resolveWorkMode(mode: WorkMode, request: string): WorkModeResolution {
  if (mode === 'auto') {
    const { mode: chosen, reason } = classifyRequest(request);
    return { mode: chosen, reason, automatic: true };
  }
  return {
    mode,
    reason: `${WORK_MODE_LABELS[mode]} mode was selected for this run`,
    automatic: false,
  };
}

/**
 * The mode a stored run is executing in.
 *
 * Tolerant on purpose. A run written before modes existed has no resolved
 * mode, and a row whose value is unrecognised is treated as a build run,
 * because that is what every run did before this existed.
 */
export function effectiveWorkMode(run: {
  mode: string;
  resolvedMode: string | null;
}): ResolvedWorkMode {
  const candidate = run.resolvedMode ?? run.mode;
  if (candidate === 'plan') return 'plan';
  if (candidate === 'ask') return 'ask';
  return 'build';
}

/** Whether a mode is forbidden from changing files. */
export const isReadOnlyMode = (mode: ResolvedWorkMode): boolean => mode !== 'build';
