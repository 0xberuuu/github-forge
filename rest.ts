// rest.ts — GitHub REST v3 under /api/v3: repositories, branches, commits, contents,
// refs, labels, issues, comments and pull requests with their files and merges.
//
// Every reply is JSON and carries X-GitHub-Request-Id (the server adds it); every error
// body carries a string message; an unknown route is a JSON 404; a malformed JSON body is
// a 400; a repository under any owner but the token's is a 404, never a 403.

import { isObjectId, parseCommit, parseTree, peelToCommit } from './gitproto.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type ForgeStore,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';
import { jsonReply, messageReply, type Ctx, type Reply } from './types.ts';

const SCOPES_HEADER = { 'x-oauth-scopes': 'repo, read:org' };

// -------------------------------------------------------------------------------------------
// shapes
// -------------------------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' };
}

function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    fork: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelJson(repo: RepoRecord, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: '' };
}

function issueJson(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(issue.userLogin),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: ForgeStore, repo: RepoRecord, pr: PullRecord): Record<string, unknown> {
  const tips = store.pullTips(repo, pr);
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.state === 'open' ? store.pullMergeable(repo, pr) === 'MERGEABLE' : false,
    head: { ref: pr.headRef, sha: tips.headSha, label: `${repo.owner}:${pr.headRef}`, user: userJson(repo.owner), repo: repoJson(repo) },
    base: { ref: pr.baseRef, sha: tips.baseSha, label: `${repo.owner}:${pr.baseRef}`, user: userJson(repo.owner), repo: repoJson(repo) },
    user: userJson(pr.userLogin),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    comments: pr.comments.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commentJson(repo: RepoRecord, number: number, comment: { id: number; body: string; userLogin: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments/${comment.id}`,
  };
}

// -------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------

type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; reply: Reply };

function parseBody(ctx: Ctx): BodyResult {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: true, value: {} };
  } catch {
    return { ok: false, reply: messageReply(400, 'Problems parsing JSON') };
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function boolField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Slice a list into a page and build the Link header GitHub sends. */
function paginate<T>(ctx: Ctx, items: readonly T[]): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, intParam(ctx.query, 'per_page', 30)));
  const page = Math.max(1, intParam(ctx.query, 'page', 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const pageUrl = (n: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(n));
    params.set('per_page', String(perPage));
    return `http://${ctx.host}${ctx.pathname}?${params.toString()}`;
  };
  if (page < totalPages) {
    links.push(`<${pageUrl(page + 1)}>; rel="next"`, `<${pageUrl(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${pageUrl(1)}>; rel="first"`, `<${pageUrl(page - 1)}>; rel="prev"`);
  }
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

function pagedReply(ctx: Ctx, items: readonly unknown[]): Reply {
  const { page, link } = paginate(ctx, items);
  return jsonReply(200, page, link !== null ? { link } : {});
}

function repoOf(ctx: Ctx, owner: string, name: string): RepoRecord | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return ctx.store.getRepo(owner, name);
}

function missingRepo(): Reply {
  return messageReply(404, 'Not Found');
}

function shortBranch(ref: string): string {
  const colon = ref.lastIndexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

// -------------------------------------------------------------------------------------------
// router
// -------------------------------------------------------------------------------------------

export function handleRest(ctx: Ctx): Reply {
  const path = ctx.pathname === '/api/v3' ? '/api/v3/' : ctx.pathname;
  const segments = path
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((segment) => segment !== '');
  const method = ctx.method;

  try {
    if (segments.length === 0) {
      if (method === 'GET') {
        return jsonReply(
          200,
          { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' },
          SCOPES_HEADER,
        );
      }
      return messageReply(404, 'Not Found');
    }

    if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
      return jsonReply(200, { installed_version: '1.0.0' });
    }

    if (segments[0] === 'user') {
      if (segments.length === 1 && method === 'GET') {
        return jsonReply(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
      }
      if (segments.length === 2 && segments[1] === 'repos') {
        if (method === 'GET') return listUserRepos(ctx);
        if (method === 'POST') return createUserRepo(ctx);
      }
      return messageReply(404, 'Not Found');
    }

    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1]!;
      const name = segments[2]!;
      const rest = segments.slice(3);
      return handleRepoRoute(ctx, owner, name, rest);
    }

    return messageReply(404, 'Not Found');
  } catch {
    return messageReply(400, 'Bad Request');
  }
}

function listUserRepos(ctx: Ctx): Reply {
  const repos = ctx.store.listRepos(VIEWER_LOGIN).map(repoJson);
  return pagedReply(ctx, repos);
}

function createUserRepo(ctx: Ctx): Reply {
  const body = parseBody(ctx);
  if (!body.ok) return body.reply;
  const name = stringField(body.value.name);
  if (name === undefined || name === '') return messageReply(422, 'name is required');
  if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
    return messageReply(422, 'Repository already exists');
  }
  const description = stringField(body.value.description) ?? '';
  const isPrivate = boolField(body.value.private) ?? false;
  const repo = ctx.store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
  return jsonReply(201, repoJson(repo));
}

