import { mkdir, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
export const studioURLs = ['https://studio.tripo3d.ai/', 'https://auth.tripo3d.ai/'];
const domains = new Set(['tripo3d.ai', 'studio.tripo3d.ai', 'auth.tripo3d.ai']);
export function sessionCookie(cookies) {
  return cookies.find(c => c.name === 'ory_kratos_session' && domains.has(c.domain.replace(/^\./, '')) && c.secure && c.value.length >= 10 && c.value.length <= 8192 && !/[;\r\n]/.test(c.value) && (c.expires === -1 || c.expires * 1000 > Date.now() + 60000))?.value;
}
export async function protectDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe integration directory.');
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true });
    const sid = stdout.trim();
    if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('Cannot resolve Windows identity.');
    await exec('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true });
  }
}
export function integrationPaths(env = process.env) {
  if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required.');
  const root = path.join(env.LOCALAPPDATA, 'TripoStudioPlugin');
  return { profile: path.join(root, 'opencode-browser'), data: path.join(root, 'opencode-session') };
}
export async function browserLogin({ profile, importCookie, signal, launch, timeoutMs = 600000, pollMs = 1500, protect = protectDirectory }) {
  let context;
  let closed = false;
  let closePromise;
  const close = () => {
    closed = true;
    if (context) closePromise ??= context.close().catch(() => {});
    return closePromise;
  };
  const timer = setTimeout(close, timeoutMs);
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    await protect(profile);
    if (!launch) {
      const { chromium } = await import('playwright-core');
      const env = { ...process.env };
      delete env.DEBUG;
      delete env.PWDEBUG;
      launch = (dir) => chromium.launchPersistentContext(dir, { channel: 'msedge', headless: false, timeout: 30000, acceptDownloads: false, env });
    }
    context = await launch(profile);
    if (closed || signal?.aborted) throw new Error('Login cancelled.');
    context.on('close', () => { closed = true; });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(studioURLs[0], { waitUntil: 'domcontentloaded', timeout: 45000 });
    const rejected = new Set();
    while (!closed && !signal?.aborted) {
      const cookie = sessionCookie(await context.cookies(studioURLs));
      if (cookie && !rejected.has(cookie)) {
        rejected.add(cookie);
        const accepted = await importCookie(cookie);
        if (closed || signal?.aborted) throw new Error('Login cancelled or timed out.');
        if (accepted) return;
      }
      await delay(pollMs, undefined, { signal });
    }
    throw new Error('Login cancelled or timed out.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await close();
  }
}
