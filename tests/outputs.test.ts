import { describe, expect, it } from 'vitest';

import {
  PAGE_KIND,
  selectRunOutputs,
  selectStandalonePages,
  summariseOutputFacts,
  wantsVisualArtifact,
  type OutputArtifact,
  type RunOutputInput,
} from '@/domain/outputs';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let artifactCounter = 0;

function artifact(kind: string, overrides: Partial<OutputArtifact> = {}): OutputArtifact {
  artifactCounter += 1;
  const n = artifactCounter;
  return {
    id: `art_${n}`,
    kind,
    label: `${kind} (iteration 1)`,
    mimeType: kind === PAGE_KIND ? 'text/html' : 'text/markdown',
    // Distinct and increasing, so "newest" is unambiguous in fixtures.
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
    exists: true,
    expiredAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<RunOutputInput> = {}): RunOutputInput {
  return {
    mode: 'build',
    status: 'READY',
    active: false,
    request: 'do the thing',
    changedFiles: [],
    artifacts: [],
    preview: { configured: false, running: false },
    hasWorktree: true,
    uiPathPatterns: [],
    projectId: 'prj_1',
    ...overrides,
  };
}

const changed = (path: string, changeType = 'modified') => ({ path, changeType });

const withServer = { preview: { configured: true, running: false }, hasWorktree: true };

/* ------------------------------------------------------------------ *
 * Which output is shown
 * ------------------------------------------------------------------ */

describe('selecting a run output', () => {
  it('shows an Ask run its answer', () => {
    const answer = artifact('answer');
    const { shown, emptyReason } = selectRunOutputs(
      input({ mode: 'ask', artifacts: [answer] }),
    );

    expect(emptyReason).toBeNull();
    expect(shown?.source).toEqual({
      source: 'artifact',
      artifactId: answer.id,
      mimeType: 'text/markdown',
    });
    expect(shown?.reason).toContain('Ask mode');
  });

  it('shows a Plan run its plan even when the project has a development command', () => {
    const plan = artifact('plan');
    const { shown } = selectRunOutputs(
      input({ mode: 'plan', artifacts: [plan], ...withServer }),
    );

    expect(shown?.kind).toBe('document');
    expect(shown?.label).toBe('plan');
  });

  it('shows the newest plan and leaves earlier passes in the Artifacts tab', () => {
    const first = artifact('plan');
    const second = artifact('plan');
    const third = artifact('plan');

    const { shown, alternatives, olderPasses } = selectRunOutputs(
      input({ mode: 'plan', artifacts: [first, second, third] }),
    );

    expect(shown?.source).toMatchObject({ artifactId: third.id });
    expect(olderPasses).toBe(2);
    // Earlier passes are deliberately not offered: they live in Artifacts.
    expect(alternatives.map((a) => a.id)).not.toContain(`artifact:${first.id}`);
    expect(alternatives.map((a) => a.id)).not.toContain(`artifact:${second.id}`);
  });

  it('says a reclaimed deliverable expired rather than that nothing exists', () => {
    const plan = artifact('plan', { expiredAt: '2026-02-01T00:00:00.000Z', exists: false });
    const { shown, emptyReason } = selectRunOutputs(input({ mode: 'plan', artifacts: [plan] }));

    expect(shown).toBeNull();
    expect(emptyReason).toMatch(/retention policy/);
  });

  it('shows the site when a build run changed UI files', () => {
    const { shown } = selectRunOutputs(
      input({
        changedFiles: [changed('src/app/page.tsx'), changed('src/app/globals.css')],
        ...withServer,
      }),
    );

    expect(shown?.kind).toBe('site');
    expect(shown?.reason).toContain('2 files changed');
  });

  it('shows a page when it is the only thing the run changed', () => {
    const page = artifact(PAGE_KIND);
    const { shown } = selectRunOutputs(
      input({
        // Untracked, because an agent that writes a report rarely stages it.
        changedFiles: [changed('reports/plan.html', 'untracked')],
        artifacts: [page],
        ...withServer,
      }),
    );

    expect(shown?.kind).toBe('page');
    expect(shown?.reason).toContain('reports/plan.html');
  });

  it('treats an untracked page exactly as an added one', () => {
    const page = artifact(PAGE_KIND);
    const base = { artifacts: [page], ...withServer };

    const untracked = selectRunOutputs(
      input({ ...base, changedFiles: [changed('reports/plan.html', 'untracked')] }),
    );
    const added = selectRunOutputs(
      input({ ...base, changedFiles: [changed('reports/plan.html', 'added')] }),
    );

    expect(untracked.shown?.kind).toBe(added.shown?.kind);
    expect(untracked.shown?.reason).toBe(added.shown?.reason);
  });

  it('does not promote an HTML file the development server serves', () => {
    const page = artifact(PAGE_KIND);
    const { shown } = selectRunOutputs(
      input({ changedFiles: [changed('public/index.html')], artifacts: [page], ...withServer }),
    );

    expect(shown?.kind).toBe('site');
  });

  it('prefers a requested page over the site, and the site otherwise', () => {
    const page = artifact(PAGE_KIND);
    const files = [
      changed('src/app/page.tsx'),
      changed('src/lib/plan.ts'),
      changed('plan.html', 'added'),
    ];

    const requested = selectRunOutputs(
      input({
        request: 'make me an HTML page visualising this plan',
        changedFiles: files,
        artifacts: [page],
        ...withServer,
      }),
    );
    const ordinary = selectRunOutputs(
      input({
        request: 'refactor the plan loader and tidy the markup',
        changedFiles: files,
        artifacts: [page],
        ...withServer,
      }),
    );

    expect(requested.shown?.kind).toBe('page');
    expect(requested.alternatives.some((a) => a.kind === 'site')).toBe(true);

    expect(ordinary.shown?.kind).toBe('site');
    expect(ordinary.alternatives.some((a) => a.kind === 'page')).toBe(true);
  });

  it('does not nominate a regenerated coverage report as the run output', () => {
    const { shown } = selectRunOutputs(
      input({
        changedFiles: [changed('coverage/lcov-report/index.html', 'added')],
        ...withServer,
      }),
    );

    expect(shown?.kind).toBe('site');
    expect(selectStandalonePages(input({ changedFiles: [changed('coverage/x/index.html')] })))
      .toEqual([]);
  });

  it('shows the site for a change that matches no UI pattern at all', () => {
    // The case this whole change exists for: a profit calculation feeds a chart
    // whose own files were never touched.
    const { shown } = selectRunOutputs(
      input({ changedFiles: [changed('src/lib/profit.ts')], ...withServer }),
    );

    expect(shown?.kind).toBe('site');
    expect(shown?.reason).toContain('development command');
  });

  it('falls back to the run summary when no development command exists', () => {
    const summary = artifact('markdown_report');
    const { shown } = selectRunOutputs(
      input({ changedFiles: [changed('src/lib/profit.ts')], artifacts: [summary] }),
    );

    expect(shown?.kind).toBe('document');
    expect(shown?.label).toBe('summary');
    // The fallback is a settings problem, so it points at the fix.
    expect(shown?.settingsHref).toBe('/projects/prj_1#dev-command');
  });

  it('does not offer a settings link when the summary fallback is caused by a missing worktree, not a missing command', () => {
    const summary = artifact('markdown_report');
    const { shown } = selectRunOutputs(
      input({
        changedFiles: [changed('src/lib/profit.ts')],
        artifacts: [summary],
        preview: { configured: true, running: false },
        hasWorktree: false,
      }),
    );

    expect(shown?.kind).toBe('document');
    expect(shown?.reason).toContain('worktree');
    expect(shown?.settingsHref).toBeNull();
  });

  it('explains itself when a run produced nothing', () => {
    const { shown, alternatives, emptyReason, emptyReasonHref } = selectRunOutputs(
      input({ status: 'FAILED' }),
    );

    expect(shown).toBeNull();
    expect(alternatives).toEqual([]);
    expect(emptyReason).toContain('no development command');
    expect(emptyReasonHref).toBe('/projects/prj_1#dev-command');
  });

  it('points at the agent while a run is still working', () => {
    const { emptyReason } = selectRunOutputs(input({ mode: 'plan', active: true }));
    expect(emptyReason).toBe('The plan appears here when the planner finishes.');
  });

  it('never offers the shown output as an alternative, and caps the rest', () => {
    const selection = selectRunOutputs(
      input({
        mode: 'plan',
        artifacts: [artifact('plan'), artifact('answer'), artifact('markdown_report'), artifact(PAGE_KIND)],
        ...withServer,
      }),
    );

    expect(selection.shown).not.toBeNull();
    expect(selection.alternatives.map((a) => a.id)).not.toContain(selection.shown?.id);
    expect(selection.alternatives.length).toBeLessThanOrEqual(3);
    expect(new Set(selection.alternatives.map((a) => a.id)).size).toBe(
      selection.alternatives.length,
    );
  });

  it('is deterministic', () => {
    const fixture = input({
      mode: 'plan',
      artifacts: [artifact('plan'), artifact('markdown_report')],
      ...withServer,
    });

    const a = selectRunOutputs(fixture);
    const b = selectRunOutputs(fixture);

    expect(a.shown?.id).toBe(b.shown?.id);
    expect(a.alternatives.map((x) => x.id)).toEqual(b.alternatives.map((x) => x.id));
  });

  it('matches UI patterns on Windows-style paths', () => {
    const facts = summariseOutputFacts(
      input({ changedFiles: [changed('src\\components\\chart.tsx')] }),
    );

    expect(facts.touchesSite).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Did the request ask for a page?
 * ------------------------------------------------------------------ */

describe('wantsVisualArtifact', () => {
  const positives = [
    'make me an HTML page visualising this plan',
    'build a dashboard showing the release timeline',
    'produce a report page for the migration',
    'draft a one-pager for the launch',
    'create a chart of run costs',
  ];

  const negatives = [
    'fix the HTML escaping bug',
    'update the chart component to use the new palette',
    'add a page object to the E2E suite',
    'rename the dashboard route',
  ];

  it.each(positives)('fires on %j', (request) => {
    expect(wantsVisualArtifact(request)).toBe(true);
  });

  it.each(negatives)('does not fire on %j', (request) => {
    expect(wantsVisualArtifact(request)).toBe(false);
  });
});
