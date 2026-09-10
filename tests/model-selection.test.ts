import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLAUDE_CODE_PROVIDER } from '@/domain/models';
import { PROFILES, recommendedModelFor } from '@/orchestrator/profiles';

/**
 * Which model a created run is given, through the real service and real SQLite.
 *
 * The precedence is unit-tested in `agent-models.test.ts`; what this covers is
 * the wiring — that `createRun` resolves the model at creation and writes it
 * down, rather than leaving it to be derived later. Storing it is what makes a
 * finished run report the model it actually used after Settings has moved on.
 */

let dataDir: string;
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let eventsService: typeof import('@/services/events');
let closeDb: typeof import('@/db/client').closeDb;

const author = { name: 'Test', email: 'test@example.com' };

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-model-selection-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  eventsService = await import('@/services/events');
  ({ closeDb } = await import('@/db/client'));
});

afterAll(() => {
  closeDb?.();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold a handle after the process exits.
  }
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

function makeRepo(name: string): string {
  const repo = path.join(dataDir, 'repos', name);
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', author.email], repo);
  git(['config', 'user.name', author.name], repo);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'initial commit'], repo);
  return repo;
}

async function makeProject(name: string, agentModel?: string) {
  return projectsService.createProject({
    name,
    repositoryPath: makeRepo(name),
    ...(agentModel === undefined ? {} : { agentModel }),
  });
}

const quickModel = recommendedModelFor(PROFILES.quick, CLAUDE_CODE_PROVIDER);
const deepModel = recommendedModelFor(PROFILES.deep, CLAUDE_CODE_PROVIDER);

describe('the model a created run is given', () => {
  it('follows the execution profile when nothing else pins one', async () => {
    const project = await makeProject('profile-default');

    const quick = runsService.createRun({
      projectId: project.id,
      request: 'Rename a variable.',
      profile: 'quick',
    });
    const deep = runsService.createRun({
      projectId: project.id,
      request: 'Rework the landing flow.',
      profile: 'deep',
    });

    expect(quick.agentModel).toBe(quickModel);
    expect(deep.agentModel).toBe(deepModel);
    // The two profiles differ in model, not only in effort — which is the
    // whole point of attaching one to the other.
    expect(quick.agentModel).not.toBe(deep.agentModel);
  });

  it('lets a project default override the profile recommendation', async () => {
    const project = await makeProject('project-default', 'claude-sonnet-5');

    const run = runsService.createRun({
      projectId: project.id,
      request: 'Rename a variable.',
      profile: 'quick',
    });

    expect(run.agentModel).toBe('claude-sonnet-5');
  });

  /**
   * The acceptance criterion: a model chosen for one run wins over both the
   * project and the profile, without the profile or its effort being changed.
   */
  it('lets a per-run choice override both, leaving the profile alone', async () => {
    const project = await makeProject('run-choice', 'claude-sonnet-5');

    const run = runsService.createRun({
      projectId: project.id,
      request: 'Rework the landing flow.',
      profile: 'deep',
      model: 'claude-haiku-4-5',
    });

    expect(run.agentModel).toBe('claude-haiku-4-5');
    expect(run.profile).toBe('deep');
  });

  it('accepts a model this build does not know, as typed', async () => {
    const project = await makeProject('unknown-model');

    const run = runsService.createRun({
      projectId: project.id,
      request: 'Try the new one.',
      model: '  claude-future-9  ',
    });

    expect(run.agentModel).toBe('claude-future-9');
  });

  it('records the model and where it came from on the created event', async () => {
    const project = await makeProject('created-event');

    const run = runsService.createRun({
      projectId: project.id,
      request: 'Rename a variable.',
      profile: 'quick',
    });

    const created = eventsService
      .listEvents(run.id)
      .find((event) => event.type === 'run.created');

    expect(created?.payload).toMatchObject({ model: quickModel, modelSource: 'profile' });
  });

  it('keeps the model it resolved after the project default changes', async () => {
    const project = await makeProject('settings-moved');
    const run = runsService.createRun({
      projectId: project.id,
      request: 'Rename a variable.',
      profile: 'quick',
    });

    projectsService.updateProject(project.id, { agentModel: 'claude-opus-5' });

    expect(runsService.requireRun(run.id).agentModel).toBe(quickModel);
  });
});
