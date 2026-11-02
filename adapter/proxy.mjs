import { randomUUID } from 'node:crypto';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const result = (id, text, isError = false) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } });
export class LoginProxy {
  constructor({ upstream, client, login }) {
    this.upstream = upstream;
    this.client = client;
    this.login = login;
    this.prefix = `adapter-${randomUUID()}-`;
    this.sequence = 0;
    this.requests = new Map();
    this.internal = new Map();
    this.active = null;
    this.closed = false;
  }
  async fromClient(message) {
    if (this.closed) return;
    const request = own(message, 'id') && typeof message.method === 'string';
    if (message.method === 'notifications/cancelled') {
      if (this.active?.id === message.params?.requestId) this.active.controller.abort();
      for (const [id, original] of this.requests) {
        if (original === message.params?.requestId) {
          this.upstream({ ...message, params: { ...message.params, requestId: id } });
          return;
        }
      }
      return;
    }
    if (message.method === 'tools/call' && message.params?.name === 'tripo_auth_login') {
      if (!request) return;
      if (message.params.arguments?.headless_only) {
        this.client(result(message.id, 'Dedicated browser login requires explicit interactive sign-in; headless_only is not supported.', true));
        return;
      }
      if (this.active) {
        this.client(result(message.id, 'A dedicated browser login is already in progress.', true));
        return;
      }
      const active = { id: message.id, controller: new AbortController() };
      this.active = active;
      try {
        await this.login({ signal: active.controller.signal, importCookie: async cookie => {
          if (active.controller.signal.aborted || this.closed) return false;
          const response = await this.callInternal('tripo_auth_import', { session_cookie: cookie }, active.controller.signal);
          return Boolean(response.result && !response.result.isError && !response.error);
        } });
        if (!active.controller.signal.aborted && !this.closed) this.client(result(message.id, 'Tripo Studio login completed in the dedicated browser; the session was validated and stored locally.'));
        else if (!this.closed) this.client(result(message.id, 'Dedicated browser login cancelled.', true));
      } catch {
        if (!this.closed) this.client(result(message.id, 'Dedicated browser login failed, was cancelled, or timed out. Close any integration browser window and retry tripo_auth_login. Microsoft Edge must be installed. No browser-store fallback was used.', true));
      } finally {
        if (this.active === active) this.active = null;
      }
      return;
    }
    if (request) {
      const id = `${this.prefix}${++this.sequence}`;
      this.requests.set(id, message.id);
      this.upstream({ ...message, id });
    } else this.upstream(message);
  }
  fromUpstream(message) {
    if (this.closed) return;
    if (own(message, 'id') && !message.method) {
      const internal = this.internal.get(message.id);
      if (internal) { internal(message); return; }
      if (this.requests.has(message.id)) {
        const id = this.requests.get(message.id);
        this.requests.delete(message.id);
        this.client({ ...message, id });
      }
      // Late internal replies must never enter the client stream.
      return;
    }
    this.client(message);
  }
  callInternal(name, args, signal) {
    if (this.closed || signal.aborted) return Promise.reject(new Error('Cancelled.'));
    const id = `${this.prefix}private-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const finish = response => { cleanup(); resolve(response); };
      const abort = () => { cleanup(); reject(new Error('Cancelled.')); };
      const cleanup = () => { clearTimeout(timer); this.internal.delete(id); signal.removeEventListener('abort', abort); };
      const timer = setTimeout(abort, 45000);
      this.internal.set(id, finish);
      signal.addEventListener('abort', abort, { once: true });
      this.upstream({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    });
  }
  close() {
    this.closed = true;
    this.active?.controller.abort();
    for (const finish of [...this.internal.values()]) finish({ error: { code: -32000, message: 'Upstream closed.' } });
    this.requests.clear();
  }
}