// -------------------------------------------------------------------------------------------
// /repos/{owner}/{name}/...
// -------------------------------------------------------------------------------------------

function handleRepoRoute(ctx: Ctx, owner: string, name: string, rest: string[]): Reply {
  const method = ctx.method;
  const repo = repoOf(ctx, owner, name);

  if (rest.length === 0) {
    if (repo === undefined) return missingRepo();
    if (method === 'GET') return jsonReply(200, repoJson(repo));
    if (method === 'PATCH') {
      const body = parseBody(ctx);
      if (!body.ok) return body.reply;
      const description = stringField(body.value.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = boolField(body.value.private);
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      repo.updatedAt = ctx.store.clock.nextIso();
      return jsonReply(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    }
    return messageReply(404, 'Not Found');
  }

  if (repo === undefined) return missingRepo();
  const head = rest[0]!;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') return listBranches(ctx, repo);
    if (rest.length >= 2 && method === 'GET') return getBranch(ctx, repo, rest.slice(1).join('/'));
    return messageReply(404, 'Not Found');
  }
  if (head === 'commits' && rest.length === 1 && method === 'GET') return listCommits(ctx, repo);
  if (head === 'contents') return handleContents(ctx, repo, rest.slice(1));
  if (head === 'git' && rest[1] === 'refs') return handleGitRefs(ctx, repo, rest.slice(2));
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return jsonReply(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
    }
    if (method === 'POST' && rest.length === 1) return createLabel(ctx, repo);
    return messageReply(404, 'Not Found');
  }
  if (head === 'issues') return handleIssues(ctx, repo, rest.slice(1));
  if (head === 'pulls') return handlePulls(ctx, repo, rest.slice(1));

  return messageReply(404, 'Not Found');
}

