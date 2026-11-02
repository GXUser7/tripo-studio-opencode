import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

const bundle = new URL('../node_modules/tripo-studio-plugin/dist/server.mjs', import.meta.url);
const metadata = JSON.parse(readFileSync(new URL('../node_modules/tripo-studio-plugin/package.json', import.meta.url), 'utf8'));
const marker = 'function sessionCandidates(env2 = process.env) {';
if (metadata.version !== '0.3.13') throw new Error('Unsupported upstream version; review adapter before upgrading.');
const source = readFileSync(bundle, 'utf8');
if (source.split(marker).length !== 2) throw new Error('Upstream cookie-store guard no longer matches.');
// Disable upstream silent cookie-store recovery, without modifying npm-owned files.
registerHooks({
  load(url, context, nextLoad) {
    if (url !== bundle.href) return nextLoad(url, context);
    return { format: 'module', source: source.replace(marker, `${marker}\n  return []; // Dedicated-login adapter: never scan browser stores.`), shortCircuit: true };
  },
});
await import(bundle.href);
