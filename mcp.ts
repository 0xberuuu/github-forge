// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable
// HTTP, answered with one JSON body per POST (no SSE stream, no session).
//
// Both protocol eras are served: the modern 2026-07-28 era (server/discover with
// supportedVersions, every request declaring its revision in _meta) and the legacy
// handshake era (initialize + notifications/initialized). Six tools, the
// github-mcp-server names, acting on the same store REST and GraphQL use: a repository
// or issue created here reads back over REST with the same ids.

import { VIEWER_LOGIN, type ForgeStore, type PullRecord, type RepoRecord } from './store.ts';
import { jsonReply, type Ctx, type Reply } from './types.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, Record<string, unknown>>;
  readonly required: string[];
}

/**
 * The tool list, fixed and built once: two tools/list calls answer byte-identical arrays.
 * `required` holds only properties the caller can always fill, and the property names are
 * the canonical github-mcp-server spellings the suite maps its arguments onto.
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
]);

function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

function rpcResult(id: unknown, result: unknown): Reply {
  return jsonReply(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): Reply {
  return jsonReply(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

// -------------------------------------------------------------------------------------------
// tool implementations (shared shapes with REST, built here to keep this module standalone)
// -------------------------------------------------------------------------------------------

function repoView(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function issueView(repo: RepoRecord, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullView(store: ForgeStore, repo: RepoRecord, pr: PullRecord): Record<string, unknown> {
  const tips = store.pullTips(repo, pr);
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    head: { ref: pr.headRef, sha: tips.headSha },
    base: { ref: pr.baseRef, sha: tips.baseSha },
    user: { login: VIEWER_LOGIN },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; invalidParams: true; message: string }
  | { ok: false; invalidParams: false; message: string };

function needString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function needRepo(store: ForgeStore, args: Record<string, unknown>): RepoRecord | null {
  const owner = needString(args, 'owner');
  const repoName = needString(args, 'repo') ?? needString(args, 'name');
  if (owner === null || repoName === null) return null;
  // A full_name argument (owner/repo) fills in when owner/repo are absent.
  if (owner !== VIEWER_LOGIN) {
    const fullName = typeof args.full_name === 'string' ? args.full_name : '';
    const parts = fullName.split('/');
    if (parts.length === 2 && parts[0] === VIEWER_LOGIN) {
      return store.getRepo(VIEWER_LOGIN, parts[1]!) ?? null;
    }
    return null;
  }
  return store.getRepo(owner, repoName) ?? null;
}

function runTool(store: ForgeStore, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = needString(args, 'name');
      if (repoName === null) return { ok: false, invalidParams: true, message: 'name is required' };
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return { ok: false, invalidParams: false, message: 'Repository already exists' };
      }
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
      return { ok: true, value: repoView(repo) };
    }
    case 'get_repo': {
      const repo = needRepo(store, args);
      if (repo === null) return { ok: false, invalidParams: false, message: 'Not Found' };
      return { ok: true, value: repoView(repo) };
    }
    case 'create_issue': {
      const repo = needRepo(store, args);
      const title = needString(args, 'title');
      if (repo === null || title === null) {
        return { ok: false, invalidParams: true, message: 'owner, repo and title are required' };
      }
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return { ok: true, value: issueView(repo, issue) };
    }
    case 'list_issues': {
      const repo = needRepo(store, args);
      if (repo === null) return { ok: false, invalidParams: true, message: 'owner and repo are required' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.createdSeq - b.createdSeq);
      return { ok: true, value: issues.map((issue) => issueView(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = needRepo(store, args);
      const title = needString(args, 'title');
      const head = needString(args, 'head');
      const base = needString(args, 'base');
      if (repo === null || title === null || head === null || base === null) {
        return { ok: false, invalidParams: true, message: 'owner, repo, title, head and base are required' };
      }
      const headShort = head.includes(':') ? head.slice(head.lastIndexOf(':') + 1) : head;
      const baseShort = base.includes(':') ? base.slice(base.lastIndexOf(':') + 1) : base;
      if (repo.refs.get(`refs/heads/${headShort}`) === undefined) {
        return { ok: false, invalidParams: false, message: 'head branch does not exist' };
      }
      if (repo.refs.get(`refs/heads/${baseShort}`) === undefined) {
        return { ok: false, invalidParams: false, message: 'base branch does not exist' };
      }
      const body = typeof args.body === 'string' ? args.body : '';
      const pr = store.createPull(repo, title, body, headShort, baseShort);
      return { ok: true, value: pullView(store, repo, pr) };
    }
    case 'merge_pull_request': {
      const repo = needRepo(store, args);
      const rawNumber = args.pull_number ?? args.number;
      const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number.parseInt(rawNumber, 10) : NaN;
      if (repo === null || !Number.isSafeInteger(number)) {
        return { ok: false, invalidParams: true, message: 'owner, repo and pull_number are required' };
      }
      const pr = repo.pulls.get(number);
      if (pr === undefined) return { ok: false, invalidParams: false, message: 'Not Found' };
      if (pr.merged) return { ok: false, invalidParams: false, message: 'Pull request is already merged' };
      if (pr.state !== 'open') return { ok: false, invalidParams: false, message: 'Pull request is closed' };
      const result = store.mergePullRequest(repo, pr, 'squash', pr.title);
      if ('conflict' in result) {
        return { ok: false, invalidParams: false, message: `Merge conflict in ${result.conflict}` };
      }
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = store.clock.nextIso();
      pr.mergeCommitSha = result.sha;
      pr.updatedAt = store.clock.nextIso();
      return { ok: true, value: { sha: result.sha, merged: true, number: pr.number, state: 'closed', message: 'Pull Request successfully merged' } };
    }
    default:
      return { ok: false, invalidParams: true, message: `unknown tool ${name}` };
  }
}

// -------------------------------------------------------------------------------------------
// HTTP entry point
// -------------------------------------------------------------------------------------------

export function handleMcp(ctx: Ctx): Reply {
  if (ctx.method !== 'POST') {
    return jsonReply(405, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Method not allowed' } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return rpcError(null, PARSE_ERROR, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, INVALID_REQUEST, 'Invalid Request', 400);
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id;
  const hasId = id !== undefined && id !== null;
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    if (!hasId) return { status: 202, headers: {}, body: Buffer.alloc(0) };
    return rpcError(id, INVALID_REQUEST, 'Invalid Request');
  }
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};

  // Notifications (no id) are acknowledged and never answered with a result.
  if (!hasId) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : MODERN_REVISION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, toolsListResult());
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
      if (toolName === '') return rpcError(id, INVALID_PARAMS, 'tool name is required');
      const known = TOOLS.some((tool) => tool.name === toolName);
      if (!known) return rpcError(id, INVALID_PARAMS, `unknown tool ${toolName}`);
      const outcome = runTool(ctx.store, toolName, args);
      if (!outcome.ok) {
        if (outcome.invalidParams) return rpcError(id, INVALID_PARAMS, outcome.message);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: outcome.message }) }],
          structuredContent: { error: outcome.message },
          isError: true,
        });
      }
      const text = JSON.stringify(outcome.value);
      return rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.value,
      });
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}
