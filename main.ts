// main.ts — the entry <-> env lifecycle: bind an ephemeral port, register it with the
// env, serve the forge until the env says the trial is over, then exit 0.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to talk to.
//   2. The server listens on port 0: the kernel picks a free port. Never 8080.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. First register wins; 409 means another
//      entry already registered, and this process waits like any other.
//   4. GET $MAKEFUN_ENV_URL/done until {"done": true}. The env answers at once, so this
//      is a poll with backoff, never a held-open request.
//   5. Close the server and exit 0.

import { createForgeServer } from './server.ts';
import { ForgeStore } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW;

if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200) or reports a first register (409). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const store = new ForgeStore(TRIAL_NOW);
  const server = createForgeServer({ store, token: TOKEN });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server bound no TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  await register(port);
  process.stderr.write(`[forge] listening on port ${port}, registered with the env\n`);
  await waitForDone();
  process.stderr.write('[forge] the env reports done; shutting down\n');
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`[forge] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
