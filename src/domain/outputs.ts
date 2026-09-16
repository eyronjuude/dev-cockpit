import { WORK_MODE_LABELS, WORK_MODE_WORDING, type ResolvedWorkMode } from './modes';
import { isFinished, type RunStatus } from './types';
import { DEFAULT_UI_PATTERNS, matchesPathPatterns } from './validation-steps';

/**
 * Which single output the Preview tab shows, and why.
 *
 * The tab used to mean one thing — the project's development command in an
 * iframe — which is right for a build run that changed a website and wrong for
 * everything else. An Ask run and a Plan run never start a dev server, so the
 * tab sat empty for a run whose whole output was a document.
 *
 * The deliverables already exist as stored artifacts, so this is a ranking
 * problem rather than a plumbing one. Pure, importing nothing outside
 * `domain/`, so the browser and the server reach the same answer.
 *
 * **One output is shown.** `alternatives` exists so a wrong pick costs a click
 * rather than being a dead end, and is rendered as inline links in the reason
 * line rather than a second row of tabs — the run screen already has nine.
 * Comparing two outputs side by side is what the Artifacts tab is for.
 *
 * The tab renders the stored *artifact*, not the `finalText` the Overview tab
 * shows. Same text, different status: the artifact is the deliverable of
 * record, with an id, a pass number, an expiry state and a download behind it.
 */

export const RUN_OUTPUT_KINDS = ['document', 'page', 'site'] as const;
export type RunOutputKind = (typeof RUN_OUTPUT_KINDS)[number];

/**
 * Where the bytes come from.
 *
 * A discriminated union rather than two optional fields, so the renderer's
 * switch is checked by the compiler rather than by hand.
 */
export type RunOutputSource =
  | { source: 'artifact'; artifactId: string; mimeType: string }
  | { source: 'devServer' };

export interface RunOutput {
  /**
   * Deterministic, and derived from the artifact rather than from list
   * position: the snapshot refetches every few seconds while a run is active,
   * and an index-derived id would move the user's selection under them.
   */
  id: string;
  kind: RunOutputKind;
  /** Short noun for the reason line: "plan", "rendered site". */
  label: string;
  /** Why the tab picked this, as a sentence. */
  reason: string;
  /**
   * Where to go to get a better output than this one, when the reason is a
   * missing project setting rather than something about this run. Null when
   * there is nothing a settings change would fix (e.g. the worktree is gone).
   */
  settingsHref: string | null;
  source: RunOutputSource;
}

export interface RunOutputSelection {
  /** The one thing the tab renders. */
  shown: RunOutput | null;
  /** Offered as inline links beside the reason. Never contains `shown`. */
  alternatives: RunOutput[];
  /** Set exactly when `shown` is null. */
  emptyReason: string | null;
  /** Same condition as `emptyReason`: the settings fix for it, if any. */
  emptyReasonHref: string | null;
  /**
   * How many earlier passes produced the same kind of deliverable.
   *
   * The newest is shown and the rest stay in the Artifacts tab — the same
   * arrangement the implementation map already uses for its earlier passes.
   */
  olderPasses: number;
}

/** At most this many alternatives, so the reason line stays one line. */
const MAX_ALTERNATIVES = 3;

/* ------------------------------------------------------------------ *
 * Structural inputs
 * ------------------------------------------------------------------ */

/** The part of an `ArtifactView` the ranking needs. `domain` imports no services. */
export interface OutputArtifact {
  id: string;
  kind: string;
  label: string;
  mimeType: string;
  createdAt: string;
  exists: boolean;
  expiredAt: string | null;
}

export interface OutputChangedFile {
  path: string;
  changeType: string;
}

export interface OutputPreviewState {
  configured: boolean;
  running: boolean;
}

export interface RunOutputInput {
  mode: ResolvedWorkMode;
  status: RunStatus;
  /** Whether the orchestrator is working on this run right now. */
  active: boolean;
  request: string;
  changedFiles: readonly OutputChangedFile[];
  artifacts: readonly OutputArtifact[];
  preview: OutputPreviewState;
  hasWorktree: boolean;
  uiPathPatterns: readonly string[];
  /** Where the settings-fix links below point: `/projects/{projectId}`. */
  projectId: string;
}

/** The project settings page, scrolled to the field that would fix a missing preview. */
const previewSettingsHref = (projectId: string): string => `/projects/${projectId}#dev-command`;

/* ------------------------------------------------------------------ *
 * Facts
 * ------------------------------------------------------------------ */

/**
 * Directories whose contents are produced rather than written.
 *
 * A test-only run that regenerates `coverage/lcov-report/index.html` is the
 * realistic false positive: without this it would look like a run whose sole
 * deliverable was an HTML page.
 */
