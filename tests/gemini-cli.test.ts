import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkGeminiAvailable, GeminiCodeAgent, geminiQuery } from '@/agents/gemini-cli';
import { geminiPermissionArgs } from '@/agents/permissions';
import type { AgentStartInput, AgentStreamEvent } from '@/agents/types';

let dir: string;
let executable: string;
let audit: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-gemini-test-'));
  audit = path.join(dir, 'audit.json');
  const script = path.join(dir, 'fake.cjs');
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const settings = JSON.parse(fs.readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
  fs.writeFileSync(process.env.TEST_GEMINI_AUDIT, JSON.stringify({ prompt, args: process.argv.slice(2), settings,
    cwd: process.cwd(), apiKey: process.env.GEMINI_API_KEY, googleKey: process.env.GOOGLE_API_KEY }));
  const emit = event => console.log(JSON.stringify(event));
  emit({type: 'init', session_id: 'gemini-session', model: 'selected-gemini-model'});
  if (process.env.TEST_GEMINI_MODE === 'wait') { setInterval(() => {}, 1000); return; }
  if (process.env.TEST_GEMINI_MODE === 'fail') { emit({type: 'result', status: 'error', error: {message: 'Quota exhausted'}}); return; }
  emit({type: 'message', role: 'assistant', content: process.env.TEST_GEMINI_MODE === 'invalid' ? 'invalid' : JSON.stringify({summary: 'Gemini handoff', findings: []})});
  emit({type: 'result', status: 'success'});
});
`, { mode: 0o755 });
  executable = process.platform === 'win32' ? path.join(dir, 'gemini.cmd') : script;
  if (process.platform === 'win32') fs.writeFileSync(executable, `@"${process.execPath}" "${script}" %*\r\n`);
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
function configure() {
  vi.stubEnv('DEV_COCKPIT_GEMINI_BIN', executable);
  vi.stubEnv('TEST_GEMINI_AUDIT', audit);
  vi.stubEnv('TEST_GEMINI_MODE', '');
  vi.stubEnv('DEV_COCKPIT_DATA_DIR', path.join(dir, 'data'));
}
function query(signal = new AbortController().signal, timeoutMs = 10_000) {
  return geminiQuery({ prompt: 'Untrusted evidence: $(do not execute)', instructions: 'Read-only reviewer.',
    jsonSchema: { type: 'object' }, model: 'chosen-model', signal, timeoutMs });
}
function agentInput(events: AgentStreamEvent[]): AgentStartInput {
  return { runId: 'gemini-test', iterationId: 'gemini-iteration', prompt: 'Implement the request.',
    worktreePath: dir, model: 'chosen-model', permissionMode: 'bypassPermissions',
    onEvent: (event) => { events.push(event); } };
}
describe('Gemini CLI adapter', () => {
  it('checks availability without a model call and reports missing executables', async () => {
    configure();
    expect(await checkGeminiAvailable()).toMatchObject({ available: true, version: '1.0.0' });
    vi.stubEnv('DEV_COCKPIT_GEMINI_BIN', path.join(dir, 'missing-gemini'));
    expect(await checkGeminiAvailable()).toMatchObject({ available: false, version: null });
  });
  it('uses cached OAuth and isolates read-only queries from tools, hooks and repository context', async () => {
    configure(); vi.stubEnv('GEMINI_API_KEY', 'must-not-be-used'); vi.stubEnv('GOOGLE_API_KEY', 'also-not-used');
    expect(await query()).toMatchObject({ ok: true, structured: { summary: 'Gemini handoff', findings: [] } });
    const captured = JSON.parse(fs.readFileSync(audit, 'utf8'));
    expect(captured.prompt).toContain('$(do not execute)');
    expect(captured.args).toEqual(['--output-format', 'stream-json', '--approval-mode', 'default', '--extensions', 'none', '--model', 'chosen-model']);
    expect(captured.apiKey).toBeUndefined(); expect(captured.googleKey).toBeUndefined();
    expect(captured.settings).toMatchObject({ security: { auth: { selectedType: 'oauth-personal' } }, tools: { core: ['__dev_cockpit_no_tools__'] }, hooksConfig: { enabled: false }, admin: { mcp: { enabled: false } } });
    expect(captured.cwd).not.toBe(dir); expect(fs.existsSync(captured.cwd)).toBe(false);
  });
  it('records an implementation session, streams messages, and resumes with the recorded ID', async () => {
    configure(); const agent = new GeminiCodeAgent(); const events: AgentStreamEvent[] = [];
    const result = await agent.startRun(agentInput(events));
    expect(result).toMatchObject({ ok: true, sessionId: 'gemini-session' });
    expect(events.some((event) => event.kind === 'session')).toBe(true);
    expect(events.some((event) => event.kind === 'text')).toBe(true);
    expect(fs.existsSync(result.rawLogPath!)).toBe(true);
    await agent.continueRun({ ...agentInput(events), sessionId: result.sessionId! });
    const captured = JSON.parse(fs.readFileSync(audit, 'utf8'));
    expect(captured.args).toContain('--resume'); expect(captured.args).toContain('gemini-session');
    expect(captured.args).toContain('yolo'); expect(captured.cwd).toBe(dir);
    expect(agent.getStatus('gemini-iteration').running).toBe(false);
  });
  it('fails on model errors even if the CLI exits zero, and rejects malformed reports', async () => {
    configure(); vi.stubEnv('TEST_GEMINI_MODE', 'fail');
    expect(await query()).toMatchObject({ ok: false });
    vi.stubEnv('TEST_GEMINI_MODE', 'invalid');
    expect(await query()).toMatchObject({ ok: false, error: 'Gemini CLI returned invalid JSON' });
  });
  it('cancels and times out the process tree', async () => {
    configure(); vi.stubEnv('TEST_GEMINI_MODE', 'wait');
    const controller = new AbortController();
    const running = query(controller.signal);
    setTimeout(() => controller.abort(), 300);
    expect(await running).toMatchObject({ ok: false, error: 'Cancelled' });
    expect(await query(new AbortController().signal, 300)).toMatchObject({ ok: false, error: 'Gemini CLI timed out' });
  });
  it('does not turn restrictive permission modes into YOLO', () => {
    expect(geminiPermissionArgs('bypassPermissions')).toEqual(['--approval-mode', 'yolo']);
    expect(geminiPermissionArgs('plan')).toEqual(['--approval-mode', 'plan']);
    expect(geminiPermissionArgs('acceptEdits')).toEqual(['--approval-mode', 'auto_edit']);
    expect(geminiPermissionArgs('dontAsk')).toEqual(['--approval-mode', 'default']);
  });
});
