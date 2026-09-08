import type { ResolvedWorkMode } from '@/domain/modes';
import { permissionModeAllowsCommands } from '@/domain/types';
import type { ProjectView } from '@/services/projects';
import type { RunView, ValidationResultView } from '@/services/runs';
import { effectivePermissionMode, type WorkModeBehaviour } from './modes';
import type { ExecutionProfile } from './profiles';

/**
 * Prompt construction for the implementation agent.
 *
 * The orchestrator, not the agent, owns the rules of engagement: the agent is
 * told it is working in a disposable worktree, that validation runs afterwards
 * regardless of what it claims, and whether it may commit.
 *
 * The working mode picks which set of rules opens the prompt. The read-only
 * modes are enforced twice on purpose — the agent runs under Claude Code's
 * `plan` permission mode *and* is told what it is for. The permission mode is
 * what makes "changes nothing" true; the prompt is what makes the output
 * useful.
 */

const BUILD_RULES = `You are implementing a change inside an isolated Git worktree created for this task.

How this works:
- This worktree is disposable and on its own branch. The developer's real checkout is untouched.
- After you stop, an orchestrator runs this project's configured checks (typecheck, lint, tests, build) against your work and records the results. Your own assessment does not decide whether the task is done.
- Because of that, do not claim anything passes unless you actually ran it. Reporting "I believe this works" is fine; reporting a green test suite you never ran is not.
- Work only inside this worktree.`;

const PLAN_RULES = `You are planning a change inside an isolated Git worktree created for this task. You are not implementing it.

How this works:
- Read as much of the repository as you need. Do not create, edit or delete any file, and do not run anything that changes state.
- Your closing message *is* the deliverable. It is stored as this run's plan and it is what the developer reads. Nothing you leave on disk is kept.
- No checks run after you stop, because nothing changed. A person reads the plan and decides whether to implement it.
- Say plainly what you could not verify and where you are guessing. A plan that names its risks is worth more than one that sounds finished.`;

const PLAN_SHAPE = `Write the plan as Markdown, in this order, leaving out any section that would be empty:

1. **What needs to change, and why** — a short paragraph.
2. **Where** — the files and functions involved, by path.
3. **Steps** — in the order they should be done, each small enough to check.
4. **How it gets proved** — the checks or tests that would show it works, including any that do not exist yet.
5. **Risks and open questions** — anything that could make this plan wrong.

Keep code to short illustrative fragments. This is a plan, not a patch.`;

const ASK_RULES = `You are answering a question about a repository, from an isolated Git worktree created for this task. You are not changing anything and you are not planning a change.

How this works:
- Read as much of the repository as you need. Do not create, edit or delete any file, and do not run anything that changes state.
- Your closing message *is* the deliverable. It is stored as this run's answer and it is what the developer reads. Nothing you leave on disk is kept.
- No checks run after you stop, because nothing changed.
- Answer from what the code actually does, not from what it looks like it should do. Where you could not find something, say so instead of filling the gap.`;

const ASK_SHAPE = `Lead with the answer in the first sentence or two, then the evidence for it.

- Anchor every claim about the code to a real path, as \`src/example.ts:42\`.
- Where the answer is "it depends", say what it depends on.
- Do not propose a plan or a change unless the question asked for one. If the answer implies work, name it in a closing line and stop — a follow-up run can plan or do it.`;

const NO_COMMIT_RULE = `- Do not run git commit, git push, git merge, git rebase, git reset --hard, or anything that rewrites history. Leave your changes in the working tree; the orchestrator captures the diff.`;

const COMMIT_ALLOWED_RULE = `- You may create local commits on this branch if it helps you work. Never push, merge, rebase or force-push.`;

/** What to say when an iteration runs in a different mode from the last one. */
const MODE_SWITCH_NOTE: Record<ResolvedWorkMode, string> = {
  build:
    'This run has switched to implementation. The rules above replace the read-only instructions you were given earlier: you may now edit files in this worktree.',
  plan: 'This run has switched to planning. The rules above replace the instructions you were given earlier: do not change anything further.',
  ask: 'This run has switched to answering a question. The rules above replace the instructions you were given earlier: do not change anything further.',
};