const BUILD_OUTPUT_SEGMENTS = [
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.turbo',
  'target',
  'vendor',
  'playwright-report',
  'test-results',
];

/** Top-level directories a development server serves as part of the site. */
const SERVED_DIR_SEGMENTS = ['public', 'static', 'assets', 'www', 'site'];

const HTML_PATTERN = /\.x?html?$/i;

/** The artifact kinds that hold a run's own deliverable. */
const DOCUMENT_KINDS = ['plan', 'answer', 'markdown_report'] as const;

/** A standalone page the agent wrote, copied out of the worktree. */
export const PAGE_KIND = 'html_page';

const DOCUMENT_LABELS: Record<string, string> = {
  plan: 'plan',
  answer: 'answer',
  markdown_report: 'summary',
};

export interface RunOutputFacts {
  /** Changed HTML files that are neither build output nor part of the site. */
  standalonePages: string[];
  /** Whether any changed file matches the project's UI patterns. */
  touchesSite: boolean;
  /** Whether a development server could be started for this run. */
  previewable: boolean;
  /** Newest usable artifact per kind. */
  newest: Map<string, OutputArtifact>;
  /** Earlier passes per kind, which stay in the Artifacts tab. */
  olderPasses: Map<string, number>;
  /** Deliverable artifacts whose bytes retention has reclaimed. */
  expiredDocuments: OutputArtifact[];
}

const patternsFor = (uiPathPatterns: readonly string[]): readonly string[] =>
  uiPathPatterns.length > 0 ? uiPathPatterns : DEFAULT_UI_PATTERNS;

const segmentsOf = (path: string): string[] =>
  path.split(/[\\/]+/).filter(Boolean).map((segment) => segment.toLowerCase());

const isBuildOutput = (path: string): boolean =>
  segmentsOf(path).some((segment) => BUILD_OUTPUT_SEGMENTS.includes(segment));

const isServedByDevServer = (path: string, uiPathPatterns: readonly string[]): boolean => {
  const first = segmentsOf(path)[0];
  if (first !== undefined && SERVED_DIR_SEGMENTS.includes(first)) return true;
  return matchesPathPatterns([path], patternsFor(uiPathPatterns));
};

const isDeliverableKind = (kind: string): boolean =>
  kind === PAGE_KIND || (DOCUMENT_KINDS as readonly string[]).includes(kind);

/** Everything the rules read, computed once so no two rules can derive it differently. */
export function summariseOutputFacts(input: RunOutputInput): RunOutputFacts {
  const paths = input.changedFiles.map((file) => file.path);

  const standalonePages = input.changedFiles
    .filter((file) => file.changeType !== 'deleted')
    .map((file) => file.path)
    .filter((path) => HTML_PATTERN.test(path))
    .filter((path) => !isBuildOutput(path))
    .filter((path) => !isServedByDevServer(path, input.uiPathPatterns));

  // Newest per kind by `createdAt`, with input order breaking a tie. Artifacts
  // arrive oldest-first, so the tie-break is "later in the list wins".
  const ranked = input.artifacts
    .map((artifact, index) => ({ artifact, index }))
    .sort((a, b) =>
      a.artifact.createdAt === b.artifact.createdAt
        ? a.index - b.index
        : a.artifact.createdAt.localeCompare(b.artifact.createdAt),
    );

  const newest = new Map<string, OutputArtifact>();
  const usableByKind = new Map<string, number>();
  const expiredDocuments: OutputArtifact[] = [];

  for (const { artifact } of ranked) {
    if (artifact.expiredAt !== null || !artifact.exists) {
      if (isDeliverableKind(artifact.kind)) expiredDocuments.push(artifact);
      continue;
    }
    usableByKind.set(artifact.kind, (usableByKind.get(artifact.kind) ?? 0) + 1);
    newest.set(artifact.kind, artifact);
  }

  const olderPasses = new Map<string, number>();
  for (const [kind, count] of usableByKind) olderPasses.set(kind, Math.max(0, count - 1));

  return {
    standalonePages,
    touchesSite: matchesPathPatterns(paths, patternsFor(input.uiPathPatterns)),
    previewable: input.preview.configured && input.hasWorktree,
    newest,
    olderPasses,
    expiredDocuments,
  };
}

/**
 * The standalone pages a run wrote, for the service that copies them into
 * artifacts. Exported so that decision stays testable without a worktree.
 */
export function selectStandalonePages(input: RunOutputInput): string[] {
  return summariseOutputFacts(input).standalonePages;
}

/* ------------------------------------------------------------------ *
 * Did the request ask for a page?
 * ------------------------------------------------------------------ */

