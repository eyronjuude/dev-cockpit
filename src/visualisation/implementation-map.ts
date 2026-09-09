import {
  FINDING_SEVERITIES,
  VALIDATION_KINDS,
  type ChangeType,
  type FindingSeverity,
  type IterationKind,
  type IterationStatus,
  type RunStatus,
  type ValidationKind,
  type ValidationOutcome,
} from '@/domain/types';
import {
  CHANGE_TYPE_TONE,
  formatDuration,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  SEVERITY_TONE,
  type BadgeTone,
} from '@/domain/vocabulary';

/**
 * The implementation map: one picture of what a run actually did.
 *
 * Every value drawn here is read back out of stored run state — iterations,
 * recorded file changes, validation outcomes, review findings and the event
 * log. Nothing is asked of a model and nothing is taken from the implementer's
 * closing message, so the map is evidence on the same footing as the diff
 * rather than a second rendering of the agent's claim.
 *
 * It draws to a self-contained SVG because that is the one format the artifact
 * browser can already show inline, it scales to any panel width, it needs no
 * dependency, and it stays readable when opened on its own years later.
 *
 * This module is deliberately pure: plain data in, a string out, so the layout
 * can be tested without a database, a worktree or a filesystem.
 */

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

export interface MapIteration {
  kind: IterationKind;
  status: IterationStatus;
  numTurns: number | null;
}

export interface MapFile {
  path: string;
  changeType: ChangeType;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface MapValidation {
  kind: ValidationKind;
  outcome: ValidationOutcome;
  blocking: boolean;
  exitCode: number | null;
  durationMs: number | null;
}

export interface MapFinding {
  severity: FindingSeverity;
}

/** Only the two fields the map reads; a stored event carries much more. */
export interface MapEvent {
  type: string;
  message: string;
}

export interface MapRun {
  id: string;
  title: string;
  request: string;
  status: RunStatus;
  statusReason: string | null;
  profile: string;
  branch: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  spec: string | null;
  specProvider: string | null;
  transformerProvider: string;
  reviewerProvider: string;
  costUsd: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ImplementationMapInput {
  run: MapRun;
  projectName: string;
  iterations: readonly MapIteration[];
  changedFiles: readonly MapFile[];
  /** The latest validation attempt only, including `not_configured` rows. */
  validations: readonly MapValidation[];
  /** The latest review attempt only. */
  findings: readonly MapFinding[];
  events: readonly MapEvent[];
  /** ISO timestamp stamped into the footer. */
  generatedAt: string;
}

/* ------------------------------------------------------------------ *
 * Stages
 * ------------------------------------------------------------------ */

export const STAGE_STATES = [
  'done',
  'active',
  'blocked',
  'failed',
  'cancelled',
  'skipped',
  'empty',
  'pending',
] as const;

export type StageState = (typeof STAGE_STATES)[number];

const STAGE_TONE: Record<StageState, BadgeTone> = {
  done: 'pass',
  active: 'running',
  blocked: 'warn',
  failed: 'fail',
  cancelled: 'idle',
  skipped: 'idle',
  empty: 'idle',
  pending: 'idle',
};

/**
 * `skipped`, `no change` and `not run` are three different words on purpose,
 * and none of them is `failed`. This is the rule the validation scorecard
 * already follows: a stage that never ran has not produced an empty result, and
 * neither of those has failed.
 */
const STAGE_LABEL: Record<StageState, string> = {
  done: 'done',
  active: 'running',
  blocked: 'blocked',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
  empty: 'no change',
  pending: 'not run',
};

export interface MapStage {
  key: string;
  name: string;
  state: StageState;
  /** What the badge reads. Usually the state, overridden for the verdict. */
  badge: string;
  tone: BadgeTone;
  detail: string;
}

function stage(
  key: string,
  name: string,
  state: StageState,
  detail: string,
  override: { badge?: string; tone?: BadgeTone } = {},
): MapStage {
  return {
    key,
    name,
    state,
    badge: override.badge ?? STAGE_LABEL[state],
    tone: override.tone ?? STAGE_TONE[state],
    detail,
  };
}

function lastEventOfTypes(events: readonly MapEvent[], types: readonly string[]): MapEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && types.includes(event.type)) return event;
  }
  return null;
}