/** How to close a follow-up prompt in each mode. */
const FOLLOW_UP_INSTRUCTION: Record<ResolvedWorkMode, string> = {
  build: 'Fix the above in this same worktree. The same checks will run again afterwards.',
  plan: 'Revise the plan and return the whole of it in your closing message. Still change no files.',
  ask: 'Answer again, in full, in your closing message. Still change no files.',
};

/** The opening rules for a mode, including the commit policy where it applies. */
function openingRules(project: ProjectView, mode: WorkModeBehaviour): string[] {
  switch (mode.id) {
    case 'ask':
      return [ASK_RULES, ASK_SHAPE];
    case 'plan':
      return [PLAN_RULES, PLAN_SHAPE];
    case 'build':
      return [BUILD_RULES, project.allowAgentCommit ? COMMIT_ALLOWED_RULE : NO_COMMIT_RULE];
  }
}

/** The project's enabled validation commands, as prompt lines. */
function checkLines(project: ProjectView): string[] {
  return project.validationCommands
    .filter((c) => c.enabled && c.command.trim())
    .map((c) => `- ${c.kind}: \`${c.command}\``);
}

/**
 * The task, from the specification when a transformer produced one and from the
 * request as typed otherwise. Never both: two versions of the task invites
 * drift.
 */
function taskSection(run: RunView): string {
  if (run.spec && run.spec.trim() && run.spec.trim() !== run.request.trim()) {
    return `# Task\n\nThe developer asked for this:\n\n"""\n${run.request}\n"""\n\nExpanded into a specification:\n\n${run.spec}`;
  }
  return `# Task\n\n${run.request}`;
}

export interface BuildPromptInput {
  run: RunView;
  project: ProjectView;
  profile: ExecutionProfile;
  mode: WorkModeBehaviour;
}

/** Prompt for the first implementation iteration. */
export function buildInitialPrompt(input: BuildPromptInput): string {
  const { run, project, profile, mode } = input;
  const sections: string[] = openingRules(project, mode);
  const checks = checkLines(project);

  if (mode.editsCode) {
    /**
     * Whether the agent can run a command at all depends on the permission
     * mode. The default, `bypassPermissions`, lets it run the project's own
     * checks. A project pinned to `acceptEdits` permits file edits but denies
     * every Bash and PowerShell call, so telling that agent to verify its own
     * work would be a lie — and an expensive one, because it spends turns on
     * calls that cannot succeed. Observed on a real run: five denied read-only
     * git commands.
     *
     * Read through the mode: a mode can only take capability away, so the
     * answer has to be the permission mode the agent is really given.
     */
    const canRunCommands = permissionModeAllowsCommands(
      effectivePermissionMode(project.effectivePermissionMode, mode),
    );

    const cannotRunNote = [
      'You cannot run them yourself: this session denies shell commands, so every Bash or',
      'PowerShell call will be refused. Do not spend turns trying, and never report a result',
      'you were unable to obtain. Read the code carefully instead, and say plainly what you',
      'could not verify.',
    ].join(' ');

    const canRunNote = [
      'Shell commands are available to you in this session, and nothing will stop to ask for',
      'approval. Run these yourself before you finish and fix what they report: a failure you',
      'hand over is a round trip, and the same commands run again afterwards either way.',
    ].join(' ');

    if (checks.length > 0) {
      const note = canRunCommands ? canRunNote : cannotRunNote;
      sections.push(
        `The checks that will run against your work after you stop:\n${checks.join('\n')}\n\n${note}`,
      );
    } else {
      sections.push(
        canRunCommands
          ? 'This project has no validation commands configured, so nothing will be run automatically. Be correspondingly careful.'
          : 'This project has no validation commands configured, and this session denies shell commands, so nothing will be run either by you or afterwards. Be correspondingly careful, and say plainly what is unverified.',
      );
    }

    // Profile suffixes are written for a code change ("do not refactor adjacent
    // code", "add tests"), so they are only appended when there is one.
    if (profile.promptSuffix) sections.push(profile.promptSuffix);
  } else if (mode.id === 'plan' && checks.length > 0) {
    // Useful context for the "How it gets proved" section, stated as fact
    // rather than as an instruction: a plan run runs none of these. An ask run
    // does not need them at all — a question is not answered by a test suite.
    sections.push(
      `The checks this project already has configured, for the plan to account for:\n${checks.join(
        '\n',
      )}`,
    );
  }

  sections.push(taskSection(run));

  return sections.join('\n\n');
}

