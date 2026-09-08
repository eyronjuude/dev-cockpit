import type { ProjectView } from '@/services/projects';
import type { RunView, ValidationResultView } from '@/services/runs';
import type { ExecutionProfile } from './profiles';

/**
 * Prompt construction for the implementation agent.
 *
 * The orchestrator, not the agent, owns the rules of engagement: the agent is
 * told it is working in a disposable worktree, that validation runs afterwards
 * regardless of what it claims, and whether it may commit.
 */

const BASE_RULES = `You are implementing a change inside an isolated Git worktree created for this task.

How this works:
- This worktree is disposable and on its own branch. The developer's real checkout is untouched.
- After you stop, an orchestrator runs this project's configured checks (typecheck, lint, tests, build) against your work and records the results. Your own assessment does not decide whether the task is done.
- Because of that, do not claim anything passes unless you actually ran it. Reporting "I believe this works" is fine; reporting a green test suite you never ran is not.
- Work only inside this worktree.`;

const NO_COMMIT_RULE = `- Do not run git commit, git push, git merge, git rebase, git reset --hard, or anything that rewrites history. Leave your changes in the working tree; the orchestrator captures the diff.`;

const COMMIT_ALLOWED_RULE = `- You may create local commits on this branch if it helps you work. Never push, merge, rebase or force-push.`;

export interface BuildPromptInput {
  run: RunView;
  project: ProjectView;
  profile: ExecutionProfile;
}

/** Prompt for the first implementation iteration. */
export function buildInitialPrompt(input: BuildPromptInput): string {
  const { run, project, profile } = input;
  const sections: string[] = [BASE_RULES];

  sections.push(project.allowAgentCommit ? COMMIT_ALLOWED_RULE : NO_COMMIT_RULE);

  const checks = project.validationCommands
    .filter((c) => c.enabled && c.command.trim())
    .map((c) => `- ${c.kind}: \`${c.command}\``);

  /**
   * Whether the agent can run a command at all depends on the permission mode.
   * `acceptEdits` permits file edits but denies every Bash and PowerShell call,
   * so telling the agent to verify its own work would be a lie — and an
   * expensive one, because it spends turns on calls that cannot succeed.
   * Observed on a real run: five denied read-only git commands.
   */
  const canRunCommands = project.agentPermissionMode === 'bypassPermissions';

  const cannotRunNote = [
    'You cannot run them yourself: this session denies shell commands, so every Bash or',
    'PowerShell call will be refused. Do not spend turns trying, and never report a result',
    'you were unable to obtain. Read the code carefully instead, and say plainly what you',
    'could not verify.',
  ].join(' ');

  if (checks.length > 0) {
    const note = canRunCommands
      ? 'Running them yourself before you finish is encouraged.'
      : cannotRunNote;
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

  if (!canRunCommands) {
    sections.push(
      'Tools available to you: reading, writing and editing files, and searching the repository. Bash and PowerShell are not.',
    );
  }

  if (profile.promptSuffix) sections.push(profile.promptSuffix);

  // The specification, when a transformer produced one, otherwise the request
  // exactly as typed. Never both: two versions of the task invites drift.
  if (run.spec && run.spec.trim() && run.spec.trim() !== run.request.trim()) {
    sections.push(
      `# Task\n\nThe developer asked for this:\n\n"""\n${run.request}\n"""\n\nExpanded into a specification:\n\n${run.spec}`,
    );
  } else {
    sections.push(`# Task\n\n${run.request}`);
  }

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
}

/**
 * Prompt for a follow-up iteration.
 *
 * Kept short on purpose: the agent session is resumed, so it still has its own
 * context. Repeating the whole task would compete with what it already knows.
 */
export function buildChangeRequestPrompt(input: BuildChangeRequestInput): string {
  const { feedback, validations, findings } = input;
  const sections: string[] = [];

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

  sections.push(
    'Fix the above in this same worktree. The same checks will run again afterwards.',
  );

  return sections.join('\n\n');
}

function lastLines(text: string, count: number): string {
  const lines = text.split('\n');
  if (lines.length <= count) return text;
  return lines.slice(-count).join('\n');
}