/**
 * Whether the request asked for a standalone page or a visualisation.
 *
 * Shaped like `classifyRequest` in `domain/modes.ts`, and used only to break a
 * tie between two outputs that both exist — so a false positive costs an
 * ordering, never a wrong screen. A request that merely mentions a chart or
 * some HTML is not asking for one: every pattern needs a create verb or an
 * explicit deliverable noun.
 */
const VISUAL_DELIVERABLE_SIGNALS: readonly RegExp[] = [
  /\b(?:html|web)\s+page\b/,
  /\bvisuali[sz](?:e|ation|ations)\b/,
  /\b(?:infographic|one[\s-]pager|mock\s?up|slide\s+deck|landing\s+page)\b/,
  /\b(?:build|make|create|write|generate|produce|draft|render)\b[^.!?]{0,40}?\b(?:dashboard|report|chart|graph|diagram|timeline)\b/,
  /\b(?:report|dashboard)\s+(?:page|artifact|artefact)\b/,
];

const normalise = (request: string): string =>
  request.toLowerCase().replace(/[‘’]/g, "'");

export function wantsVisualArtifact(request: string): boolean {
  const text = normalise(request);
  return VISUAL_DELIVERABLE_SIGNALS.some((pattern) => pattern.test(text));
}

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

function documentOutput(
  artifact: OutputArtifact,
  reason: string,
  settingsHref: string | null = null,
): RunOutput {
  return {
    id: `artifact:${artifact.id}`,
    kind: 'document',
    label: DOCUMENT_LABELS[artifact.kind] ?? 'document',
    reason,
    settingsHref,
    source: { source: 'artifact', artifactId: artifact.id, mimeType: artifact.mimeType },
  };
}

function pageOutput(artifact: OutputArtifact, reason: string): RunOutput {
  return {
    id: `artifact:${artifact.id}`,
    kind: 'page',
    label: 'page',
    reason,
    settingsHref: null,
    source: { source: 'artifact', artifactId: artifact.id, mimeType: artifact.mimeType },
  };
}

function siteOutput(reason: string): RunOutput {
  return {
    id: 'dev-server',
    kind: 'site',
    label: 'rendered site',
    reason,
    settingsHref: null,
    source: { source: 'devServer' },
  };
}

const fileCount = (n: number): string => (n === 1 ? '1 file' : `${n} files`);

interface OutputRule {
  id: string;
  applies(input: RunOutputInput, facts: RunOutputFacts): RunOutput | null;
}

/**
 * Evaluated in order, first match wins, so this reads as a priority list
 * rather than as nested conditions.
 */
const RULES: readonly OutputRule[] = [
  {
    /** A read-only run's deliverable is its document, whatever else exists. */
    id: 'read-only-deliverable',
    applies(input, facts) {
      if (input.mode === 'build') return null;
      const kind = input.mode === 'plan' ? 'plan' : 'answer';
      const artifact = facts.newest.get(kind);
      if (!artifact) return null;
      return documentOutput(
        artifact,
        `${WORK_MODE_LABELS[input.mode]} mode produces a ${DOCUMENT_LABELS[kind]}, and this is it.`,
      );
    },
  },
  {
    /** The whole change is one page. There is nothing else it could mean. */
    id: 'page-is-the-only-change',
    applies(_input, facts) {
      if (facts.touchesSite) return null;
      if (facts.standalonePages.length !== 1) return null;
      const artifact = facts.newest.get(PAGE_KIND);
      if (!artifact) return null;
      return pageOutput(artifact, `The only file this run changed is ${facts.standalonePages[0]}.`);
    },
  },
  {
    /** A page was written and the request asked for one. A tie-break, not a guess. */
    id: 'page-was-requested',
    applies(input, facts) {
      if (facts.standalonePages.length === 0) return null;
      if (!wantsVisualArtifact(input.request)) return null;
      const artifact = facts.newest.get(PAGE_KIND);
      if (!artifact) return null;
      return pageOutput(artifact, `You asked for a page, and this run wrote ${facts.standalonePages[0]}.`);
    },
  },
  {
    id: 'site-changed',
    applies(input, facts) {
      if (!facts.touchesSite || !facts.previewable) return null;
      return siteOutput(
        `${fileCount(input.changedFiles.length)} changed, and this project has a development command.`,
      );
    },
  },
  {
    /**
     * Nothing matched a UI pattern — but a change to what a page *displays*
     * rarely does. A new profit calculation touches no `.tsx` file and is still
     * only visible on the page that shows the figure.
     */
    id: 'site-is-what-there-is',
    applies(_input, facts) {
      if (!facts.previewable) return null;
      return siteOutput(
        'This project has a development command, so the running site is what there is to show.',
      );
    },
  },
  {
    id: 'page-without-a-server',
    applies(input, facts) {
      const artifact = facts.newest.get(PAGE_KIND);
      if (!artifact) return null;
      return pageOutput(
        artifact,
        input.preview.configured
          ? 'This run no longer has a worktree to serve from, and this run wrote an HTML page.'
          : 'No development command is configured, and this run wrote an HTML page.',
      );
    },
  },
  {
    id: 'implementation-summary',
    applies(input, facts) {
      const artifact = facts.newest.get('markdown_report');
      if (!artifact) return null;
      // Both causes of `!facts.previewable` land here, but only one of them
      // is a settings change away from a real preview next time.
      return input.preview.configured
        ? documentOutput(
            artifact,
            'This run no longer has a worktree to serve from, so here is what it did.',
          )
        : documentOutput(
            artifact,
            'No development command is configured, so the run wrote up what it did.',
            previewSettingsHref(input.projectId),
          );
    },
  },
];

