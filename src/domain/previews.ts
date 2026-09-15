export const PREVIEW_STATUSES = [
  'not_configured',
  'not_started',
  'starting',
  'ready',
  /**
   * The process is alive but never answered its readiness probe within the
   * project's timeout.
   *
   * A distinct state rather than `failed`, because the process really is still
   * running: a slow first build is the usual cause, the log is still being
   * captured, and killing it would throw away the thing worth reading. It is
   * also not `starting`, because nothing is waiting for it any more.
   */
  'unresponsive',
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
  /** The URL a readiness probe hits: `url` plus the project's ready path. */
  readyUrl: string | null;
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
  /**
   * Bumped every time the process is started. The Preview tab keys its iframe
   * on this so a restart re-renders rather than showing the dead server's last
   * paint.
   */
  generation: number;
  /** Tail of the captured log, for the Preview tab. */
  logTail: string | null;
}

/**
 * Joins a path onto the preview's base URL without doubling or dropping a
 * slash.
 *
 * Here rather than in `services/previews` because two callers need to agree:
 * the readiness probe builds the URL it polls, and the Preview tab builds the
 * URL it frames. Two joiners that nearly agree would put the probe and the
 * iframe on different pages.
 */
export function joinPreviewPath(base: string, path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return base;
  const suffix = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return suffix === '/' ? base : `${base}${suffix}`;
}
