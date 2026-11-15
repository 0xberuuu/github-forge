// server.ts — the HTTP front door: one Node http server that reads each request's body,
// checks the bearer token, routes to the four surfaces, and answers with a buffered body
// (so Content-Length is always set and keep-alive connections stay reusable).
//
// Auth: every route but GET /healthz requires `Authorization: Bearer <token>` naming the
// token in MAKEFUN_SHOP_TOKEN, exactly. A missing or wrong token is a JSON 401. When the
// process was started with no token at all (local development), auth is not enforced.
// Every reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { ForgeStore } from './store.ts';
import { jsonReply, messageReply, type Ctx, type Reply } from './types.ts';

/** The largest request body accepted: packs in this contest stay far below it. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ForgeServerOptions {
  readonly store: ForgeStore;
  /** The bearer token requests must carry; '' disables enforcement (local development). */
  readonly token: string;
}

function decodeSegments(pathname: string): string {
  if (!pathname.includes('%')) return pathname;
  const segments = pathname.split('/');
  const decoded: string[] = [];
  for (const segment of segments) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      decoded.push(segment);
    }
  }
  return decoded.join('/');
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks, total));
    });
    req.on('error', (err) => {
      if (!rejected) {
        rejected = true;
        reject(err);
      }
    });
  });
}

export function createForgeServer(options: ForgeServerOptions): Server {
  const { store, token } = options;
  let requestCounter = 0;

  const route = (ctx: Ctx): Reply => {
    const { method, pathname } = ctx;

    if (method === 'GET' && pathname === '/healthz') {
      return jsonReply(200, { ok: true });
    }

    const isRest = pathname === '/api/v3' || pathname.startsWith('/api/v3/');
    const isGraphQL = pathname === '/api/graphql';
    const isMcp = pathname === '/mcp';
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
    if (!isRest && !isGraphQL && !isMcp && gitMatch === null) {
      return messageReply(404, 'Not Found');
    }

    // Auth for every known surface but the health probe.
    if (token !== '') {
      const presented = ctx.headers.authorization ?? '';
      if (presented !== `Bearer ${token}`) {
        return messageReply(401, 'Bad credentials');
      }
    }

    if (isRest) return handleRest(ctx);
    if (isGraphQL) return handleGraphQL(ctx);
    if (isMcp) return handleMcp(ctx);
    return handleGit(ctx, gitMatch![1]!, gitMatch![2]!, gitMatch![3] ?? '');
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    const requestId = `gh-${requestCounter.toString(16).padStart(8, '0')}`;
    const send = (reply: Reply): void => {
      if (res.writableEnded) return;
      const headers: Record<string, string> = {
        'x-github-request-id': requestId,
        'content-length': String(reply.body.length),
        ...reply.headers,
      };
      // A 204 carries no body and no content-type; keep the header set minimal there.
      if (reply.status === 204) {
        delete headers['content-type'];
        headers['content-length'] = '0';
      }
      res.writeHead(reply.status, headers);
      res.end(reply.body);
    };
    void (async () => {
      try {
        let url: URL;
        try {
          url = new URL(req.url ?? '/', 'http://forge');
        } catch {
          send(messageReply(400, 'Bad Request'));
          return;
        }
        const pathname = decodeSegments(url.pathname);
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }
        // Requests that declare no body (GETs, advertisements) skip the stream read
        // entirely: the body is empty by construction, and waiting on the stream costs
        // event-loop turns on every call of a 2,000-read benchmark.
        const contentLength = req.headers['content-length'];
        const declaredLength =
          typeof contentLength === 'string' ? Number.parseInt(contentLength, 10) : Number.NaN;
        const hasBody =
          req.headers['transfer-encoding'] !== undefined ||
          (typeof contentLength === 'string' ? !(Number.isFinite(declaredLength) && declaredLength <= 0) : contentLength !== undefined);
        let body: Buffer;
        if (!hasBody) {
          body = Buffer.alloc(0);
        } else {
          try {
            body = await readBody(req);
          } catch {
            send(messageReply(413, 'Request body too large'));
            return;
          }
        }
        const ctx: Ctx = {
          method: req.method ?? 'GET',
          pathname,
          query: url.searchParams,
          headers,
          host: req.headers.host ?? '127.0.0.1',
          body,
          requestId,
          store,
        };
        let reply: Reply;
        try {
          reply = route(ctx);
        } catch {
          reply = messageReply(500, 'Internal Server Error');
        }
        send(reply);
      } catch {
        if (!res.writableEnded) {
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
            res.end('{"message":"Internal Server Error"}\n');
          } catch {
            // The socket is gone; nothing left to answer.
          }
        }
      }
    })();
  });

  return server;
}
