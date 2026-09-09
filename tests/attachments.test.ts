import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  attachmentMimeType,
  attachmentRejection,
  ATTACHMENT_MUTABLE_STATUSES,
  attachmentsMutable,
  fileExtension,
  isInlineViewableMime,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_RUN,
  safeAttachmentFileName,
} from '@/domain/attachments';
import { RUN_STATUSES, type RunStatus } from '@/domain/types';

/* ------------------------------------------------------------------ *
 * Rules — pure, no database
 * ------------------------------------------------------------------ */

describe('attachment file names', () => {
  it('keeps an ordinary name unchanged', () => {
    expect(safeAttachmentFileName('bug-report.png')).toBe('bug-report.png');
    expect(safeAttachmentFileName('Design Spec v2.pdf')).toBe('Design Spec v2.pdf');
  });

  it('drops directory components from a traversal attempt', () => {
    expect(safeAttachmentFileName('../../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentFileName('..\\..\\Windows\\System32\\drivers\\etc\\hosts')).toBe('hosts');
    expect(safeAttachmentFileName('/absolute/path/report.log')).toBe('report.log');
    expect(safeAttachmentFileName('C:\\Users\\me\\secret.txt')).toBe('secret.txt');
  });

  it('refuses to produce a name that is only dots', () => {
    // `..` is the whole mechanism traversal relies on, and a leading dot would
    // hide the file from a directory listing.
    expect(safeAttachmentFileName('..')).toBe('attachment');
    expect(safeAttachmentFileName('.')).toBe('attachment');
    expect(safeAttachmentFileName('.env.local')).toBe('env.local');
    expect(safeAttachmentFileName('')).toBe('attachment');
  });

  it('replaces control characters and the characters Windows refuses', () => {
    expect(safeAttachmentFileName('log\u0000with\u001fnulls.txt')).toBe('log_with_nulls.txt');
    expect(safeAttachmentFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(safeAttachmentFileName('new\nline.txt')).toBe('new_line.txt');
  });

  it('caps the length but keeps the extension', () => {
    const long = `${'x'.repeat(400)}.png`;
    const safe = safeAttachmentFileName(long);
    expect(safe.length).toBeLessThanOrEqual(120);
    // A truncated extension would be served as the wrong type.
    expect(safe.endsWith('.png')).toBe(true);
  });

  it('reads the extension case-insensitively', () => {
    expect(fileExtension('SHOT.PNG')).toBe('.png');
    expect(fileExtension('archive.tar.gz')).toBe('.gz');
    expect(fileExtension('Makefile')).toBe('');
    expect(fileExtension('trailing.')).toBe('');
  });
});

describe('attachment types', () => {
  it('maps the common cases', () => {
    expect(attachmentMimeType('shot.png')).toBe('image/png');
    expect(attachmentMimeType('notes.md')).toBe('text/markdown');
    expect(attachmentMimeType('trace.jsonl')).toBe('application/x-ndjson');
    expect(attachmentMimeType('spec.pdf')).toBe('application/pdf');
  });

  it('falls back to a download for anything it does not know', () => {
    expect(attachmentMimeType('bundle.zip')).toBe('application/octet-stream');
    expect(attachmentMimeType('Makefile')).toBe('application/octet-stream');
    expect(isInlineViewableMime('application/octet-stream')).toBe(false);
  });

  it('never lets attached markup be served as a document', () => {
    // Served as text/html it would run script in this application's own
    // origin, and this application drives shell commands on the machine.
    for (const name of ['payload.html', 'payload.htm', 'payload.xhtml']) {
      expect(attachmentMimeType(name)).toBe('text/plain');
      expect(isInlineViewableMime(attachmentMimeType(name))).toBe(false);
    }
  });

  it('keeps SVG as an image, which the route serves sandboxed', () => {
    expect(attachmentMimeType('diagram.svg')).toBe('image/svg+xml');
    expect(isInlineViewableMime('image/svg+xml')).toBe(true);
  });

  it('shows images and PDFs inline and nothing else', () => {
    expect(isInlineViewableMime('image/png')).toBe(true);
    expect(isInlineViewableMime('application/pdf')).toBe(true);
    expect(isInlineViewableMime('text/plain')).toBe(false);
    expect(isInlineViewableMime('image/svg+xml')).toBe(true);
  });
});

describe('attachment limits', () => {
  it('accepts a reasonable file', () => {
    expect(attachmentRejection({ fileName: 'shot.png', bytes: 120_000 }, 0)).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(attachmentRejection({ fileName: 'empty.txt', bytes: 0 }, 0)).toMatch(/empty/i);
  });

  it('refuses a file over the size limit', () => {
    expect(
      attachmentRejection({ fileName: 'huge.bin', bytes: MAX_ATTACHMENT_BYTES + 1 }, 0),
    ).toMatch(/limit for one attachment/i);
    expect(
      attachmentRejection({ fileName: 'exact.bin', bytes: MAX_ATTACHMENT_BYTES }, 0),
    ).toBeNull();
  });

  it('counts the run total, not the batch', () => {
    expect(
      attachmentRejection({ fileName: 'one-more.txt', bytes: 10 }, MAX_ATTACHMENTS_PER_RUN - 1),
    ).toBeNull();
    expect(
      attachmentRejection({ fileName: 'one-too-many.txt', bytes: 10 }, MAX_ATTACHMENTS_PER_RUN),
    ).toMatch(/one too many/i);
  });
});

describe('when attachments may change', () => {
  it('allows exactly the statuses that can still reach an agent', () => {
    // Every mutable status has a documented transition back to IMPLEMENTING,
    // which is what makes a file attached now something the run will read.
    expect([...ATTACHMENT_MUTABLE_STATUSES].sort()).toEqual(
      ['CANCELLED', 'DRAFT', 'FAILED', 'NEEDS_CHANGES', 'PAUSED', 'READY'].sort(),
    );
  });

  it('locks the list once the run is working, landing or finished', () => {
    const locked: RunStatus[] = [
      'PREPARING',
      'IMPLEMENTING',
      'VALIDATING',
      'REVIEWING',
      'APPROVED',
      'LANDING',
      'LANDED',
      'REJECTED',
      'MERGE_CONFLICT',
      'LANDING_FAILED',
    ];
    for (const status of locked) {
      expect(attachmentsMutable(status), status).toBe(false);
    }
  });

  it('has an answer for every run status', () => {
    for (const status of RUN_STATUSES) {
      expect(typeof attachmentsMutable(status)).toBe('boolean');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Service and prompt — real database, real files on disk
 * ------------------------------------------------------------------ */

let dataDir: string;
let repoDir: string;

let attachmentsService: typeof import('@/services/attachments');
let projectsService: typeof import('@/services/projects');
let runsService: typeof import('@/services/runs');
let paths: typeof import('@/core/paths');
let promptMod: typeof import('@/orchestrator/prompt');
let profilesMod: typeof import('@/orchestrator/profiles');
let modesMod: typeof import('@/orchestrator/modes');
let closeDb: typeof import('@/db/client').closeDb;

let projectId: string;

const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

async function newRun(request = 'Attach things to me'): Promise<string> {
  const run = runsService.createRun({ projectId, request });
  return run.id;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-att-'));
  process.env.DEV_COCKPIT_DATA_DIR = dataDir;

  repoDir = path.join(dataDir, 'source-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', windowsHide: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# source\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'initial commit']);

  attachmentsService = await import('@/services/attachments');
  projectsService = await import('@/services/projects');
  runsService = await import('@/services/runs');
  paths = await import('@/core/paths');
  promptMod = await import('@/orchestrator/prompt');
  profilesMod = await import('@/orchestrator/profiles');
  modesMod = await import('@/orchestrator/modes');
  ({ closeDb } = await import('@/db/client'));

  const project = await projectsService.createProject({
    name: 'attachment-project',
    repositoryPath: repoDir,
  });
  projectId = project.id;
});

afterAll(() => {
  closeDb?.();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows sometimes holds a handle briefly; the temp directory is disposable.
  }
  delete process.env.DEV_COCKPIT_DATA_DIR;
});

describe('storing an attachment', () => {
  it('writes the bytes, records the row, and keeps them associated with the run', async () => {
    const runId = await newRun();
    const added = await attachmentsService.addAttachment({
      runId,
      fileName: 'repro.log',
      data: bytesOf('TypeError: undefined is not a function\n'),
    });

    expect(added.runId).toBe(runId);
    expect(added.fileName).toBe('repro.log');
    expect(added.mimeType).toBe('text/plain');
    expect(added.bytes).toBe(39);
    expect(added.exists).toBe(true);

    // Verbatim: an attachment is the developer's own file, not machine output
    // to be redacted or rewritten.
    expect(fs.readFileSync(added.filePath, 'utf8')).toBe(
      'TypeError: undefined is not a function\n',
    );

    expect(attachmentsService.listAttachments(runId).map((a) => a.id)).toEqual([added.id]);
    expect(runsService.requireRun(runId).attachments.map((a) => a.fileName)).toEqual([
      'repro.log',
    ]);
  });

  it('keeps one run’s attachments out of another’s list', async () => {
    const runA = await newRun('run A');
    const runB = await newRun('run B');

    const a = await attachmentsService.addAttachment({
      runId: runA,
      fileName: 'a.txt',
      data: bytesOf('a'),
    });
    const b = await attachmentsService.addAttachment({
      runId: runB,
      fileName: 'b.txt',
      data: bytesOf('b'),
    });

    expect(attachmentsService.listAttachments(runA).map((x) => x.id)).toEqual([a.id]);
    expect(attachmentsService.listAttachments(runB).map((x) => x.id)).toEqual([b.id]);

    // A separate directory per run, because the whole directory is handed to
    // the agent with --add-dir.
    expect(path.dirname(a.filePath)).toBe(paths.runAttachmentDir(runA));
    expect(path.dirname(b.filePath)).toBe(paths.runAttachmentDir(runB));

    // Addressed through its run, so a mismatched pair is not served.
    expect(attachmentsService.getRunAttachment(runA, a.id)?.id).toBe(a.id);
    expect(attachmentsService.getRunAttachment(runA, b.id)).toBeNull();
    expect(attachmentsService.getRunAttachment(runB, a.id)).toBeNull();
  });

  it('writes inside the attachment root even when the name attempts traversal', async () => {
    const runId = await newRun();
    const added = await attachmentsService.addAttachment({
      runId,
      fileName: '../../../../evil.txt',
      data: bytesOf('nope'),
    });

    expect(added.fileName).toBe('evil.txt');
    expect(paths.isInside(paths.runAttachmentDir(runId), added.filePath)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'evil.txt'))).toBe(false);
  });

  it('keeps both files when two have the same name', async () => {
    const runId = await newRun();
    const first = await attachmentsService.addAttachment({
      runId,
      fileName: 'shot.png',
      data: bytesOf('first'),
    });
    const second = await attachmentsService.addAttachment({
      runId,
      fileName: 'shot.png',
      data: bytesOf('second'),
    });

    expect(first.filePath).not.toBe(second.filePath);
    expect(fs.readFileSync(first.filePath, 'utf8')).toBe('first');
    expect(fs.readFileSync(second.filePath, 'utf8')).toBe('second');
    expect(attachmentsService.listAttachments(runId)).toHaveLength(2);
  });

  it('derives the type from the extension rather than trusting a caller', async () => {
    const runId = await newRun();
    const added = await attachmentsService.addAttachment({
      runId,
      fileName: 'looks-like-a-page.html',
      data: bytesOf('<script>alert(1)</script>'),
    });
    expect(added.mimeType).toBe('text/plain');
    expect(added.inlineViewable).toBe(false);
  });

  it('records an event so the attachment appears in the run log', async () => {
    const runId = await newRun();
    await attachmentsService.addAttachment({
      runId,
      fileName: 'notes.md',
      data: bytesOf('# notes'),
    });

    const events = await import('@/services/events');
    const types = events.listEvents(runId).map((e) => e.type);
    expect(types).toContain('attachment.added');
  });

  it('refuses an empty file and one over the size limit', async () => {
    const runId = await newRun();
    await expect(
      attachmentsService.addAttachment({ runId, fileName: 'empty.txt', data: new Uint8Array(0) }),
    ).rejects.toThrow(/empty/i);
    await expect(
      attachmentsService.addAttachment({
        runId,
        fileName: 'huge.bin',
        data: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      }),
    ).rejects.toThrow(/limit for one attachment/i);
    expect(attachmentsService.listAttachments(runId)).toHaveLength(0);
  });

  it('stops at the per-run limit', async () => {
    const runId = await newRun();
    for (let i = 0; i < MAX_ATTACHMENTS_PER_RUN; i += 1) {
      await attachmentsService.addAttachment({
        runId,
        fileName: `file-${i}.txt`,
        data: bytesOf(`file ${i}`),
      });
    }
    await expect(
      attachmentsService.addAttachment({
        runId,
        fileName: 'overflow.txt',
        data: bytesOf('too much'),
      }),
    ).rejects.toThrow(/one too many/i);
    expect(attachmentsService.listAttachments(runId)).toHaveLength(MAX_ATTACHMENTS_PER_RUN);
  });

  it('refuses to attach to a run that does not exist', async () => {
    await expect(
      attachmentsService.addAttachment({
        runId: 'run_nope',
        fileName: 'x.txt',
        data: bytesOf('x'),
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('adding a batch', () => {
  it('records every file in order', async () => {
    const runId = await newRun();
    const added = await attachmentsService.addAttachments(runId, [
      { fileName: 'one.txt', data: bytesOf('1') },
      { fileName: 'two.png', data: bytesOf('2') },
    ]);

    expect(added.map((a) => a.fileName)).toEqual(['one.txt', 'two.png']);
    expect(attachmentsService.listAttachments(runId).map((a) => a.fileName)).toEqual([
      'one.txt',
      'two.png',
    ]);
  });

  it('keeps what it accepted before a file was refused', async () => {
    const runId = await newRun();
    await expect(
      attachmentsService.addAttachments(runId, [
        { fileName: 'good.txt', data: bytesOf('fine') },
        { fileName: 'bad.txt', data: new Uint8Array(0) },
        { fileName: 'never.txt', data: bytesOf('unreached') },
      ]),
    ).rejects.toThrow(/empty/i);

    // Partial rather than atomic, and visible: the accepted file is recorded
    // and the caller is told which one broke.
    expect(attachmentsService.listAttachments(runId).map((a) => a.fileName)).toEqual([
      'good.txt',
    ]);
  });
});

describe('removing an attachment', () => {
  it('deletes the row and the file', async () => {
    const runId = await newRun();
    const added = await attachmentsService.addAttachment({
      runId,
      fileName: 'gone.txt',
      data: bytesOf('bye'),
    });

    await attachmentsService.removeAttachment(runId, added.id);

    expect(fs.existsSync(added.filePath)).toBe(false);
    expect(attachmentsService.listAttachments(runId)).toHaveLength(0);
    expect(attachmentsService.getAttachment(added.id)).toBeNull();
  });

  it('refuses to remove one that belongs to a different run', async () => {
    const runA = await newRun();
    const runB = await newRun();
    const added = await attachmentsService.addAttachment({
      runId: runA,
      fileName: 'mine.txt',
      data: bytesOf('mine'),
    });

    await expect(attachmentsService.removeAttachment(runB, added.id)).rejects.toThrow(
      /not found/i,
    );
    expect(fs.existsSync(added.filePath)).toBe(true);
  });
});

describe('the status gate', () => {
  it('refuses to change the list once the run has started working', async () => {
    const runId = await newRun();
    const added = await attachmentsService.addAttachment({
      runId,
      fileName: 'early.txt',
      data: bytesOf('attached while still a draft'),
    });

    expect(attachmentsService.canModifyAttachments(runId)).toBe(true);
    runsService.setStatus(runId, 'PREPARING', { started: true });
    expect(attachmentsService.canModifyAttachments(runId)).toBe(false);

    await expect(
      attachmentsService.addAttachment({ runId, fileName: 'late.txt', data: bytesOf('too late') }),
    ).rejects.toThrow(/cannot be changed/i);
    await expect(attachmentsService.removeAttachment(runId, added.id)).rejects.toThrow(
      /cannot be changed/i,
    );

    // The file that was already attached is untouched: locking the list must
    // not lose an input the run is about to read.
    expect(attachmentsService.listAttachments(runId).map((a) => a.id)).toEqual([added.id]);
  });

  it('opens again when the run comes back for changes', async () => {
    const runId = await newRun();
    runsService.setStatus(runId, 'PREPARING', { started: true });
    runsService.setStatus(runId, 'IMPLEMENTING');
    runsService.setStatus(runId, 'NEEDS_CHANGES');

    expect(attachmentsService.canModifyAttachments(runId)).toBe(true);
    const added = await attachmentsService.addAttachment({
      runId,
      fileName: 'still-broken.png',
      data: bytesOf('screenshot bytes'),
    });
    expect(added.fileName).toBe('still-broken.png');
  });
});

describe('purging', () => {
  it('removes every attachment file and row for a run', async () => {
    const runId = await newRun();
    const added = await attachmentsService.addAttachments(runId, [
      { fileName: 'a.txt', data: bytesOf('a') },
      { fileName: 'b.txt', data: bytesOf('b') },
    ]);

    await attachmentsService.purgeRunAttachments(runId);

    for (const attachment of added) {
      expect(fs.existsSync(attachment.filePath)).toBe(false);
    }
    expect(fs.existsSync(paths.runAttachmentDir(runId))).toBe(false);
    expect(attachmentsService.listAttachments(runId)).toHaveLength(0);
  });

  it('leaves artifacts alone, because they live under a different root', async () => {
    // The two roots are separate precisely so a cleanup of one cannot reach
    // the other: an artifact is evidence, an attachment is an input.
    expect(paths.isInside(paths.artifactsDir(), paths.runAttachmentDir('run_x'))).toBe(false);
    expect(paths.isInside(paths.attachmentsDir(), paths.runArtifactDir('run_x'))).toBe(false);
  });
});

describe('what the agent is told', () => {
  const buildFor = (runId: string) =>
    promptMod.buildInitialPrompt({
      run: runsService.requireRun(runId),
      project: projectsService.requireProject(projectId),
      profile: profilesMod.getProfile('standard'),
      mode: modesMod.getWorkMode('build'),
    });

  it('says nothing about attachments when there are none', async () => {
    const runId = await newRun();
    expect(buildFor(runId)).not.toMatch(/# Attachments/);
  });

  it('lists each attachment by absolute path, so the agent can open it', async () => {
    const runId = await newRun('The login page looks wrong, see the screenshot.');
    const shot = await attachmentsService.addAttachment({
      runId,
      fileName: 'login.png',
      data: bytesOf('png bytes'),
    });
    const log = await attachmentsService.addAttachment({
      runId,
      fileName: 'server.log',
      data: bytesOf('500 Internal Server Error'),
    });

    const prompt = buildFor(runId);
    expect(prompt).toMatch(/# Attachments/);
    expect(prompt).toContain('attached 2 files');
    expect(prompt).toContain(shot.filePath);
    expect(prompt).toContain(log.filePath);
    expect(prompt).toContain('login.png');
    expect(prompt).toContain('image/png');

    // The contents are never pasted in: the point of the path is that the
    // agent reads only the part it needs.
    expect(prompt).not.toContain('500 Internal Server Error');

    // And the worktree stays clean, which is the reason they live outside it.
    expect(prompt).toMatch(/[Dd]o not copy them into the worktree/);
  });

  it('counts one file in the singular', async () => {
    const runId = await newRun();
    await attachmentsService.addAttachment({
      runId,
      fileName: 'only.txt',
      data: bytesOf('one'),
    });
    expect(buildFor(runId)).toContain('attached one file');
  });

  it('omits a file that has gone missing from disk', async () => {
    const runId = await newRun();
    const added = await attachmentsService.addAttachment({
      runId,
      fileName: 'vanished.txt',
      data: bytesOf('here for now'),
    });
    fs.rmSync(added.filePath);

    // Recorded but no longer readable. Naming a path the agent cannot open
    // would cost it a turn to find out.
    const prompt = buildFor(runId);
    expect(prompt).not.toMatch(/# Attachments/);
    expect(prompt).not.toContain('vanished.txt');
  });

  it('agrees with the directory grant about which files are readable', async () => {
    // The orchestrator decides whether to pass `--add-dir` from this same
    // list. If the two ever disagree the prompt names a path the session
    // cannot open, or the session gets access the prompt never mentions.
    const empty = await newRun();
    expect(promptMod.readableAttachments(runsService.requireRun(empty))).toHaveLength(0);

    const runId = await newRun();
    const kept = await attachmentsService.addAttachment({
      runId,
      fileName: 'kept.txt',
      data: bytesOf('still here'),
    });
    const lost = await attachmentsService.addAttachment({
      runId,
      fileName: 'lost.txt',
      data: bytesOf('about to go'),
    });
    fs.rmSync(lost.filePath);

    const readable = promptMod.readableAttachments(runsService.requireRun(runId));
    expect(readable.map((a) => a.id)).toEqual([kept.id]);
    // And every path it reports is under the directory that would be granted.
    for (const attachment of readable) {
      expect(paths.isInside(paths.runAttachmentDir(runId), attachment.filePath)).toBe(true);
    }
  });

  it('marks a file added since the last pass in a follow-up prompt', async () => {
    const runId = await newRun('Fix the crash');
    const first = await attachmentsService.addAttachment({
      runId,
      fileName: 'original.log',
      data: bytesOf('first report'),
    });

    runsService.setStatus(runId, 'PREPARING', { started: true });
    runsService.createIteration({
      runId,
      kind: 'initial',
      prompt: 'first pass',
      sessionId: null,
      resumed: false,
    });
    runsService.setStatus(runId, 'IMPLEMENTING');
    runsService.setStatus(runId, 'NEEDS_CHANGES');

    // A timestamp comparison decides this, and both are ISO strings written a
    // few milliseconds apart, so the second has to be provably later.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await attachmentsService.addAttachment({
      runId,
      fileName: 'still-wrong.png',
      data: bytesOf('new screenshot'),
    });

    const prompt = promptMod.buildChangeRequestPrompt({
      run: runsService.requireRun(runId),
      project: projectsService.requireProject(projectId),
      feedback: 'It still crashes, see the new screenshot.',
      validations: [],
      findings: [],
      mode: modesMod.getWorkMode('build'),
      modeSwitched: false,
      resumed: true,
    });

    expect(prompt).toContain(second.filePath);
    expect(prompt).toContain(first.filePath);

    const newLine = prompt
      .split('\n')
      .find((line) => line.includes('still-wrong.png'));
    const oldLine = prompt.split('\n').find((line) => line.includes('original.log'));
    expect(newLine).toMatch(/added since your last pass/);
    expect(oldLine).not.toMatch(/added since your last pass/);
  });
});
