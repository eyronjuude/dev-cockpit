export const PREVIEW_STATUSES = [
  'not_configured',
  'not_started',
  'starting',
  'ready',
  'stopped',
  'failed',
] as const;

export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

export interface PreviewView {
  configured: boolean;
  command: string | null;
  running: boolean;
  status: PreviewStatus;
  url: string | null;
  port: number | null;
  pid: number | null;
  cwd: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  logArtifactId: string | null;
  logPath: string | null;
  error: string | null;
}
