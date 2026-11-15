// types.ts — the small shapes every surface handler shares: one parsed request in, one
// fully-buffered reply out. Handlers are synchronous once the body is read, which keeps the
// in-memory store's mutations atomic under Node's event loop.

import type { ForgeStore } from './store.ts';

export interface Ctx {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | undefined>;
  /** The request's Host header, for building same-origin pagination links. */
  readonly host: string;
  readonly body: Buffer;
  readonly requestId: string;
  readonly store: ForgeStore;
}

export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export function jsonReply(status: number, value: unknown, extraHeaders: Readonly<Record<string, string>> = {}): Reply {
  const text = `${JSON.stringify(value)}\n`;
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: Buffer.from(text, 'utf8'),
  };
}

export function messageReply(status: number, message: string, extraHeaders: Readonly<Record<string, string>> = {}): Reply {
  return jsonReply(status, { message }, extraHeaders);
}
