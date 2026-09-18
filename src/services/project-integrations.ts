import 'server-only';

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { projectIntegrations } from '@/db/schema';
import type { ProjectIntegrationRow } from '@/db/schema';
import { POSITION_STRIDE } from '@/domain/types';
import { slugifyStepKey, STEP_KEY_PATTERN, uniqueStepKey } from '@/domain/validation-steps';
import {
  integrationTransportSchema,
  type IntegrationTransport,
} from '@/domain/mcp-integrations';

/**
 * One MCP server (or other external-platform connection) a project makes
 * available to its own agent runs.
 *
 * Mirrors `validationStepInputSchema`/`ValidationStepView` in
 * `services/projects.ts`: `key` is optional on the way in and derived from
 * the label when absent, not optional in storage, and the whole list is
 * replaced together — order and membership are part of the configuration a
 * form submits as a unit, the same reason `replaceValidationSteps` works
 * that way. Key generation reuses `slugifyStepKey`/`uniqueStepKey`: the slug
 * rules a step's key follows apply here unchanged.
 */
export const integrationInputSchema = z.object({
  key: z.string().trim().regex(STEP_KEY_PATTERN).optional(),
  label: z.string().trim().min(1).max(80),
  transport: integrationTransportSchema.optional(),
  command: z.string().trim().max(2_000).nullable().optional(),
  args: z.array(z.string().max(2_000)).max(50).optional(),
  env: z.array(z.string().max(2_000)).max(50).optional(),
  url: z.string().trim().max(2_000).nullable().optional(),
  headers: z.array(z.string().max(2_000)).max(50).optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().min(0).max(100_000).optional(),
});

export type IntegrationInput = z.infer<typeof integrationInputSchema>;

export interface IntegrationView {
  id: number;
  /** Slug, unique per project. What the generated `.mcp.json` names the server. */
  key: string;
  label: string;
  transport: IntegrationTransport;
  command: string | null;
  /** Raw values, `stdio` only. */
  args: string[];
  /** Raw `KEY=VALUE` lines; parse with `parseEnvLines`. `stdio` only. */
  env: string[];
  url: string | null;
  /** Raw `KEY=VALUE` lines; parse with `parseEnvLines`. `http` only. */
  headers: string[];
  enabled: boolean;
  position: number;
}

const toArray = (value: string | null | undefined): string[] =>
  (value ?? '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);

const toLines = (values: readonly string[] | undefined): string | null => {
  if (values === undefined) return null;
  const joined = values.map((v) => v.trim()).filter(Boolean).join('\n');
  return joined || null;
};

export function toIntegrationView(row: ProjectIntegrationRow): IntegrationView {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    transport: row.transport as IntegrationTransport,
    command: row.command,
    args: toArray(row.args),
    env: toArray(row.env),
    url: row.url,
    headers: toArray(row.headers),
    enabled: row.enabled,
    position: row.position,
  };
}

/** Configuration order: explicit position, then key, so ties are stable. */
export function orderIntegrations(rows: readonly IntegrationView[]): IntegrationView[] {
  return rows
    .slice()
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

/**
 * Replaces a project's whole set of integrations in one transaction.
 *
 * A `stdio` entry with no command, or an `http` entry with no url, is
 * dropped rather than stored — the connection is not configured, not
 * broken, the same convention `replaceValidationSteps` uses for a blank
 * command.
 */
export function replaceProjectIntegrations(
  projectId: string,
  input: readonly IntegrationInput[],
): void {
  const db = getDb();
  const parsed = input.map((entry) => integrationInputSchema.parse(entry));

  const taken = new Set<string>();
  const rows: {
    key: string;
    label: string;
    transport: IntegrationTransport;
    command: string | null;
    args: string | null;
    env: string | null;
    url: string | null;
    headers: string | null;
    enabled: boolean;
    position: number;
  }[] = [];

  parsed.forEach((entry, index) => {
    const transport = entry.transport ?? 'stdio';
    const command = entry.command?.trim() || null;
    const url = entry.url?.trim() || null;
    if (transport === 'stdio' && !command) return;
    if (transport === 'http' && !url) return;

    const key = uniqueStepKey(entry.key ?? slugifyStepKey(entry.label), taken);
    taken.add(key);

    rows.push({
      key,
      label: entry.label.trim() || key,
      transport,
      command: transport === 'stdio' ? command : null,
      args: transport === 'stdio' ? toLines(entry.args) : null,
      env: toLines(entry.env),
      url: transport === 'http' ? url : null,
      headers: transport === 'http' ? toLines(entry.headers) : null,
      enabled: entry.enabled ?? true,
      position: entry.position ?? index * POSITION_STRIDE,
    });
  });

  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.delete(projectIntegrations).where(eq(projectIntegrations.projectId, projectId)).run();
    for (const row of rows) {
      tx.insert(projectIntegrations)
        .values({ projectId, ...row, createdAt: now, updatedAt: now })
        .run();
    }
  });
}
