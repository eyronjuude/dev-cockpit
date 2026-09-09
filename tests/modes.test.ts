import { describe, expect, it } from 'vitest';

import {
  classifyRequest,
  DEFAULT_WORK_MODE,
  effectiveWorkMode,
  isReadOnlyMode,
  resolveWorkMode,
  RESOLVED_WORK_MODES,
  WORK_MODE_LABELS,
  WORK_MODE_WORDING,
  WORK_MODES,
  workModeSchema,
} from '@/domain/modes';
import {
  effectivePermissionMode,
  getWorkMode,
  listWorkModes,
  WORK_MODE_BEHAVIOURS,
} from '@/orchestrator/modes';
import { PROFILES } from '@/orchestrator/profiles';
import { buildChangeRequestPrompt, buildInitialPrompt } from '@/orchestrator/prompt';
import type { ProjectView } from '@/services/projects';
import type { RunView } from '@/services/runs';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * A project view.
 *
 * `effectivePermissionMode` follows `agentPermissionMode` unless it is
 * overridden on its own, the same way `toProjectView` derives it. A test that
 * pins the stored mode means the agent to actually be given it.
 */
function makeProject(overrides: Partial<ProjectView> = {}): ProjectView {
  const stored = overrides.agentPermissionMode ?? 'acceptEdits';
  return {
    id: 'prj_1',
    name: 'Example',
    repositoryPath: 'C:/repos/example',
    defaultBranch: 'main',
    developmentCommand: null,
    setupCommand: null,
    openCommand: null,
    linkPaths: [],
    protectedBranches: ['main'],
    requireValidation: true,
    requireE2eForUiChanges: false,
    uiPathPatterns: [],
    captureScreenshots: true,
    allowAgentCommit: false,
    reviewBlocksReady: false,
    cleanUpWorktreeOnFinish: true,
    artifactRetentionDays: 30,
    agentModel: null,
    agentPermissionMode: stored,
    effectivePermissionMode: stored,
    agentAddDirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    validationCommands: [
      {
        id: 1,
        kind: 'unit',
        command: 'npm test',
        workingDir: null,
        timeoutMs: 900_000,
        enabled: true,
        blocking: true,
        profiles: ['quick', 'standard', 'deep'],
      },
    ],
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunView> = {}): RunView {
  return {
    id: 'run_1',
    projectId: 'prj_1',
    projectName: 'Example',
    title: 'Add a health endpoint',
    request: 'Add a health endpoint that returns 200.',
    spec: null,
    specProvider: null,
    status: 'IMPLEMENTING',
    statusReason: null,
    profile: 'standard',
    mode: 'build',
    resolvedMode: 'build',
    baseBranch: 'main',
    baseCommit: 'abc1234',
    branch: 'cockpit/run_1',
    worktreePath: 'C:/data/worktrees/prj_1/run_1',
    commitSha: null,
    agentProvider: 'claude-code',
    agentSessionId: null,
    agentModel: null,
    transformerProvider: 'none',
    reviewerProvider: 'none',
    disposition: null,
    dispositionNote: null,
    error: null,
    costUsd: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    iterations: [],
    validations: [],
    changedFiles: [],
    findings: [],
    attachments: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

describe('working mode vocabulary', () => {
  it('offers ask, plan, build and auto, and executes only the first three', () => {
    expect(WORK_MODES).toEqual(['ask', 'plan', 'build', 'auto']);
    expect(RESOLVED_WORK_MODES).toEqual(['ask', 'plan', 'build']);
    // `auto` must never reach the orchestrator: it is a choice, not a mode.
    expect(RESOLVED_WORK_MODES).not.toContain('auto');
  });

  it('defaults to build, so nothing changes for a run that says nothing', () => {
    expect(DEFAULT_WORK_MODE).toBe('build');
    expect(workModeSchema.parse('ask')).toBe('ask');
    expect(workModeSchema.safeParse('planning').success).toBe(false);
  });

  it('labels and words every mode it offers', () => {
    for (const mode of WORK_MODES) {
      expect(WORK_MODE_LABELS[mode]).toBeTruthy();
    }
    for (const mode of RESOLVED_WORK_MODES) {
      const wording = WORK_MODE_WORDING[mode];
      expect(wording.activity).toBeTruthy();
      expect(wording.progressNoun).toBeTruthy();
      expect(wording.deliverable).toBeTruthy();
      expect(wording.agentNoun).toBeTruthy();
    }
  });

  it('counts ask and plan as read-only and build as not', () => {
    expect(isReadOnlyMode('ask')).toBe(true);
    expect(isReadOnlyMode('plan')).toBe(true);
    expect(isReadOnlyMode('build')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Auto
 * ------------------------------------------------------------------ */

describe('classifyRequest', () => {
  it('picks ask for a question about code that already exists', () => {
    for (const request of [
      'How does session expiry work in this app?',
      'Explain the retry logic in the queue worker.',
      'Where is the session cookie set?',
      'Why does the login endpoint return 500 on an empty password?',
      'What does the transformer boundary actually forbid?',
      'Is there a helper for this already?',
      'Walk me through the run lifecycle.',
    ]) {
      expect(classifyRequest(request), request).toMatchObject({ mode: 'ask' });
    }
  });

  it('picks plan when a plan is the deliverable', () => {
    for (const request of [
      'Write me an implementation plan for adding OAuth.',
      'Draft a proposal for splitting the billing module.',
      'Plan how we would migrate off the legacy queue.',
      'Give us an approach for caching the product list.',
      'I want a step-by-step plan for the upgrade.',
    ]) {
      expect(classifyRequest(request), request).toMatchObject({ mode: 'plan' });
    }
  });

  it('prefers plan over ask when the question is about what to do next', () => {
    // "How does X work" is an Ask. "How should we do X" is a Plan. The
    // difference is whether the answer is in the codebase already.
    for (const request of [
      'How should we structure the new billing module?',
      "What's the best way to model soft deletes here?",
      'Compare Redis and in-process caching for the product list.',
      'Which approach would you use for the retry logic?',
      'Is it feasible to move the worker into the same process?',
    ]) {
      expect(classifyRequest(request), request).toMatchObject({ mode: 'plan' });
    }
  });

  it('picks plan when the request forbids code changes, even alongside change verbs', () => {
    // The prohibition is the strongest signal there is: "add caching" would
    // otherwise read as a change request.
    const result = classifyRequest('Add caching to the product list. Do not write any code yet.');
    expect(result.mode).toBe('plan');
    expect(result.reason).toContain('not to change code');

    expect(classifyRequest('Plan only: refactor the auth module.').mode).toBe('plan');
    expect(classifyRequest('Use plan mode. Fix the failing lint rule.').mode).toBe('plan');
  });

  it('keeps a forbidden-changes question as an ask rather than a plan', () => {
    // Read-only was the instruction; a question is still a question.
    expect(classifyRequest('Read-only: explain how the cache layer works.').mode).toBe('ask');
    expect(classifyRequest('Do not change anything. Where is the retry configured?').mode).toBe(
      'ask',
    );
  });

  it('picks build when the request names a change to make', () => {
    for (const request of [
      'The login form accepts an empty password and returns 500. It should reject it with a 400.',
      'Add a health endpoint that returns 200.',
      'Refactor the cache layer to use a single client.',
      'Bump eslint to 9 and fix what breaks.',
      'Rename UserSvc to UserService everywhere.',
    ]) {
      expect(classifyRequest(request), request).toMatchObject({ mode: 'build' });
    }
  });

  it('prefers build when a request asks to investigate and then fix', () => {
    // Reading is how a change request starts; it does not make it a plan.
    const result = classifyRequest('Investigate why login 500s on an empty password and fix it.');
    expect(result.mode).toBe('build');
    expect(result.reason).toContain('names a change');
  });

  it('prefers build when a question is followed by an instruction to fix it', () => {
    const result = classifyRequest('Why does login 500 on an empty password? Fix it.');
    expect(result.mode).toBe('build');
  });

  it('falls back to build for anything it cannot read', () => {
    for (const request of ['', 'continue where we left off', 'the thing from yesterday']) {
      const result = classifyRequest(request);
      expect(result.mode, request).toBe('build');
      expect(result.reason).toContain('nothing in the request');
    }
  });

  it('reads a typographic apostrophe the same as a straight one', () => {
    expect(classifyRequest('Add caching. Don\u2019t write any code.').mode).toBe('plan');
  });
});

describe('resolveWorkMode', () => {
  it('passes an explicit choice straight through, whatever the request says', () => {
    const plan = resolveWorkMode('plan', 'Fix the failing test in auth.spec.ts.');
    expect(plan).toEqual({
      mode: 'plan',
      reason: 'Plan mode was selected for this run',
      automatic: false,
    });

    const build = resolveWorkMode('build', 'Write me a plan for the migration.');
    expect(build.mode).toBe('build');
    expect(build.automatic).toBe(false);

    const ask = resolveWorkMode('ask', 'Add a health endpoint.');
    expect(ask.mode).toBe('ask');
    expect(ask.automatic).toBe(false);
  });

  it('marks an auto decision as automatic and says why', () => {
    const result = resolveWorkMode('auto', 'Write me an implementation plan for OAuth.');
    expect(result.mode).toBe('plan');
    expect(result.automatic).toBe(true);
    expect(result.reason).toContain('deliverable');
  });

  it('agrees with classifyRequest, so the form preview cannot disagree with the run', () => {
    // The New Task screen shows what Auto would pick by calling the same
    // function the server calls when the run is created.
    for (const request of [
      'Write a plan for the upgrade.',
      'Fix the empty password crash.',
      'Should we split this module?',
      'How does the event bus work?',
    ]) {
      expect(resolveWorkMode('auto', request).mode).toBe(classifyRequest(request).mode);
    }
  });
});

describe('effectiveWorkMode', () => {
  it('reads the resolved mode when there is one', () => {
    expect(effectiveWorkMode({ mode: 'auto', resolvedMode: 'plan' })).toBe('plan');
    expect(effectiveWorkMode({ mode: 'auto', resolvedMode: 'ask' })).toBe('ask');
    expect(effectiveWorkMode({ mode: 'auto', resolvedMode: 'build' })).toBe('build');
    expect(effectiveWorkMode({ mode: 'plan', resolvedMode: 'build' })).toBe('build');
  });

  it('treats a run from before modes existed as a build run', () => {
    // The migration defaults `mode` to build and leaves `resolved_mode` null.
    expect(effectiveWorkMode({ mode: 'build', resolvedMode: null })).toBe('build');
    // An unresolved auto row, and anything unrecognised, must not become a
    // read-only run by accident.
    expect(effectiveWorkMode({ mode: 'auto', resolvedMode: null })).toBe('build');
    expect(effectiveWorkMode({ mode: 'nonsense', resolvedMode: null })).toBe('build');
  });
});

/* ------------------------------------------------------------------ *
 * Behaviour
 * ------------------------------------------------------------------ */

describe('work mode behaviour', () => {
  it('makes both read-only modes read-only in every phase', () => {
    for (const mode of [WORK_MODE_BEHAVIOURS.ask, WORK_MODE_BEHAVIOURS.plan]) {
      expect(mode.editsCode, mode.id).toBe(false);
      expect(mode.runValidation, mode.id).toBe(false);
      expect(mode.runReviewer, mode.id).toBe(false);
      expect(mode.summariseOutcome, mode.id).toBe(false);
      expect(mode.agentPermissionMode, mode.id).toBe('plan');
    }
  });

  it('leaves build mode doing exactly what a run did before modes existed', () => {
    const build = WORK_MODE_BEHAVIOURS.build;
    expect(build.editsCode).toBe(true);
    expect(build.runValidation).toBe(true);
    expect(build.runReviewer).toBe(true);
    expect(build.agentPermissionMode).toBeNull();
    expect(build.outcomeArtifact).toEqual({
      kind: 'markdown_report',
      label: 'Implementation summary',
      directory: 'summaries',
    });
  });

  it('stores every deliverable under its own kind and directory', () => {
    const kinds = RESOLVED_WORK_MODES.map((id) => WORK_MODE_BEHAVIOURS[id].outcomeArtifact.kind);
    const directories = RESOLVED_WORK_MODES.map(
      (id) => WORK_MODE_BEHAVIOURS[id].outcomeArtifact.directory,
    );
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(new Set(directories).size).toBe(directories.length);
  });

  it('resolves an unknown or missing mode to build', () => {
    expect(getWorkMode('ask').id).toBe('ask');
    expect(getWorkMode('plan').id).toBe('plan');
    expect(getWorkMode('build').id).toBe('build');
    expect(getWorkMode(null).id).toBe('build');
    expect(getWorkMode('auto').id).toBe('build');
    expect(listWorkModes().map((m) => m.id)).toEqual(['ask', 'plan', 'build']);
  });

  it('lets a mode take capability away but never add it', () => {
    // The read-only modes override the most permissive project setting there
    // is; build defers to the project, including a restrictive one.
    for (const mode of [WORK_MODE_BEHAVIOURS.ask, WORK_MODE_BEHAVIOURS.plan]) {
      expect(effectivePermissionMode('bypassPermissions', mode)).toBe('plan');
      expect(effectivePermissionMode('acceptEdits', mode)).toBe('plan');
    }
    const build = WORK_MODE_BEHAVIOURS.build;
    expect(effectivePermissionMode('acceptEdits', build)).toBe('acceptEdits');
    expect(effectivePermissionMode('bypassPermissions', build)).toBe('bypassPermissions');
  });
});

/* ------------------------------------------------------------------ *
 * Prompts
 * ------------------------------------------------------------------ */

describe('buildInitialPrompt', () => {
  it('tells a build run it is implementing, and what will check it', () => {
    const prompt = buildInitialPrompt({
      run: makeRun(),
      project: makeProject(),
      profile: PROFILES.standard,
      mode: getWorkMode('build'),
    });

    expect(prompt).toContain('You are implementing a change');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('Do not run git commit');
    expect(prompt).toContain('Add a health endpoint that returns 200.');
    expect(prompt).not.toContain('You are planning a change');
  });

  it('tells a plan run not to change anything, and asks for a plan', () => {
    const prompt = buildInitialPrompt({
      run: makeRun({ mode: 'plan', resolvedMode: 'plan' }),
      project: makeProject(),
      profile: PROFILES.standard,
      mode: getWorkMode('plan'),
    });

    expect(prompt).toContain('You are planning a change');
    expect(prompt).toContain('You are not implementing it');
    expect(prompt).toContain('Do not create, edit or delete any file');
    expect(prompt).toContain('Risks and open questions');
    // No promise that checks will run against the work: none will.
    expect(prompt).not.toContain('an orchestrator runs this project');
    expect(prompt).not.toContain('will run against your work');
  });

  it('tells an ask run to answer, and not to plan or change anything', () => {
    const prompt = buildInitialPrompt({
      run: makeRun({ mode: 'ask', resolvedMode: 'ask', request: 'How does session expiry work?' }),
      project: makeProject(),
      profile: PROFILES.standard,
      mode: getWorkMode('ask'),
    });

    expect(prompt).toContain('You are answering a question');
    expect(prompt).toContain('Do not create, edit or delete any file');
    expect(prompt).toContain('Anchor every claim about the code to a real path');
    expect(prompt).toContain('How does session expiry work?');
    // An answer is not a plan, and the shapes must not bleed into each other.
    expect(prompt).not.toContain('Risks and open questions');
    expect(prompt).not.toContain('You are planning a change');
    // A question is not answered by a test suite, so the checks are not listed.
    expect(prompt).not.toContain('npm test');
  });

  it('does not put a code-change instruction in a read-only prompt', () => {
    // The Deep profile suffix asks for tests to be added, which is exactly
    // wrong for a run that must not write a file.
    const suffix = PROFILES.deep.promptSuffix;
    expect(suffix).toBeTruthy();

    for (const mode of ['ask', 'plan'] as const) {
      const prompt = buildInitialPrompt({
        run: makeRun({ mode, resolvedMode: mode }),
        project: makeProject(),
        profile: PROFILES.deep,
        mode: getWorkMode(mode),
      });
      expect(prompt, mode).not.toContain(suffix);
    }

    const build = buildInitialPrompt({
      run: makeRun(),
      project: makeProject(),
      profile: PROFILES.deep,
      mode: getWorkMode('build'),
    });
    expect(build).toContain(suffix);
  });

  it('does not claim a build agent can run commands when the mode denies them', () => {
    const restricted = buildInitialPrompt({
      run: makeRun(),
      project: makeProject({ agentPermissionMode: 'acceptEdits' }),
      profile: PROFILES.standard,
      mode: getWorkMode('build'),
    });
    expect(restricted).toContain('this session denies shell commands');

    const permitted = buildInitialPrompt({
      run: makeRun(),
      project: makeProject({ agentPermissionMode: 'bypassPermissions' }),
      profile: PROFILES.standard,
      mode: getWorkMode('build'),
    });
    expect(permitted).toContain('Shell commands are available to you in this session');
    expect(permitted).toContain('Run these yourself before you finish');
  });

  it('offers the checks to a plan run as facts to account for, not as instructions', () => {
    const prompt = buildInitialPrompt({
      run: makeRun({ mode: 'plan', resolvedMode: 'plan' }),
      project: makeProject(),
      profile: PROFILES.standard,
      mode: getWorkMode('plan'),
    });
    expect(prompt).toContain('already has configured');
    expect(prompt).toContain('npm test');
    expect(prompt).not.toContain('Run these yourself');
  });

  it('prefers the specification over the raw request when they differ', () => {
    const prompt = buildInitialPrompt({
      run: makeRun({ spec: '## Goal\nAdd /healthz.' }),
      project: makeProject(),
      profile: PROFILES.quick,
      mode: getWorkMode('build'),
    });
    expect(prompt).toContain('Expanded into a specification');
    expect(prompt).toContain('Add /healthz.');
  });
});

describe('buildChangeRequestPrompt', () => {
  const base = {
    run: makeRun(),
    project: makeProject(),
    validations: [],
    findings: [],
  };

  it('stays short when the session is resumed and the mode has not changed', () => {
    const prompt = buildChangeRequestPrompt({
      ...base,
      feedback: 'Return 400 rather than 500.',
      mode: getWorkMode('build'),
      modeSwitched: false,
      resumed: true,
    });

    // The session is resumed, so repeating the rules or the task would compete
    // with the context the agent already has.
    expect(prompt).not.toContain('You are implementing a change inside an isolated');
    expect(prompt).not.toContain('# Task');
    expect(prompt).toContain('Return 400 rather than 500.');
    expect(prompt).toContain('The same checks will run again afterwards.');
  });

  it('rebuilds the whole brief when there is no session to resume', () => {
    // A cold session inherited nothing: without the rules and the task it
    // would be asked to act on feedback about work it has never seen.
    const prompt = buildChangeRequestPrompt({
      ...base,
      feedback: 'Return 400 rather than 500.',
      mode: getWorkMode('build'),
      modeSwitched: false,
      resumed: false,
      priorOutput: 'I added the endpoint in src/app.ts.',
    });

    expect(prompt).toContain('You are implementing a change inside an isolated');
    expect(prompt).toContain('# Task');
    expect(prompt).toContain('Add a health endpoint that returns 200.');
    expect(prompt).toContain('What the last iteration produced');
    expect(prompt).toContain('I added the endpoint in src/app.ts.');
  });

  it('rebuilds the brief for a cold read-only follow-up too', () => {
    const prompt = buildChangeRequestPrompt({
      ...base,
      run: makeRun({ mode: 'plan', resolvedMode: 'plan', request: 'Plan the OAuth work.' }),
      feedback: 'Step 2 assumes an in-process cache. It is Redis.',
      mode: getWorkMode('plan'),
      modeSwitched: false,
      resumed: false,
      priorOutput: '## Steps\n1. Add the route.',
    });

    expect(prompt).toContain('You are planning a change');
    expect(prompt).toContain('Plan the OAuth work.');
    expect(prompt).toContain('1. Add the route.');
    expect(prompt).toContain('Still change no files.');
  });

  it('replaces the read-only instructions in full when a plan becomes a build', () => {
    const prompt = buildChangeRequestPrompt({
      ...base,
      feedback: 'Implement the plan you wrote, in full.',
      mode: getWorkMode('build'),
      modeSwitched: true,
      resumed: true,
    });

    // The session was told not to touch anything. That has to be revoked
    // explicitly rather than contradicted quietly.
    expect(prompt).toContain('You are implementing a change inside an isolated');
    expect(prompt).toContain('replace the read-only instructions');
    expect(prompt).toContain('Do not run git commit');
    // The session still holds the plan, so it is not repeated back at it.
    expect(prompt).not.toContain('What the last iteration produced');
  });

  it('keeps a plan-mode follow-up read-only', () => {
    const prompt = buildChangeRequestPrompt({
      ...base,
      feedback: 'Step 2 assumes an in-process cache. It is Redis.',
      mode: getWorkMode('plan'),
      modeSwitched: false,
      resumed: true,
    });
    expect(prompt).toContain('Still change no files.');
    expect(prompt).not.toContain('The same checks will run again');
  });

  it('keeps an ask-mode follow-up read-only', () => {
    const prompt = buildChangeRequestPrompt({
      ...base,
      feedback: 'And where is it invalidated on logout?',
      mode: getWorkMode('ask'),
      modeSwitched: false,
      resumed: true,
    });
    expect(prompt).toContain('Still change no files.');
    expect(prompt).not.toContain('The same checks will run again');
  });

  it('quotes recorded validation output as fact', () => {
    const prompt = buildChangeRequestPrompt({
      ...base,
      feedback: 'Fix the lint failure.',
      validations: [
        {
          id: 'val_1',
          attempt: 1,
          kind: 'lint',
          commandSource: 'project',
          command: 'npm run lint',
          workingDir: null,
          outcome: 'fail',
          blocking: true,
          exitCode: 1,
          durationMs: 861,
          stdout: 'src/a.ts:3:1  error  Unexpected any',
          stderr: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        },
      ],
      mode: getWorkMode('build'),
      modeSwitched: false,
      resumed: true,
    });

    expect(prompt).toContain('Validation failed after your last change');
    expect(prompt).toContain('Unexpected any');
    expect(prompt).toContain('exit 1');
  });
});