function listBranches(ctx: Ctx, repo: RepoRecord): Reply {
  const branches: Array<Record<string, unknown>> = [];
  for (const { name, oid } of ctx.store.sortedRefs(repo)) {
    if (!name.startsWith('refs/heads/')) continue;
    const short = name.slice('refs/heads/'.length);
    const commit = peelToCommit(oid, ctx.store.lookup(repo)) ?? oid;
    branches.push({ name: short, commit: { sha: commit, url: '' }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return pagedReply(ctx, branches);
}

function getBranch(ctx: Ctx, repo: RepoRecord, branch: string): Reply {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return messageReply(404, 'Branch not found');
  const commit = peelToCommit(oid, ctx.store.lookup(repo)) ?? oid;
  return jsonReply(200, { name: branch, commit: { sha: commit, url: '' }, protected: false });
}

function listCommits(ctx: Ctx, repo: RepoRecord): Reply {
  const refish = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = ctx.store.resolveToCommit(repo, refish);
  if (tip === null) return jsonReply(200, []);
  const history = ctx.store.listHistory(repo, tip);
  const items: Array<Record<string, unknown>> = [];
  for (const oid of history) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    let message = '';
    let parents: string[] = [];
    let author = '';
    let committer = '';
    try {
      const commit = parseCommit(object.data);
      message = commit.message;
      parents = commit.parents;
      author = commit.author;
      committer = commit.committer;
    } catch {
      // A commit that does not parse still lists with its id.
    }
    items.push({
      sha: oid,
      commit: { message, author: { name: author, email: '', date: '' }, committer: { name: committer, email: '', date: '' } },
      parents: parents.map((sha) => ({ sha })),
      author: userJson(VIEWER_LOGIN),
    });
  }
  return pagedReply(ctx, items);
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

function handleContents(ctx: Ctx, repo: RepoRecord, segments: string[]): Reply {
  const path = segments.join('/');
  if (ctx.method === 'GET') return getContents(ctx, repo, path);
  if (ctx.method === 'PUT') return putContents(ctx, repo, path);
  if (ctx.method === 'DELETE') return deleteContents(ctx, repo, path);
  return messageReply(404, 'Not Found');
}

function contentsRefTip(ctx: Ctx, repo: RepoRecord): string | null {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  return ctx.store.resolveToCommit(repo, ref);
}

function getContents(ctx: Ctx, repo: RepoRecord, path: string): Reply {
  const tip = contentsRefTip(ctx, repo);
  if (tip === null) return messageReply(404, 'Not Found');
  const files = ctx.store.filesOfCommit(repo, tip);
  const direct = files.get(path);
  if (direct !== undefined) {
    const data = repo.objects.get(direct.oid)?.data ?? Buffer.alloc(0);
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: direct.oid,
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
    });
  }
  // A directory: walk the tree to it and list its immediate children with their own ids.
  const tipObject = repo.objects.get(tip);
  if (tipObject === undefined || tipObject.type !== 'commit') return messageReply(404, 'Not Found');
  let treeOid: string;
  try {
    treeOid = parseCommit(tipObject.data).tree;
  } catch {
    return messageReply(404, 'Not Found');
  }
  if (path !== '') {
    for (const segment of path.split('/')) {
      const treeObject = repo.objects.get(treeOid);
      if (treeObject === undefined || treeObject.type !== 'tree') return messageReply(404, 'Not Found');
      let found: string | undefined;
      try {
        for (const entry of parseTree(treeObject.data)) {
          if (entry.name === segment && entry.mode === '40000') found = entry.oid;
        }
      } catch {
        return messageReply(404, 'Not Found');
      }
      if (found === undefined) return messageReply(404, 'Not Found');
      treeOid = found;
    }
  }
  const treeObject = repo.objects.get(treeOid);
  if (treeObject === undefined || treeObject.type !== 'tree') return messageReply(404, 'Not Found');
  let entries;
  try {
    entries = parseTree(treeObject.data);
  } catch {
    return messageReply(404, 'Not Found');
  }
  const listed = entries.map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    if (entry.mode === '40000') {
      return { type: 'dir', name: entry.name, path: childPath, sha: entry.oid };
    }
    const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
    return { type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: data.length };
  });
  listed.sort((a, b) => (a.name < b.name ? -1 : 1));
  return jsonReply(200, listed);
}

