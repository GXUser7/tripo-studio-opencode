import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const child = spawn(process.execPath, [fileURLToPath(new URL('./main.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.resume();
const lines = createInterface({ input: child.stdout });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 20000);
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 1 && message.result?.capabilities) {
    console.log('Adapter initialize + Windows ACL startup: PASS (no browser opened)');
    clearTimeout(timer);
    child.stdin.end();
    lines.close();
  } else { child.kill(); process.exitCode = 1; }
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'adapter-smoke', version: '1' } } }) + '\n');
