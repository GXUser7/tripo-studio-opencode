import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LoginProxy } from './proxy.mjs';
import { browserLogin, sessionCookie } from './browser-login.mjs';

function harness(login = async () => {}) {
  const upstream = [], client = [];
  const proxy = new LoginProxy({ upstream: m => upstream.push(m), client: m => client.push(m), login });
  return { proxy, upstream, client };
}
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const cookie = (extra = {}) => ({ name: 'ory_kratos_session', value: 'fake-test-session', secure: true, domain: '.tripo3d.ai', expires: -1, ...extra });

test('initialize, notifications, reverse requests and concurrent ID correlation', async () => {
  const { proxy, upstream, client } = harness();
  const a = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } };
  await proxy.fromClient(a);
  await proxy.fromClient(call('second', 'tripo_auth_status'));
  assert.notEqual(upstream[0].id, a.id);
  proxy.fromUpstream({ jsonrpc: '2.0', id: upstream[1].id, result: { status: true } });
  proxy.fromUpstream({ jsonrpc: '2.0', id: upstream[0].id, result: { capabilities: {} } });
  assert.deepEqual(client.map(x => x.id), ['second', 1]);
  const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };
  await proxy.fromClient(notification);
  assert.deepEqual(upstream.at(-1), notification);
  const reverse = { jsonrpc: '2.0', id: 'server-id', method: 'ping' };
  proxy.fromUpstream(reverse);
  assert.deepEqual(client.at(-1), reverse);
  const response = { jsonrpc: '2.0', id: 'server-id', result: {} };
  await proxy.fromClient(response);
  assert.deepEqual(upstream.at(-1), response);
  proxy.close();
});

test('only explicit login launches browser; internal credentials/results never reach client', async () => {
  let launches = 0;
  const h = harness(async ({ importCookie }) => { launches++; assert.equal(await importCookie('fake-test-secret'), true); });
  await h.proxy.fromClient(call(1, 'tripo_auth_status'));
  assert.equal(launches, 0);
  const pending = h.proxy.fromClient(call(2, 'tripo_auth_login'));
  const internal = h.upstream.at(-1);
  assert.equal(internal.params.name, 'tripo_auth_import');
  assert.equal(internal.params.arguments.session_cookie, 'fake-test-secret');
  h.proxy.fromUpstream({ jsonrpc: '2.0', id: internal.id, result: { content: [{ type: 'text', text: 'fake-test-secret' }] } });
  await pending;
  assert.equal(launches, 1);
  assert.equal(h.client.at(-1).id, 2);
  assert.ok(!JSON.stringify(h.client).includes('fake-test-secret'));
  h.proxy.close();
});

test('headless login rejected, concurrent login rejected, cancellation closes active operation', async () => {
  let launches = 0;
  const h = harness(({ signal }) => { launches++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('fake secret')), { once: true })); });
  await h.proxy.fromClient(call(0, 'tripo_auth_login', { headless_only: true }));
  assert.equal(launches, 0);
  const pending = h.proxy.fromClient(call('login', 'tripo_auth_login'));
  await h.proxy.fromClient(call(3, 'tripo_auth_login'));
  assert.equal(launches, 1);
  assert.equal(h.client.at(-1).result.isError, true);
  await h.proxy.fromClient({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'login' } });
  await pending;
  assert.ok(!JSON.stringify(h.client).includes('fake secret'));
  h.proxy.close();
});

test('forwarded cancellation translates original IDs', async () => {
  const h = harness();
  await h.proxy.fromClient(call(42, 'tripo_auth_status'));
  const translated = h.upstream[0].id;
  await h.proxy.fromClient({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } });
  assert.equal(h.upstream.at(-1).params.requestId, translated);
  h.proxy.close();
});

test('domain, security, lifetime and value allowlist', () => {
  assert.equal(sessionCookie([cookie()]), 'fake-test-session');
  for (const extra of [{ domain: 'eviltripo3d.ai' }, { domain: '.tripo3d.ai.evil.test' }, { domain: 'unlisted.tripo3d.ai' }, { secure: false }, { expires: 1 }, { value: 'bad;cookie-value' }, { name: 'another_cookie' }]) {
    assert.equal(sessionCookie([cookie(extra)]), undefined);
  }
});

function fakeContext(cookies = [cookie()]) {
  const context = new EventEmitter();
  context.closeCount = 0;
  context.pages = () => [{ goto: async url => { assert.equal(url, 'https://studio.tripo3d.ai/'); } }];
  context.cookies = async urls => { assert.deepEqual(urls, ['https://studio.tripo3d.ai/', 'https://auth.tripo3d.ai/']); return cookies; };
  context.close = async () => { context.closeCount++; context.emit('close'); };
  return context;
}

test('fake dedicated browser closes after success and imports only allowed cookie', async () => {
  const context = fakeContext();
  let imports = 0;
  await browserLogin({ profile: 'dedicated', protect: async () => {}, launch: async dir => { assert.equal(dir, 'dedicated'); return context; }, importCookie: async value => { imports++; assert.equal(value, 'fake-test-session'); return true; }, timeoutMs: 1000 });
  assert.equal(imports, 1);
  assert.equal(context.closeCount, 1);
});

test('fake browser closes on timeout, cancellation, navigation failure and delayed launch', async () => {
  for (const mode of ['timeout', 'cancel', 'navigation', 'delayed']) {
    const context = fakeContext([]);
    const controller = new AbortController();
    if (mode === 'navigation') context.pages = () => [{ goto: async () => { throw new Error('private browser error'); } }];
    const pending = browserLogin({ profile: 'dedicated', protect: async () => {}, launch: async () => { if (mode === 'delayed') await new Promise(r => setTimeout(r, 20)); return context; }, importCookie: async () => assert.fail('must not import'), signal: controller.signal, timeoutMs: 10, pollMs: 1 });
    if (mode === 'cancel') setTimeout(() => controller.abort(), 2);
    await assert.rejects(pending);
    assert.equal(context.closeCount, 1);
  }
});

test('real guarded upstream initializes and status works without launching browser', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./upstream.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const { createInterface } = await import('node:readline');
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  const receive = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upstream timeout')), 20000);
    lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)); });
  });
  try {
    let pending = receive();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'adapter-test', version: '1.0' } } }) + '\n');
    const init = await pending;
    assert.equal(init.id, 1);
    assert.ok(init.result.capabilities);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    pending = receive();
    child.stdin.write(JSON.stringify(call(2, 'tripo_auth_status')) + '\n');
    const status = await pending;
    assert.equal(status.id, 2);
    assert.equal(status.result.isError, undefined);
  } finally { lines.close(); child.kill(); }
});
