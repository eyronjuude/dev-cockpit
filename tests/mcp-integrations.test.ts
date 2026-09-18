import { describe, expect, it } from 'vitest';

import { buildMcpServers, type IntegrationPlanInput } from '@/domain/mcp-integrations';

/**
 * The pure rule behind turning a project's configured integrations into the
 * `.mcp.json` a run's `claude` process is handed.
 */

function integration(overrides: Partial<IntegrationPlanInput> = {}): IntegrationPlanInput {
  return {
    key: 'orders',
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: [],
    url: null,
    headers: [],
    enabled: true,
    ...overrides,
  };
}

describe('buildMcpServers', () => {
  it('returns undefined when nothing is configured', () => {
    expect(buildMcpServers([])).toBeUndefined();
  });

  it('returns undefined when every integration is disabled', () => {
    expect(buildMcpServers([integration({ enabled: false })])).toBeUndefined();
  });

  it('builds a stdio entry with args and env', () => {
    const servers = buildMcpServers([
      integration({
        key: 'orders',
        command: 'npx',
        args: ['-y', '@some/mcp-server'],
        env: ['API_KEY=secret123', '# a comment', 'BASE_URL=https://orders.example.com'],
      }),
    ]);

    expect(servers).toEqual({
      orders: {
        command: 'npx',
        args: ['-y', '@some/mcp-server'],
        env: { API_KEY: 'secret123', BASE_URL: 'https://orders.example.com' },
      },
    });
  });

  it('drops a stdio entry with no command', () => {
    expect(buildMcpServers([integration({ command: '' })])).toBeUndefined();
  });

  it('builds an http entry with headers', () => {
    const servers = buildMcpServers([
      integration({
        key: 'orders-api',
        transport: 'http',
        command: null,
        url: 'https://orders.example.com/mcp',
        headers: ['Authorization=Bearer secret123'],
      }),
    ]);

    expect(servers).toEqual({
      'orders-api': {
        url: 'https://orders.example.com/mcp',
        headers: { Authorization: 'Bearer secret123' },
      },
    });
  });

  it('drops an http entry with no url', () => {
    expect(
      buildMcpServers([integration({ transport: 'http', command: null, url: '' })]),
    ).toBeUndefined();
  });

  it('omits args and env keys entirely when there are none to send', () => {
    const servers = buildMcpServers([integration({ command: 'npx' })]);
    expect(servers).toEqual({ orders: { command: 'npx' } });
  });

  it('keeps only the enabled integrations, keyed by their own name', () => {
    const servers = buildMcpServers([
      integration({ key: 'orders', command: 'npx' }),
      integration({ key: 'support', command: 'npx', enabled: false }),
    ]);
    expect(servers).toEqual({ orders: { command: 'npx' } });
  });
});