function putContents(ctx: Ctx, repo: RepoRecord, path: string): Reply {
  const body = parseBody(ctx);
  if (!body.ok) return body.reply;
  if (path === '') return messageReply(422, 'path is required');
  const content = stringField(body.value.content);
  if (content === undefined) return messageReply(422, 'content is required');
  const message = stringField(body.value.message) ?? `Update ${path}`;
  const branch = stringField(body.value.branch) ?? repo.defaultBranch;
  const sha = stringField(body.value.sha);
  const bytes = Buffer.from(content, 'base64');

  const refName = `refs/heads/${branch}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined) {
    // A branch that does not exist is created from the default branch's tip (or unborn).
    tip = ctx.store.defaultTip(repo);
  }
  const parentCommit = tip === undefined ? null : peelToCommit(tip, ctx.store.lookup(repo));
  const files = parentCommit === null ? new Map() : ctx.store.filesOfCommit(repo, parentCommit);
  const existing = files.get(path);
  const isCreate = existing === undefined;
  if (!isCreate && sha !== undefined && sha !== '' && sha !== existing!.oid) {
    return messageReply(409, 'sha does not match the current file');
  }
  const blobOid = ctx.store.putObject(repo, 'blob', bytes);
  files.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
  const treeOid = ctx.store.buildTreeFromMap(repo, files);
  const parents = parentCommit === null ? [] : [parentCommit];
  const commitOid = ctx.store.createCommit(repo, treeOid, parents, message, VIEWER_NAME, VIEWER_EMAIL);
  repo.refs.set(refName, commitOid);
  repo.updatedAt = ctx.store.clock.nextIso();
  return jsonReply(isCreate ? 201 : 200, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, encoding: 'base64' },
    commit: { sha: commitOid, message },
  });
}

function deleteContents(ctx: Ctx, repo: RepoRecord, path: string): Reply {
  const body = parseBody(ctx);
  if (!body.ok) return body.reply;
  const message = stringField(body.value.message) ?? `Delete ${path}`;
  const branch = stringField(body.value.branch) ?? repo.defaultBranch;
  const sha = stringField(body.value.sha);
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (tip === undefined) return messageReply(404, 'Not Found');
  const parentCommit = peelToCommit(tip, ctx.store.lookup(repo));
  if (parentCommit === null) return messageReply(404, 'Not Found');
  const files = ctx.store.filesOfCommit(repo, parentCommit);
  const existing = files.get(path);
  if (existing === undefined) return messageReply(404, 'Not Found');
  if (sha !== undefined && sha !== '' && sha !== existing.oid) {
    return messageReply(409, 'sha does not match the current file');
  }
  files.delete(path);
  const treeOid = ctx.store.buildTreeFromMap(repo, files);
  const commitOid = ctx.store.createCommit(repo, treeOid, [parentCommit], message, VIEWER_NAME, VIEWER_EMAIL);
  repo.refs.set(refName, commitOid);
  repo.updatedAt = ctx.store.clock.nextIso();
  return jsonReply(200, { content: null, commit: { sha: commitOid, message } });
}

// -------------------------------------------------------------------------------------------
// git refs
// -------------------------------------------------------------------------------------------

function handleGitRefs(ctx: Ctx, repo: RepoRecord, rest: string[]): Reply {
  if (ctx.method === 'POST' && rest.length === 0) {
    const body = parseBody(ctx);
    if (!body.ok) return body.reply;
    const ref = stringField(body.value.ref);
    const sha = stringField(body.value.sha);
    if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !isObjectId(sha)) {
      return messageReply(422, 'ref and sha are required');
    }
    const object = repo.objects.get(sha);
    if (!object) return messageReply(422, 'sha does not exist');
    if (repo.refs.has(ref)) return messageReply(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return jsonReply(201, { ref, object: { sha, type: object.type, url: '' } });
  }
  if (ctx.method === 'GET') {
    // The URL omits the leading "refs/": /git/refs/heads/x names refs/heads/x.
    const wanted = rest.length === 0 ? '' : `refs/${rest.join('/')}`;
    if (wanted === '') {
      const all = ctx.store.sortedRefs(repo).map(({ name, oid }) => ({
        ref: name,
        object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' },
      }));
      return jsonReply(200, all);
    }
    const exact = repo.refs.get(wanted);
    if (exact !== undefined) {
      return jsonReply(200, { ref: wanted, object: { sha: exact, type: repo.objects.get(exact)?.type ?? 'commit', url: '' } });
    }
    const prefix = `${wanted}/`;
    const matches = ctx.store
      .sortedRefs(repo)
      .filter(({ name }) => name.startsWith(prefix))
      .map(({ name, oid }) => ({ ref: name, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' } }));
    if (matches.length === 0) return messageReply(404, 'Not Found');
    return jsonReply(200, matches);
  }
  if (ctx.method === 'DELETE' && rest.length > 0) {
    const wanted = `refs/${rest.join('/')}`;
    if (!repo.refs.has(wanted)) return messageReply(404, 'Not Found');
    repo.refs.delete(wanted);
    return { status: 204, headers: {}, body: Buffer.alloc(0) };
  }
  return messageReply(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// labels
// -------------------------------------------------------------------------------------------

function createLabel(ctx: Ctx, repo: RepoRecord): Reply {
  const body = parseBody(ctx);
  if (!body.ok) return body.reply;
  const name = stringField(body.value.name);
  if (name === undefined || name === '') return messageReply(422, 'name is required');
  if (repo.labels.has(name)) return messageReply(422, 'Label already exists');
  const color = stringField(body.value.color) ?? 'ededed';
  repo.labels.set(name, { name, color });
  return jsonReply(201, { name, color, description: '' });
}

// -------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------

function issueOrPullAsIssue(ctx: Ctx, repo: RepoRecord, number: number): Reply {
  const issue = repo.issues.get(number);
  if (issue !== undefined) return jsonReply(200, issueJson(repo, issue));
  const pr = repo.pulls.get(number);
  if (pr !== undefined) {
    const view = {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      labels: [],
      user: userJson(pr.userLogin),
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      comments: pr.comments.length,
      pull_request: {},
    };
    return jsonReply(200, view);
  }
  return messageReply(404, 'Not Found');
}

function handleIssues(ctx: Ctx, repo: RepoRecord, rest: string[]): Reply {
  const method = ctx.method;
  if (rest.length === 0) {
    if (method === 'POST') return createIssue(ctx, repo);
    if (method === 'GET') return listIssues(ctx, repo);
    return messageReply(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isSafeInteger(number) || String(number) !== rest[0]) return messageReply(404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') return issueOrPullAsIssue(ctx, repo, number);
    if (method === 'PATCH') return patchIssue(ctx, repo, number);
    return messageReply(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      const target = repo.issues.get(number) ?? repo.pulls.get(number);
      if (target === undefined) return messageReply(404, 'Not Found');
      return pagedReply(ctx, target.comments.map((comment) => commentJson(repo, number, comment)));
    }
    if (method === 'POST') {
      const body = parseBody(ctx);
      if (!body.ok) return body.reply;
      const text = stringField(body.value.body);
      if (text === undefined || text === '') return messageReply(422, 'body is required');
      const comment = ctx.store.addComment(repo, number, text);
      if (comment === null) return messageReply(404, 'Not Found');
      return jsonReply(201, commentJson(repo, number, comment));
    }
  }
  return messageReply(404, 'Not Found');
}

function validateLabels(repo: RepoRecord, value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    if (!repo.labels.has(entry)) return null;
    names.push(entry);
  }
  return names;
}

function createIssue(ctx: Ctx, repo: RepoRecord): Reply {
  const body = parseBody(ctx);
  if (!body.ok) return body.reply;
  const title = stringField(body.value.title);
  if (title === undefined || title === '') return messageReply(422, 'title is required');
  const labels = validateLabels(repo, body.value.labels);
  if (labels === null) return messageReply(422, 'unknown label');
  const text = stringField(body.value.body) ?? '';
  const issue = ctx.store.createIssue(repo, title, text, labels);
  return jsonReply(201, issueJson(repo, issue));
}

function listIssues(ctx: Ctx, repo: RepoRecord): Reply {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  return pagedReply(ctx, issues.map((issue) => issueJson(repo, issue)));
}

function patchIssue(ctx: Ctx, repo: RepoRecord, number: number): Reply {
  const body = parseBody(ctx);
  if (!body.ok) return body.reply;
  const issue = repo.issues.get(number);
  const pr = repo.pulls.get(number);
  if (issue === undefined && pr === undefined) return messageReply(404, 'Not Found');
  const title = stringField(body.value.title);
  const text = stringField(body.value.body);
  const state = stringField(body.value.state);
  const target = issue ?? pr!;
  if (title !== undefined) target.title = title;
  if (text !== undefined) target.body = text;
  if (state === 'open' || state === 'closed') target.state = state;
  if (issue !== undefined && body.value.labels !== undefined) {
    const labels = validateLabels(repo, body.value.labels);
    if (labels === null) return messageReply(422, 'unknown label');
    issue.labels = labels;
  }
  target.updatedAt = ctx.store.clock.nextIso();
  if (issue !== undefined) return jsonReply(200, issueJson(repo, issue));
  return jsonReply(200, pullJson(ctx.store, repo, pr!));
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

function handlePulls(ctx: Ctx, repo: RepoRecord, rest: string[]): Reply {
  const method = ctx.method;
  if (rest.length === 0) {
    if (method === 'POST') return createPull(ctx, repo);
    if (method === 'GET') return listPulls(ctx, repo);
    return messageReply(404, 'Not Found');
  }
  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isSafeInteger(number) || String(number) !== rest[0]) return messageReply(404, 'Not Found');
  if (rest.length === 1) {
    if (method === 'GET') {
      const pr = repo.pulls.get(number);
      if (pr === undefined) return messageReply(404, 'Not Found');
      return jsonReply(200, pullJson(ctx.store, repo, pr));
    }
    return messageReply(404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const pr = repo.pulls.get(number);
    if (pr === undefined) return messageReply(404, 'Not Found');
    const files = ctx.store.pullFiles(repo, pr).map((entry) => ({
      filename: entry.path,
      status: entry.status,
      additions: entry.additions,
      deletions: entry.deletions,
      changes: entry.changes,
    }));
    return pagedReply(ctx, files);
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') return mergePull(ctx, repo, number);
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      const pr = repo.pulls.get(number);
      if (pr === undefined) return messageReply(404, 'Not Found');
      return pagedReply(ctx, pr.comments.map((comment) => commentJson(repo, number, comment)));
    }
    if (method === 'POST') {
      const body = parseBody(ctx);
      if (!body.ok) return body.reply;
      const text = stringField(body.value.body);
      if (text === undefined || text === '') return messageReply(422, 'body is required');
      const comment = ctx.store.addComment(repo, number, text);
      if (comment === null) return messageReply(404, 'Not Found');
      return jsonReply(201, commentJson(repo, number, comment));
    }
  }
  return messageReply(404, 'Not Found');
}

function createPull(ctx: Ctx, repo: RepoRecord): Reply {
  const body = parseBody(ctx);
  if (!body.ok) return body.reply;
  const title = stringField(body.value.title);
  const headRaw = stringField(body.value.head);
  const baseRaw = stringField(body.value.base);
  if (title === undefined || title === '' || headRaw === undefined || baseRaw === undefined) {
    return messageReply(422, 'title, head and base are required');
  }
  const head = shortBranch(headRaw);
  const base = shortBranch(baseRaw);
  if (repo.refs.get(`refs/heads/${head}`) === undefined) return messageReply(422, 'head branch does not exist');
  if (repo.refs.get(`refs/heads/${base}`) === undefined) return messageReply(422, 'base branch does not exist');
  const text = stringField(body.value.body) ?? '';
  const pr = ctx.store.createPull(repo, title, text, head, base);
  return jsonReply(201, pullJson(ctx.store, repo, pr));
}

function listPulls(ctx: Ctx, repo: RepoRecord): Reply {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pr) => pr.state === state);
  pulls.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  return pagedReply(ctx, pulls.map((pr) => pullJson(ctx.store, repo, pr)));
}

function mergePull(ctx: Ctx, repo: RepoRecord, number: number): Reply {
  const body = parseBody(ctx);
  if (!body.ok) return body.reply;
  const pr = repo.pulls.get(number);
  if (pr === undefined) return messageReply(404, 'Not Found');
  if (pr.merged) return messageReply(405, 'Pull request is already merged');
  if (pr.state !== 'open') return messageReply(405, 'Pull request is closed');
  const rawMethod = stringField(body.value.merge_method) ?? 'squash';
  const method = rawMethod === 'merge' ? 'merge' : rawMethod === 'rebase' ? 'rebase' : 'squash';
  const message = stringField(body.value.commit_title) ?? stringField(body.value.commit_message) ?? pr.title;
  const result = ctx.store.mergePullRequest(repo, pr, method, message);
  if ('conflict' in result) {
    return messageReply(405, result.conflict === '' ? 'Base and head refs do not exist' : `Merge conflict in ${result.conflict}`);
  }
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = ctx.store.clock.nextIso();
  pr.mergeCommitSha = result.sha;
  pr.updatedAt = ctx.store.clock.nextIso();
  return jsonReply(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}
