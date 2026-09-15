import { describe, expect, it } from 'vitest';

import {
  normalisePreviewPath,
  parsePreviewTargets,
  rankPreviewTargets,
} from '@/domain/preview-targets';

const message = (section: string) =>
  ['Changed the profit calculation to net refunds.', '', section].join('\n');

describe('parsing preview targets from a closing message', () => {
  it('reads the page an implementer named for a change to code behind it', () => {
    // The case this exists for: the only changed file is `lib/profit.ts`, and
    // nothing derivable from the diff points at the page that shows the figure.
    const targets = parsePreviewTargets(
      message(
        [
          '## Preview',
          '- /dashboard/revenue — the profit summary now nets refunds',
        ].join('\n'),
      ),
    );

    expect(targets).toEqual([
      {
        path: '/dashboard/revenue',
        note: 'the profit summary now nets refunds',
        origin: 'declared',
        reachable: null,
      },
    ]);
  });

  it('keeps several paths in the order they were written', () => {
    const targets = parsePreviewTargets(
      message(['## Preview', '- /dashboard/revenue — the chart', '- /dashboard — the headline'].join('\n')),
    );

    expect(targets.map((t) => t.path)).toEqual(['/dashboard/revenue', '/dashboard']);
  });

  it('accepts a bare path and a path in code formatting', () => {
    const targets = parsePreviewTargets(message(['## Preview', '- /a', '- `/b`'].join('\n')));

    expect(targets.map((t) => t.path)).toEqual(['/a', '/b']);
    expect(targets[0]?.note).toBeNull();
  });

  it('returns nothing when the message has no Preview section', () => {
    expect(parsePreviewTargets('All done. Nothing visible in a browser.')).toEqual([]);
    expect(parsePreviewTargets(null)).toEqual([]);
    expect(parsePreviewTargets(undefined)).toEqual([]);
  });

  it('stops reading at the next heading', () => {
    const targets = parsePreviewTargets(
      message(['## Preview', '- /kept', '', '## Notes', '- /ignored'].join('\n')),
    );

    expect(targets.map((t) => t.path)).toEqual(['/kept']);
  });

  it('ignores a Preview section quoted inside a fenced block', () => {
    const targets = parsePreviewTargets(
      ['Here is the format you asked for:', '', '```', '## Preview', '- /example', '```'].join('\n'),
    );

    expect(targets).toEqual([]);
  });

  const rejected: [string, string][] = [
    ['an absolute URL', '- http://evil.test/x'],
    ['a javascript URL', '- javascript:alert(1)'],
    ['a protocol-relative URL', '- //evil.test/x'],
    ['a traversal', '- ../../etc/passwd'],
    ['a rooted traversal', '- /../../etc/passwd'],
    ['an unrooted path', '- dashboard/revenue'],
    ['a Windows path', '- /dashboard\\revenue'],
  ];

  it.each(rejected)('rejects %s rather than sanitising it', (_label, item) => {
    expect(parsePreviewTargets(message(['## Preview', item].join('\n')))).toEqual([]);
  });

  it('caps the list and drops duplicates', () => {
    const many = ['## Preview', ...['/a', '/b', '/c', '/d', '/e', '/f'].map((p) => `- ${p}`)];
    expect(parsePreviewTargets(message(many.join('\n')))).toHaveLength(5);

    const dupes = ['## Preview', '- /a — first', '- /a — second', '- /b'];
    expect(parsePreviewTargets(message(dupes.join('\n'))).map((t) => t.path)).toEqual(['/a', '/b']);
  });
});

describe('normalisePreviewPath', () => {
  it('passes a rooted path through untouched', () => {
    expect(normalisePreviewPath('  /dashboard/revenue  ')).toBe('/dashboard/revenue');
  });

  it('rejects rather than coercing, unlike the advisor ready-path guard', () => {
    expect(normalisePreviewPath('dashboard')).toBeNull();
    expect(normalisePreviewPath('')).toBeNull();
    expect(normalisePreviewPath('https://example.test/')).toBeNull();
  });
});

describe('ranking preview targets', () => {
  it('puts what the implementer named above the configured ready path, and keeps a way home', () => {
    const ranked = rankPreviewTargets({
      finalText: message(['## Preview', '- /dashboard/revenue — the chart'].join('\n')),
      readyPath: '/',
    });

    expect(ranked.map((t) => t.path)).toEqual(['/dashboard/revenue', '/']);
    expect(ranked[0]?.origin).toBe('declared');
    expect(ranked[1]?.origin).toBe('configured');
  });

  it('falls back to the configured ready path when nothing was declared', () => {
    const ranked = rankPreviewTargets({ finalText: 'nothing visible', readyPath: '/health' });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.path).toBe('/health');
  });

  it('does not list the ready path twice', () => {
    const ranked = rankPreviewTargets({
      finalText: message(['## Preview', '- /health — the probe target'].join('\n')),
      readyPath: '/health',
    });

    expect(ranked.map((t) => t.path)).toEqual(['/health']);
  });

  it('marks an unreachable target rather than hiding it', () => {
    const ranked = rankPreviewTargets({
      finalText: message(['## Preview', '- /blog/hello', '- /dashboard'].join('\n')),
      readyPath: '/',
      unreachable: ['/blog/hello'],
    });

    expect(ranked[0]).toMatchObject({ path: '/blog/hello', reachable: false });
    expect(ranked[1]).toMatchObject({ path: '/dashboard', reachable: null });
  });
});
