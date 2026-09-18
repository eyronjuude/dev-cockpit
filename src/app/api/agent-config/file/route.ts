import { z } from 'zod';

import { assertLocalRequest, handle, readJson } from '@/app/api/_lib/handler';
import { invalid } from '@/core/errors';
import {
  readAgentConfigFile,
  writeAgentConfigFile,
  type AgentConfigScope,
} from '@/services/agent-config';
import { requireProject } from '@/services/projects';

export const dynamic = 'force-dynamic';

const writeBodySchema = z.object({ content: z.string().max(1_000_000) });

function scopeFromParams(url: URL): AgentConfigScope {
  const scopeParam = url.searchParams.get('scope');
  if (scopeParam === 'user') return { kind: 'user' };
  if (scopeParam === 'project') {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) throw invalid('projectId is required for the project scope.');
    const project = requireProject(projectId);
    return { kind: 'project', projectId: project.id, repositoryPath: project.repositoryPath };
  }
  throw invalid('scope must be "user" or "project".');
}

function idFromParams(url: URL): string {
  const id = url.searchParams.get('id');
  if (!id) throw invalid('id is required.');
  return id;
}

/** The content of one discovered config file. */
export function GET(request: Request) {
  return handle(async () => {
    const url = new URL(request.url);
    const file = readAgentConfigFile(scopeFromParams(url), idFromParams(url));
    return { file };
  });
}

/** Overwrites one discovered, editable config file. */
export function PUT(request: Request) {
  return handle(async () => {
    assertLocalRequest(request);
    const url = new URL(request.url);
    const scope = scopeFromParams(url);
    const id = idFromParams(url);
    const body = writeBodySchema.parse(await readJson(request));
    const file = writeAgentConfigFile(scope, id, body.content);
    return { file };
  });
}
