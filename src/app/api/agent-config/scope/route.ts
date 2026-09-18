import { handle } from '@/app/api/_lib/handler';
import { invalid } from '@/core/errors';
import { listAgentConfig, type AgentConfigScope } from '@/services/agent-config';
import { requireProject } from '@/services/projects';

export const dynamic = 'force-dynamic';

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

/** Every Claude/Codex config file discovered for a scope. */
export function GET(request: Request) {
  return handle(async () => {
    const scope = scopeFromParams(new URL(request.url));
    return { entries: listAgentConfig(scope) };
  });
}
