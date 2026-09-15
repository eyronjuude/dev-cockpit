/**
 * Which page of a running preview to open.
 *
 * A build run that changes `lib/profit.ts` has no changed file that is a page,
 * yet the change is only visible on the one page that shows the figure. Nothing
 * derivable from the diff finds that link: the chart component was never
 * touched. The implementer is the only party that already knows, because it
 * followed the call chain to make the change.
 *
 * So the build prompt asks for a `## Preview` section and this parses it. The
 * section is ordinary Markdown — it reads correctly to a person in the Overview
 * tab and parses here, which a magic token would not.
 *
 * **A target is a navigation hint, not a verdict.** Readiness deliberately never
 * consults what the agent says about its own work, because an agent grading its
 * own homework is worthless. This is a different kind of claim: if it is wrong
 * you land on the wrong page and retype the path, the probe catches most of it
 * first, and nothing about the run's disposition depends on it.
 *
 * Pure. No I/O, no database, no server-only import.
 */

export interface PreviewTarget {
  /** Rooted path, e.g. `/dashboard/revenue`. */
  path: string;
  /** The few words the implementer wrote beside it, when it wrote any. */
  note: string | null;
  origin: 'declared' | 'configured';
  /** Whether the running server answered. Null before a probe has run. */
  reachable: boolean | null;
}

/** More than a handful is a list of the whole site, which helps nobody. */
const MAX_TARGETS = 5;

/**
 * Whether a model-supplied path is safe to navigate to.
 *
 * The same shape of guard `normaliseReadyPath` applies to an advisor's
 * proposed ready path, with one deliberate difference: this rejects rather than
 * coerces. A ready path is configuration a person can correct; a target parsed
 * out of prose is a guess, and silently rewriting `../../etc/passwd` into
 * `/../../etc/passwd` would turn a malformed line into a plausible-looking one.
 */
export function normalisePreviewPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // A scheme or an authority means it is not a path on this preview at all.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (trimmed.startsWith('//')) return null;
  if (!trimmed.startsWith('/')) return null;
  if (trimmed.includes('\\')) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.split('/').includes('..')) return null;
  return trimmed;
}

/** Splits a list item into its path and the prose after it, if any. */
function splitItem(item: string): { path: string; note: string | null } | null {
  const body = item.replace(/^\s*[-*+]\s+/, '').trim();
  if (!body) return null;

  // `/path — note`, `/path - note`, `/path: note`, or a bare path. Backticks
  // are stripped because an agent asked for a path usually writes one in code
  // formatting.
  const match = /^`?([^\s`]+)`?\s*(?:[—–:-]\s*(.*))?$/.exec(body);
  if (!match) return null;

  const path = normalisePreviewPath(match[1] ?? '');
  if (!path) return null;

  const note = (match[2] ?? '').trim();
  return { path, note: note || null };
}

/**
 * Reads the `## Preview` section out of an implementer's closing message.
 *
 * Narrow on purpose, in the spirit of `isUnresolvedBackgroundWait`: a heading
 * called Preview, list items under it, rooted paths only, and nothing inferred
 * from prose elsewhere in the message. A malformed section yields no targets
 * rather than a guess.
 */
export function parsePreviewTargets(finalText: string | null | undefined): PreviewTarget[] {
  if (!finalText) return [];

  const lines = finalText.replace(/\r\n/g, '\n').split('\n');
  const targets: PreviewTarget[] = [];
  const seen = new Set<string>();

  let inSection = false;
  let inFence = false;

  for (const line of lines) {
    // A fenced block is the agent quoting the instruction back at us.
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      inSection = /^preview\b/i.test((heading[1] ?? '').trim());
      continue;
    }

    if (!inSection) continue;
    if (!/^\s*[-*+]\s+/.test(line)) continue;

    const parsed = splitItem(line);
    if (!parsed) continue;
    if (seen.has(parsed.path)) continue;

    seen.add(parsed.path);
    targets.push({ path: parsed.path, note: parsed.note, origin: 'declared', reachable: null });
    if (targets.length >= MAX_TARGETS) break;
  }

  return targets;
}

export interface RankPreviewTargetsInput {
  /** The latest completed iteration's closing message. */
  finalText: string | null | undefined;
  /** The project's configured ready path, which is always kept as a way home. */
  readyPath: string;
  /** Paths a probe found unreachable, so they can be marked rather than dropped. */
  unreachable?: readonly string[];
}

/**
 * The paths to offer, best first.
 *
 * What the implementer named comes before the project's configured ready path,
 * and the ready path is always retained: an agent that named one page is not
 * saying the site root has stopped existing.
 *
 * Unreachable targets are marked, not removed. A 404 on a page the agent named
 * usually means the route needs a parameter or sits behind a login, and hiding
 * it would hide that.
 */
export function rankPreviewTargets(input: RankPreviewTargetsInput): PreviewTarget[] {
  const unreachable = new Set(input.unreachable ?? []);
  const mark = (target: PreviewTarget): PreviewTarget =>
    unreachable.has(target.path) ? { ...target, reachable: false } : target;

  const declared = parsePreviewTargets(input.finalText).map(mark);

  const home = normalisePreviewPath(input.readyPath) ?? '/';
  if (declared.some((target) => target.path === home)) return declared;

  return [
    ...declared,
    mark({
      path: home,
      note: home === '/' ? null : "the project's configured ready path",
      origin: 'configured',
      reachable: null,
    }),
  ];
}
