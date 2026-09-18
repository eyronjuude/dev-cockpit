import { z } from 'zod';

import { parseEnvLines } from './validation-steps';

/**
 * Pure rules for a project's MCP integrations — connections its own agent
 * runs may open to an external platform (an orders API, a support queue)
 * while implementing or fixing something in this project, so the setup is
 * done once per project rather than once per task.
 *
 * Nothing here touches the filesystem or a child process. Turning a
 * project's stored integrations into the `.mcp.json` a CLI reads is the one
 * side-effecting step, and it happens where the agent is spawned
 * (`agents/claude-code.ts`), not here.
 */

export const INTEGRATION_TRANSPORTS = ['stdio', 'http'] as const;
export type IntegrationTransport = (typeof INTEGRATION_TRANSPORTS)[number];
export const integrationTransportSchema = z.enum(INTEGRATION_TRANSPORTS);

export const INTEGRATION_TRANSPORT_LABELS: Record<IntegrationTransport, string> = {
  stdio: 'Command (stdio)',
  http: 'URL (HTTP/SSE)',
};

/** The subset of a configured integration needed to build `.mcp.json`. */
export interface IntegrationPlanInput {
  key: string;
  transport: IntegrationTransport;
  command: string | null;
  args: readonly string[];
  /** Raw `KEY=VALUE` lines, the same shape a validation step's env takes. */
  env: readonly string[];
  url: string | null;
  /** Raw `KEY=VALUE` lines. */
  headers: readonly string[];
  enabled: boolean;
}

/** One entry of the `mcpServers` map a `--mcp-config` file carries. */
export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };

/**
 * The `{ mcpServers: {...} }` map for a project's enabled integrations.
 *
 * `undefined` when nothing is configured or enabled, so a project that never
 * touches this feature starts its agent exactly as before — no
 * `--mcp-config` flag, no behaviour change. A stdio entry with no command, or
 * an http entry with no url, is dropped rather than passed on half-built.
 */
export function buildMcpServers(
  integrations: readonly IntegrationPlanInput[],
): Record<string, McpServerConfig> | undefined {
  const out: Record<string, McpServerConfig> = {};

  for (const integration of integrations) {
    if (!integration.enabled) continue;

    if (integration.transport === 'stdio') {
      const command = integration.command?.trim();
      if (!command) continue;
      const args = integration.args.map((arg) => arg.trim()).filter(Boolean);
      const env = parseEnvLines(integration.env.join('\n'));
      out[integration.key] = {
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
      continue;
    }

    const url = integration.url?.trim();
    if (!url) continue;
    const headers = parseEnvLines(integration.headers.join('\n'));
    out[integration.key] = {
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
