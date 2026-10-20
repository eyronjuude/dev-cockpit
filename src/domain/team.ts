import { z } from 'zod';

export const TEAM_ROLES = ['lead', 'engineer', 'reviewer', 'functional-qa', 'regression-qa', 'ux-qa'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const TEAM_LABELS: Record<TeamRole, string> = {
  lead: 'Tech lead', engineer: 'Engineer', reviewer: 'Reviewer',
  'functional-qa': 'Functional QA', 'regression-qa': 'Regression QA', 'ux-qa': 'UX QA',
};
export const TEAM_RESPONSIBILITIES: Record<TeamRole, string> = {
  lead: 'Propose an actionable approach, identify risks and acceptance criteria, and hand the work to the engineer. Reconcile feedback from the team.',
  engineer: 'Implement the agreed approach, address team findings, and report changes and verification evidence.',
  reviewer: 'Inspect architecture, correctness, security, and maintainability. Challenge unsupported assumptions and cite specific files and lines.',
  'functional-qa': 'Assess the request and acceptance criteria against the changes. Look for missing behavior and edge cases.',
  'regression-qa': 'Assess compatibility, integrations, regression risks, test coverage, and the recorded validation results.',
  'ux-qa': 'Assess user flows, accessibility, loading and error states, and responsive behavior from the supplied code. Clearly identify browser and visual checks that have not been performed. For changes without UI, say this role is not applicable.',
};

export const TEAM_PROVIDERS = ['claude-code', 'codex-code', 'gemini-cli'] as const;
export const TEAM_PROVIDER_LABELS = { 'claude-code': 'Claude Code', 'codex-code': 'Codex CLI', 'gemini-cli': 'Gemini CLI' };

export const teamMemberSchema = z.object({
  provider: z.enum(TEAM_PROVIDERS),
  model: z.string().trim().max(120).nullable(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']),
  instructions: z.string().trim().max(8_000),
});
export const teamConfigSchema = z.object({
  members: z.object({
    lead: teamMemberSchema, engineer: teamMemberSchema, reviewer: teamMemberSchema,
    'functional-qa': teamMemberSchema, 'regression-qa': teamMemberSchema, 'ux-qa': teamMemberSchema,
  }),
});
export type TeamConfig = z.infer<typeof teamConfigSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;

export function defaultTeam(): TeamConfig {
  return teamConfigSchema.parse({ members: Object.fromEntries(TEAM_ROLES.map((role) => [role, {
    provider: 'claude-code', model: null, effort: 'high', instructions: '',
  }])) });
}

export interface TeamActivity {
  role: TeamRole | 'user';
  to: TeamRole | 'team';
  kind: 'started' | 'message' | 'completed' | 'failed';
  text: string;
  provider?: string;
  model?: string | null;
  effort?: string | null;
  durationMs?: number;
  costUsd?: number | null;
}

export interface TeamReviewStamp {
  iterationId: string | null;
  validationAttempt: number;
  reviewAttempt: number;
}