const VERDICT_STATE: Record<RunStatus, StageState> = {
  DRAFT: 'pending',
  PREPARING: 'active',
  IMPLEMENTING: 'active',
  VALIDATING: 'active',
  REVIEWING: 'active',
  NEEDS_CHANGES: 'blocked',
  READY: 'done',
  APPROVED: 'done',
  LANDING: 'active',
  // A conflict is waiting on a person, not a failure of the implementation.
  MERGE_CONFLICT: 'blocked',
  LANDING_FAILED: 'failed',
  LANDED: 'done',
  REJECTED: 'cancelled',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** `pluralForm` is for the words an `s` does not fit, such as "retries". */
function plural(count: number, word: string, pluralForm?: string): string {
  if (count === 1) return `${count} ${word}`;
  return `${count} ${pluralForm ?? `${word}s`}`;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : 'unknown';
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

/**
 * Works out what each stage of the pipeline did.
 *
 * Exported separately from the drawing so the derivation can be asserted
 * directly rather than by reading pixels back out of an SVG.
 */
export function deriveStages(input: ImplementationMapInput): MapStage[] {
  const { run, events, iterations, changedFiles, validations, findings } = input;

  /* Request */
  const words = run.request.trim().split(/\s+/).filter(Boolean).length;
  const request = stage('request', 'Request', 'done', `${plural(words, 'word')}, stored verbatim`);

  /* Specification */
  const transform = lastEventOfTypes(events, [
    'transform.completed',
    'transform.skipped',
    'transform.failed',
  ]);
  let specification: MapStage;
  if (transform?.type === 'transform.completed') {
    specification = stage(
      'specification',
      'Specification',
      'done',
      `rewritten by ${run.specProvider ?? 'a transformer'}`,
    );
  } else if (transform?.type === 'transform.failed') {
    specification = stage(
      'specification',
      'Specification',
      'skipped',
      'the transformer failed; the request was used as written',
    );
  } else if (transform?.type === 'transform.skipped') {
    specification = stage(
      'specification',
      'Specification',
      'skipped',
      run.transformerProvider === 'none'
        ? 'no transformer configured; the request was used as written'
        : `${run.transformerProvider} was unavailable`,
    );
  } else {
    specification = run.spec
      ? stage('specification', 'Specification', 'done', 'recorded on the run')
      : stage('specification', 'Specification', 'pending', 'no specification recorded');
  }

  /* Worktree */
  const prepared = lastEventOfTypes(events, ['worktree.prepared']);
  const worktree =
    prepared || run.baseCommit
      ? stage(
          'worktree',
          'Worktree',
          'done',
          `${run.branch ?? 'run branch'} from ${run.baseBranch ?? 'base'}@${shortSha(run.baseCommit)}`,
        )
      : stage('worktree', 'Worktree', 'pending', 'no isolated worktree prepared');

  /* Implementation */
  const last = iterations.length > 0 ? iterations[iterations.length - 1] : undefined;
  const turns = sumBy(iterations, (it) => it.numTurns ?? 0);
  const implementationState: StageState = !last
    ? 'pending'
    : last.status === 'completed'
      ? 'done'
      : last.status === 'failed'
        ? 'failed'
        : last.status === 'cancelled'
          ? 'cancelled'
          : 'active';
  const changeRequests = iterations.filter((it) => it.kind === 'change_request').length;
  // Counted separately from change requests: a retry asked for the same thing
  // again, which says something different about the run than a revision does.
  const retries = iterations.filter((it) => it.kind === 'retry').length;
  const implementation = stage(
    'implementation',
    'Implementation',
    implementationState,
    last
      ? [
          plural(iterations.length, 'iteration'),
          changeRequests > 0 ? plural(changeRequests, 'change request') : null,
          retries > 0 ? plural(retries, 'retry', 'retries') : null,
          turns > 0 ? plural(turns, 'turn') : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'the agent has not run',
  );

  /* Changes */
  const additions = sumBy(changedFiles, (f) => f.additions);
  const deletions = sumBy(changedFiles, (f) => f.deletions);
  const changes =
    changedFiles.length > 0
      ? stage(
          'changes',
          'Changes',
          'done',
          `${plural(changedFiles.length, 'file')} · +${additions} −${deletions}`,
        )
      : implementationState === 'pending'
        ? stage('changes', 'Changes', 'pending', 'nothing has been implemented yet')
        : stage('changes', 'Changes', 'empty', 'the worktree matches its base commit');

  /* Validation */
  const ran = validations.filter((v) => v.outcome !== 'not_configured');
  const passed = ran.filter((v) => v.outcome === 'pass').length;
  const failed = ran.filter((v) => v.outcome === 'fail' || v.outcome === 'error').length;
  const notConfigured = validations.length - ran.length;
  const blockingFailure = ran.some(
    (v) => v.blocking && (v.outcome === 'fail' || v.outcome === 'error'),
  );
  let validation: MapStage;
  if (validations.length === 0) {
    validation = stage('validation', 'Validation', 'pending', 'validation has not run');
  } else if (ran.length === 0) {
    validation = stage(
      'validation',
      'Validation',
      'skipped',
      'this project has no validation commands configured',
    );
  } else {
    const state: StageState = blockingFailure
      ? 'failed'
      : ran.some((v) => v.outcome === 'running')
        ? 'active'
        : 'done';
    // An advisory failure is named rather than hidden: it did fail, it simply
    // cannot hold the run back.
    const advisory = failed > 0 && !blockingFailure ? ' (advisory)' : '';
    validation = stage(
      'validation',
      'Validation',
      state,
      `${passed} passed · ${failed} failed${advisory} · ${notConfigured} not configured`,
    );
  }

  /* Review */
  const review = lastEventOfTypes(events, ['review.completed', 'review.skipped']);
  const blockingFindings = findings.filter(
    (f) => f.severity === 'high' || f.severity === 'critical',
  ).length;
  let reviewStage: MapStage;
  if (review?.type === 'review.completed') {
    reviewStage = stage(
      'review',
      'Review',
      'done',
      `${plural(findings.length, 'finding')}, ${blockingFindings} blocking`,
    );
  } else if (review?.type === 'review.skipped') {
    reviewStage = stage('review', 'Review', 'skipped', review.message);
  } else if (run.reviewerProvider === 'none') {
    reviewStage = stage('review', 'Review', 'skipped', 'no independent reviewer was configured');
  } else {
    reviewStage = stage('review', 'Review', 'pending', 'review has not run');
  }

  /* Verdict */
  const verdict = stage(
    'verdict',
    'Verdict',
    VERDICT_STATE[run.status],
    run.statusReason ?? 'no reason recorded',
    { badge: RUN_STATUS_LABEL[run.status], tone: RUN_STATUS_TONE[run.status] },
  );

  return [
    request,
    specification,
    worktree,
    implementation,
    changes,
    validation,
    reviewStage,
    verdict,
  ];
}

/* ------------------------------------------------------------------ *
 * Text description
 * ------------------------------------------------------------------ */

/**
 * The whole map as one paragraph of plain text.
 *
 * Written into the SVG `<desc>` and reused as the image's alt text, so the
 * artifact is legible to a screen reader and greppable on disk instead of being
 * information that only exists as pixels.
 */
export function describeImplementationMap(input: ImplementationMapInput): string {
  const { run, changedFiles, validations } = input;
  const stages = deriveStages(input);
  const additions = sumBy(changedFiles, (f) => f.additions);
  const deletions = sumBy(changedFiles, (f) => f.deletions);

  const checks = VALIDATION_KINDS.map((kind) => {
    const result = validations.find((v) => v.kind === kind);
    return `${kind} ${OUTCOME_LABEL[result?.outcome ?? 'not_configured'].toLowerCase()}`;
  }).join(', ');

  return [
    `Implementation map for run ${run.id} of ${input.projectName}: ${run.title}.`,
    `Status ${RUN_STATUS_LABEL[run.status]}.`,
    `Pipeline — ${stages.map((s) => `${s.name}: ${s.badge}`).join('; ')}.`,
    `${plural(changedFiles.length, 'file')} changed, ${additions} lines added and ${deletions} removed.`,
    `Checks — ${checks}.`,
  ].join(' ');
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

const W = 760;
const PAD = 20;
const INNER = W - PAD * 2;
const RIGHT = W - PAD;

const PALETTE = {
  base: '#0b0d10',
  surface: '#12151a',
  raised: '#171b22',
  line: '#232935',
  lineStrong: '#303845',
  ink: '#e6e9ef',
  inkMuted: '#9aa4b2',
  inkFaint: '#6b7480',
};

/**
 * The badge classes of `globals.css`, resolved to literal values.
 *
 * An SVG loaded through `<img>` gets no stylesheet and no custom properties, so
 * the palette has to be inlined here. These track the `--color-*` tokens; which
 * tone a state belongs to is still decided once, in `@/domain/vocabulary`.
 */
const TONE_COLOURS: Record<BadgeTone, { fg: string; bg: string; border: string }> = {
  pass: { fg: '#3fb950', bg: '#123018', border: '#1d4d28' },
  fail: { fg: '#f85149', bg: '#3d1418', border: '#5f2429' },
  warn: { fg: '#d29922', bg: '#3a2c0a', border: '#57420f' },
  running: { fg: '#58a6ff', bg: '#10243e', border: '#1f4a7d' },
  idle: { fg: '#6b7480', bg: '#1a1e24', border: '#232935' },
  accent: { fg: '#8fc0ff', bg: '#1b3557', border: '#2a4d7d' },
};

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace";

/** Rough advance widths as a fraction of the font size. Used only to clip. */
const SANS_RATIO = 0.545;
const MONO_RATIO = 0.6;

const HEADER_H = 84;
const SECTION_H = 26;
const STAGE_ROW_H = 32;
const CHECK_H = 44;
const GROUP_ROW_H = 21;
const FILE_ROW_H = 19;
const BADGE_W = 96;
const BAR_X = 350;
const BAR_W = 240;

/** Enough to see the shape of a change without producing a poster. */
const MAX_FILE_ROWS = 40;

const SPACE = 0x20;
const DELETE = 0x7f;

/**
 * Drops the characters XML 1.0 cannot represent at all.
 *
 * Done by code point rather than by a regex so the source of this file stays
 * free of the very bytes it is removing. One stray control character in a file
 * path would otherwise produce an image no parser will open.
 */
function stripControl(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? SPACE;
    if (code < SPACE || code === DELETE) continue;
    out += char;
  }
  return out;
}

/** XML-safe text. */
function esc(value: string): string {
  return stripControl(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clip(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  if (maxChars <= 1) return '…';
  return `${flat.slice(0, maxChars - 1)}…`;
}

/** Clips to whatever fits in `px` at `size` for the given advance ratio. */
function fit(value: string, px: number, size: number, ratio = SANS_RATIO): string {
  return clip(value, Math.max(1, Math.floor(px / (size * ratio))));
}

interface TextOptions {
  size?: number;
  fill?: string;
  family?: string;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
}

/** Two decimals is past the resolution of any renderer, and keeps the file small. */
function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function label(x: number, y: number, value: string, options: TextOptions = {}): string {
  const attrs = [
    `x="${num(x)}"`,
    `y="${num(y)}"`,
    `font-family="${options.family ?? SANS}"`,
    `font-size="${options.size ?? 12}"`,
    `fill="${options.fill ?? PALETTE.ink}"`,
  ];
  if (options.weight) attrs.push(`font-weight="${options.weight}"`);
  if (options.anchor && options.anchor !== 'start') attrs.push(`text-anchor="${options.anchor}"`);
  return `<text ${attrs.join(' ')}>${esc(value)}</text>`;
}

function box(
  x: number,
  y: number,
  w: number,
  h: number,
  options: { fill?: string; stroke?: string; rx?: number } = {},
): string {
  const attrs = [
    `x="${num(x)}"`,
    `y="${num(y)}"`,
    `width="${num(Math.max(0, w))}"`,
    `height="${num(Math.max(0, h))}"`,
  ];
  if (options.rx) attrs.push(`rx="${options.rx}"`);
  attrs.push(`fill="${options.fill ?? 'none'}"`);
  if (options.stroke) attrs.push(`stroke="${options.stroke}"`);
  return `<rect ${attrs.join(' ')} />`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: string): string {
  return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${stroke}" />`;
}

function dot(cx: number, cy: number, r: number, fill: string, ring?: string): string {
  const halo = ring ? ` stroke="${ring}" stroke-width="2"` : '';
  return `<circle cx="${num(cx)}" cy="${num(cy)}" r="${r}" fill="${fill}"${halo} />`;
}

/** Hairlines sit on a half pixel so they render crisp rather than smeared. */
function rule(y: number, x1 = 0, x2 = W, stroke = PALETTE.line): string {
  return line(x1, y + 0.5, x2, y + 0.5, stroke);
}

function badgeWidth(text: string, size: number): number {
  return Math.round(text.length * size * SANS_RATIO) + 18;
}

function badge(
  x: number,
  y: number,
  text: string,
  tone: BadgeTone,
  options: { width?: number; height?: number; size?: number } = {},
): string {
  const size = options.size ?? 10.5;
  const height = options.height ?? 18;
  const width = options.width ?? badgeWidth(text, size);
  const colours = TONE_COLOURS[tone];
  return (
    box(x, y, width, height, { fill: colours.bg, stroke: colours.border, rx: 4 }) +
    label(x + width / 2, y + height / 2 + size * 0.36, text, {
      size,
      fill: colours.fg,
      weight: 600,
      anchor: 'middle',
    })
  );
}

function sectionTitle(y: number, text: string, note?: string): string {
  return (
    label(PAD, y + 15, text.toUpperCase(), { size: 10, fill: PALETTE.inkMuted, weight: 600 }) +
    (note
      ? label(RIGHT, y + 15, fit(note, 400, 10), {
          size: 10,
          fill: PALETTE.inkFaint,
          anchor: 'end',
        })
      : '')
  );
}

function elapsed(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) return 'duration unknown';
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 'duration unknown';
  return formatDuration(end - start);
}

export interface FileGroup {
  dir: string;
  files: MapFile[];
  additions: number;
  deletions: number;
}

/** Groups by containing directory, so the map reads as areas of the codebase. */
export function groupChangedFiles(files: readonly MapFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();

  for (const file of files) {
    const normalised = file.path.replace(/\\/g, '/');
    const cut = normalised.lastIndexOf('/');
    const dir = cut === -1 ? '(repository root)' : normalised.slice(0, cut);
    const group = groups.get(dir) ?? { dir, files: [], additions: 0, deletions: 0 };
    group.files.push({ ...file, path: normalised });
    group.additions += file.additions;
    group.deletions += file.deletions;
    groups.set(dir, group);
  }

  const churn = (group: FileGroup) => group.additions + group.deletions;
  for (const group of groups.values()) {
    group.files.sort(
      (a, b) =>
        b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path),
    );
  }

  return [...groups.values()].sort((a, b) => churn(b) - churn(a) || a.dir.localeCompare(b.dir));
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/* ------------------------------------------------------------------ *
 * The map
 * ------------------------------------------------------------------ */

export function renderImplementationMap(input: ImplementationMapInput): string {
  const { run, changedFiles, validations, findings } = input;
  const stages = deriveStages(input);
  const parts: string[] = [];
  let y = 0;

  /* Header */
  const statusLabel = RUN_STATUS_LABEL[run.status];
  const statusWidth = badgeWidth(statusLabel, 11) + 6;
  parts.push(box(0, 0, W, HEADER_H, { fill: PALETTE.surface }));
  parts.push(
    label(PAD, 32, fit(run.title, INNER - statusWidth - 16, 15.5), { size: 15.5, weight: 600 }),
  );
  parts.push(
    badge(RIGHT - statusWidth, 17, statusLabel, RUN_STATUS_TONE[run.status], {
      width: statusWidth,
      height: 22,
      size: 11,
    }),
  );
  parts.push(
    label(
      PAD,
      55,
      fit(
        `${input.projectName} · ${run.profile} profile · ${run.branch ?? 'no branch'}`,
        INNER,
        10.5,
        MONO_RATIO,
      ),
      { size: 10.5, family: MONO, fill: PALETTE.inkMuted },
    ),
  );
  parts.push(
    label(
      PAD,
      71,
      fit(
        `${run.id} · base ${run.baseBranch ?? '—'}@${shortSha(run.baseCommit)} · ${elapsed(
          run.startedAt,
          run.finishedAt,
        )} · ${run.costUsd === null ? 'cost not reported' : `$${run.costUsd.toFixed(4)}`}`,
        INNER,
        10.5,
        MONO_RATIO,
      ),
      { size: 10.5, family: MONO, fill: PALETTE.inkFaint },
    ),
  );
  parts.push(rule(HEADER_H));
  y = HEADER_H + 14;

  /* Pipeline */
  parts.push(sectionTitle(y, 'Pipeline', 'every stage, including the ones that did not run'));
  y += SECTION_H;

  const railX = PAD + 6;
  const firstNodeY = y + STAGE_ROW_H / 2;
  const lastNodeY = firstNodeY + (stages.length - 1) * STAGE_ROW_H;
  parts.push(line(railX, firstNodeY, railX, lastNodeY, PALETTE.lineStrong));

  const badgeX = railX + 136;
  const detailX = badgeX + BADGE_W + 12;
  stages.forEach((item, index) => {
    const midY = y + index * STAGE_ROW_H + STAGE_ROW_H / 2;
    const colours = TONE_COLOURS[item.tone];
    // The halo is the page colour, so the rail appears to pass behind the node.
    parts.push(dot(railX, midY, 4.5, colours.fg, PALETTE.base));
    parts.push(label(railX + 16, midY + 4, fit(item.name, 116, 12), { size: 12, weight: 500 }));
    parts.push(
      badge(badgeX, midY - 9, fit(item.badge, BADGE_W - 10, 10), item.tone, {
        width: BADGE_W,
        size: 10,
      }),
    );
    parts.push(
      label(detailX, midY + 4, fit(item.detail, RIGHT - detailX, 11), {
        size: 11,
        fill: PALETTE.inkMuted,
      }),
    );
  });
  y += stages.length * STAGE_ROW_H + 14;

  /* Checks */
  parts.push(
    sectionTitle(
      y,
      'Checks',
      validations.length === 0
        ? 'no validation attempt recorded'
        : 'the latest attempt, run against the worktree',
    ),
  );
  y += SECTION_H;

  const cellW = (INNER - 5 * 6) / 6;
  VALIDATION_KINDS.forEach((kind, index) => {
    const result = validations.find((v) => v.kind === kind);
    const outcome: ValidationOutcome = result?.outcome ?? 'not_configured';
    const colours = TONE_COLOURS[OUTCOME_TONE[outcome]];
    const x = PAD + index * (cellW + 6);
    parts.push(box(x, y, cellW, CHECK_H, { fill: PALETTE.surface, stroke: colours.border, rx: 6 }));
    parts.push(label(x + 9, y + 18, kind, { size: 10.5, weight: 600 }));
    parts.push(
      label(x + 9, y + 34, fit(OUTCOME_LABEL[outcome], cellW - 34, 10), {
        size: 10,
        fill: colours.fg,
        weight: 600,
      }),
    );
    parts.push(
      label(x + cellW - 9, y + 34, formatDuration(result?.durationMs ?? null), {
        size: 9.5,
        fill: PALETTE.inkFaint,
        anchor: 'end',
      }),
    );
  });
  y += CHECK_H + 14;

  /* Change map */
  const additions = sumBy(changedFiles, (f) => f.additions);
  const deletions = sumBy(changedFiles, (f) => f.deletions);
  parts.push(
    sectionTitle(
      y,
      'Change map',
      changedFiles.length === 0
        ? 'nothing changed'
        : `${plural(changedFiles.length, 'file')} · +${additions} −${deletions} · bar width is churn`,
    ),
  );
  y += SECTION_H;

  if (changedFiles.length === 0) {
    parts.push(
      label(PAD, y + 14, 'No file changed against the base commit.', {
        size: 11,
        fill: PALETTE.inkFaint,
      }),
    );
    y += 30;
  } else {
    const groups = groupChangedFiles(changedFiles);
    const maxChurn = changedFiles.reduce(
      (most, file) => Math.max(most, file.additions + file.deletions),
      1,
    );
    let drawn = 0;

    for (const group of groups) {
      if (drawn >= MAX_FILE_ROWS) break;
      parts.push(
        label(PAD, y + 14, fit(`${group.dir}/`, 420, 10.5, MONO_RATIO), {
          size: 10.5,
          family: MONO,
          fill: PALETTE.inkMuted,
        }),
      );
      parts.push(
        label(
          RIGHT,
          y + 14,
          `${plural(group.files.length, 'file')} · +${group.additions} −${group.deletions}`,
          { size: 9.5, fill: PALETTE.inkFaint, anchor: 'end' },
        ),
      );
      y += GROUP_ROW_H;

      for (const file of group.files) {
        if (drawn >= MAX_FILE_ROWS) break;
        const colours = TONE_COLOURS[CHANGE_TYPE_TONE[file.changeType]];
        const midY = y + FILE_ROW_H / 2;

        parts.push(dot(PAD + 8, midY - 3, 3.2, colours.fg));
        parts.push(
          label(PAD + 18, midY, fit(baseName(file.path), BAR_X - PAD - 30, 10.5, MONO_RATIO), {
            size: 10.5,
            family: MONO,
          }),
        );
        parts.push(box(BAR_X, midY - 4, BAR_W, 7, { fill: PALETTE.raised, rx: 2 }));

        const churn = file.additions + file.deletions;
        if (churn > 0) {
          const width = Math.max(3, Math.round((churn / maxChurn) * BAR_W));
          const addWidth = Math.round((file.additions / churn) * width);
          if (addWidth > 0) {
            parts.push(box(BAR_X, midY - 4, addWidth, 7, { fill: TONE_COLOURS.pass.fg, rx: 2 }));
          }
          if (width - addWidth > 0) {
            parts.push(
              box(BAR_X + addWidth, midY - 4, width - addWidth, 7, {
                fill: TONE_COLOURS.fail.fg,
                rx: 2,
              }),
            );
          }
        }

        if (file.binary) {
          parts.push(
            label(RIGHT, midY, 'binary', {
              size: 10,
              family: MONO,
              fill: PALETTE.inkFaint,
              anchor: 'end',
            }),
          );
        } else {
          parts.push(
            label(RIGHT - 48, midY, `+${file.additions}`, {
              size: 10,
              family: MONO,
              fill: TONE_COLOURS.pass.fg,
              anchor: 'end',
            }),
          );
          parts.push(
            label(RIGHT, midY, `−${file.deletions}`, {
              size: 10,
              family: MONO,
              fill: TONE_COLOURS.fail.fg,
              anchor: 'end',
            }),
          );
        }

        y += FILE_ROW_H;
        drawn += 1;
      }
    }

    const remaining = changedFiles.length - drawn;
    if (remaining > 0) {
      parts.push(
        label(PAD + 18, y + 13, `+ ${plural(remaining, 'more file')} not drawn`, {
          size: 10,
          fill: PALETTE.inkFaint,
        }),
      );
      y += FILE_ROW_H;
    }
    y += 8;
  }

  /* Findings */
  parts.push(sectionTitle(y, 'Review findings', 'an opinion, not a test result'));
  y += SECTION_H;

  if (findings.length === 0) {
    parts.push(
      label(
        PAD,
        y + 14,
        run.reviewerProvider === 'none'
          ? 'No independent reviewer was configured for this run.'
          : 'No findings were recorded.',
        { size: 11, fill: PALETTE.inkFaint },
      ),
    );
  } else {
    let x = PAD;
    // Most severe first: the top of the list is what decides anything.
    for (const severity of [...FINDING_SEVERITIES].reverse()) {
      const count = findings.filter((f) => f.severity === severity).length;
      if (count === 0) continue;
      const text = `${severity} ${count}`;
      const width = badgeWidth(text, 10.5);
      parts.push(badge(x, y + 3, text, SEVERITY_TONE[severity], { width }));
      x += width + 6;
    }
  }
  y += 34;

  /* Footer */
  parts.push(rule(y));
  parts.push(
    label(PAD, y + 18, `Computed from stored run state at ${input.generatedAt}.`, {
      size: 9.5,
      fill: PALETTE.inkFaint,
    }),
  );
  parts.push(
    label(
      PAD,
      y + 32,
      'File changes and check outcomes are recorded facts. The implementer’s own summary is not consulted here.',
      { size: 9.5, fill: PALETTE.inkFaint },
    ),
  );
  y += 44;

  const height = Math.round(y);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img">`,
    `<title>${esc(`Implementation map — ${run.title}`)}</title>`,
    `<desc>${esc(describeImplementationMap(input))}</desc>`,
    box(0, 0, W, height, { fill: PALETTE.base }),
    ...parts,
    '</svg>',
    '',
  ].join('\n');
}
