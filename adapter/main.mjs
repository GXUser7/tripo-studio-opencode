import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { LoginProxy } from './proxy.mjs';
import { browserLogin, integrationPaths, protectDirectory } from './browser-login.mjs';

try {
  const paths = integrationPaths();
  await protectDirectory(paths.data);
  const env = { ...process.env, TRIPO_PLUGIN_DATA_DIR: paths.data };
  delete env.TRIPO_BROWSER_PROFILE_DIR;
  delete env.DEBUG;
  delete env.PWDEBUG;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./upstream.mjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // Never forward upstream diagnostics: they may contain request arguments.
  child.stderr.resume();
  const proxy = new LoginProxy({
    upstream: msg => { child.stdin.write(`${JSON.stringify(msg)}\n`); },
    client: msg => { process.stdout.write(`${JSON.stringify(msg)}\n`); },
    login: opts => browserLogin({ ...opts, profile: paths.profile }),
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    proxy.close();
    input.close();
    child.kill();
    const timer = setTimeout(() => process.exit(0), 5000);
    timer.unref();
  };
  input.on('line', line => {
    try { void proxy.fromClient(JSON.parse(line)).catch(stop); } catch { stop(); }
  });
  output.on('line', line => {
    try { proxy.fromUpstream(JSON.parse(line)); } catch { stop(); }
  });
  input.on('close', stop);
  child.on('exit', stop);
  child.on('error', stop);
  child.stdin.on('error', stop);
  process.stdout.on('error', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch {
  process.stderr.write('Tripo dedicated-login adapter could not start safely. Check Node >=24, dependencies, and local directory permissions.\n');
  process.exitCode = 1;
}