/** Every output a run has, in a fixed order, regardless of which is shown. */
function allOutputs(facts: RunOutputFacts): RunOutput[] {
  const outputs: RunOutput[] = [];

  for (const kind of DOCUMENT_KINDS) {
    const artifact = facts.newest.get(kind);
    if (artifact) {
      outputs.push(documentOutput(artifact, `The ${DOCUMENT_LABELS[kind]} this run wrote.`));
    }
  }

  const page = facts.newest.get(PAGE_KIND);
  if (page) outputs.push(pageOutput(page, 'An HTML page this run wrote.'));

  if (facts.previewable) {
    outputs.push(siteOutput('This project develops with a running server.'));
  }

  return outputs;
}

export interface NoOutputExplanation {
  text: string;
  /** Set only when a settings change, not just time or a finished run, would fix it. */
  href: string | null;
}

const explanation = (text: string, href: string | null = null): NoOutputExplanation => ({
  text,
  href,
});

/**
 * What to say when there is nothing to show.
 *
 * Distinct reasons get distinct sentences, each naming somewhere else to look.
 * "No preview" with no explanation is the state this whole module exists to
 * remove.
 */
export function describeNoOutput(
  input: RunOutputInput,
  facts: RunOutputFacts,
): NoOutputExplanation {
  const wording = WORK_MODE_WORDING[input.mode];

  if (facts.expiredDocuments.length > 0) {
    return explanation(
      `This run's ${wording.deliverable} was reclaimed under the project's artifact retention policy. The record of it is still in the Artifacts tab.`,
    );
  }

  if (input.active) {
    return explanation(`The ${wording.deliverable} appears here when the ${wording.agentNoun} finishes.`);
  }

  if (input.mode !== 'build') {
    return explanation(
      isFinished(input.status)
        ? `This run finished without producing a ${wording.deliverable}. The Logs tab has what the ${wording.agentNoun} did.`
        : `No ${wording.deliverable} has been written yet.`,
    );
  }

  if (!input.preview.configured) {
    return explanation(
      'This project has no development command, so there is no site to show. What the run changed is in the Changes and Diff tabs.',
      previewSettingsHref(input.projectId),
    );
  }

  if (!input.hasWorktree) {
    return explanation(
      'This run no longer has a worktree, so there is nothing left to serve. What it changed is in the Changes and Diff tabs.',
    );
  }

  return explanation('Nothing previewable yet. What the run changed is in the Changes and Diff tabs.');
}

/** Which output to show, which to offer instead, and why. */
export function selectRunOutputs(input: RunOutputInput): RunOutputSelection {
  const facts = summariseOutputFacts(input);

  let shown: RunOutput | null = null;
  for (const rule of RULES) {
    shown = rule.applies(input, facts);
    if (shown) break;
  }

  if (!shown) {
    const noOutput = describeNoOutput(input, facts);
    return {
      shown: null,
      alternatives: [],
      emptyReason: noOutput.text,
      emptyReasonHref: noOutput.href,
      olderPasses: 0,
    };
  }

  const chosen = shown;
  const alternatives = allOutputs(facts)
    .filter((output) => output.id !== chosen.id)
    .slice(0, MAX_ALTERNATIVES);

  const shownKind =
    chosen.source.source === 'artifact'
      ? [...facts.newest.entries()].find(
          ([, artifact]) =>
            chosen.source.source === 'artifact' && artifact.id === chosen.source.artifactId,
        )?.[0]
      : undefined;

  return {
    shown: chosen,
    alternatives,
    emptyReason: null,
    emptyReasonHref: null,
    olderPasses: shownKind ? (facts.olderPasses.get(shownKind) ?? 0) : 0,
  };
}