export interface BuildChangeRequestInput {
  run: RunView;
  project: ProjectView;
  /** What the user typed into "Request changes". */
  feedback: string;
  /** Validation from the most recent attempt, so failures are quoted as fact. */
  validations: readonly ValidationResultView[];
  findings: readonly { severity: string; title: string; file: string | null; detail: string | null }[];
  /** The mode this iteration runs in, which may differ from the last one. */
  mode: WorkModeBehaviour;
  /** True when the mode changed for this iteration. */
  modeSwitched: boolean;
  /**
   * Whether the agent session from the previous iteration is being resumed.
   *
   * False means the agent starts cold and inherits nothing, so the prompt has
   * to carry the rules and the task itself.
   */
  resumed: boolean;
  /**
   * The previous iteration's closing message — a plan, usually. Supplied only
   * when no session is being resumed; a resumed session already has it, and
   * repeating it would compete with the context the agent built.
   */
  priorOutput?: string | null;
}

/**
 * Prompt for a follow-up iteration.
 *
 * Short when the session is resumed, because it still has its own context and
 * repeating the whole task would compete with what it already knows.
 *
 * Two things break that. A **cold session** inherited nothing — no rules, no
 * task, no earlier output — so the full brief is rebuilt. A **mode switch**
 * means the session was told not to touch anything, or to go ahead and edit,
 * and that instruction has to be replaced explicitly rather than contradicted
 * quietly.
 */
export function buildChangeRequestPrompt(input: BuildChangeRequestInput): string {
  const { run, project, feedback, validations, findings, mode, modeSwitched, resumed } = input;
  const sections: string[] = [];

  if (!resumed) {
    sections.push(...openingRules(project, mode), taskSection(run));
  } else if (modeSwitched) {
    sections.push(...openingRules(project, mode), MODE_SWITCH_NOTE[mode.id]);
  }

  const priorOutput = input.priorOutput?.trim();
  if (priorOutput) {
    sections.push(
      `# What the last iteration produced\n\nThis is the closing message from the previous pass in this run. It is the starting point, not a specification — say so if part of it turns out to be wrong.\n\n${priorOutput}`,
    );
  }

  const failures = validations.filter((v) => v.outcome === 'fail' || v.outcome === 'error');
  if (failures.length > 0) {
    const detail = failures
      .map((v) => {
        const head = `## ${v.kind} — ${v.outcome}${
          v.exitCode === null ? '' : ` (exit ${v.exitCode})`
        }`;
        const command = v.command ? `Command: \`${v.command}\`` : '';
        const output = [v.stdout, v.stderr]
          .filter((s) => s && s.trim())
          .join('\n')
          .trim();
        const tail = output ? `\n\`\`\`\n${lastLines(output, 60)}\n\`\`\`` : '';
        return [head, command, v.error ?? '', tail].filter(Boolean).join('\n');
      })
      .join('\n\n');

    sections.push(`Validation failed after your last change. This is the recorded output:\n\n${detail}`);
  }

  if (findings.length > 0) {
    const list = findings
      .map(
        (f) =>
          `- [${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ''}${
            f.detail ? `\n  ${f.detail}` : ''
          }`,
      )
      .join('\n');
    sections.push(
      `An independent reviewer raised these points. They are opinions, not test results — push back in your summary if one is wrong:\n\n${list}`,
    );
  }

  sections.push(`# What the developer wants changed\n\n${feedback}`);
  sections.push(FOLLOW_UP_INSTRUCTION[mode.id]);

  return sections.join('\n\n');
}

function lastLines(text: string, count: number): string {
  const lines = text.split('\n');
  if (lines.length <= count) return text;
  return lines.slice(-count).join('\n');
}
