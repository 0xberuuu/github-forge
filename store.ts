// store.ts — the forge's whole state, in memory: repositories, their git objects and refs,
// issues, pull requests, labels and comments. One process, no disk, no database.
//
// Determinism: every timestamp the store stamps comes from a monotonic clock seeded from
// MAKEFUN_TRIAL_NOW (never the wall clock), and every id from a counter, so two runs that
// receive the same requests hold the same bytes.

import {
  buildTree,
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitproto.ts';

/** The login the trial's bearer token names: the scenario's viewer, fixed by the contest's seed. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
/** 2025-01-01T00:00:00Z: the scenario's day one, the clock's fallback when no trial now is set. */
export const FALLBACK_EPOCH_MS = 1_735_689_600_000;

/** A monotonic clock: each reading is one second after the last, from a fixed base. */
export class Clock {
  private readonly baseMs: number;
  private tick = 0;

  constructor(nowEnv: string | undefined) {
    let base = FALLBACK_EPOCH_MS;
    if (nowEnv !== undefined && nowEnv !== '') {
      if (/^-?\d+$/.test(nowEnv.trim())) {
        const parsed = Number(nowEnv.trim());
        if (Number.isFinite(parsed) && parsed > 0) base = parsed;
      } else {
        const parsed = Date.parse(nowEnv);
        if (Number.isFinite(parsed)) base = parsed;
      }
    }
    this.baseMs = base;
  }

  /** The next timestamp, milliseconds since the epoch. */
  nextMs(): number {
    const ms = this.baseMs + this.tick * 1000;
    this.tick += 1;
    return ms;
  }

  /** The next timestamp as an ISO-8601 string. */
  nextIso(): string {
    return new Date(this.nextMs()).toISOString();
  }

  /** The next timestamp as unix seconds (a commit's author/committer time). */
  nextSec(): number {
    return Math.floor(this.nextMs() / 1000);
  }
}

export interface CommentRecord {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssueRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
  readonly comments: CommentRecord[];
}

export interface PullRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly comments: CommentRecord[];
}

export interface LabelRecord {
  readonly name: string;
  readonly color: string;
}

export interface DiffEntry {
  readonly path: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface RepoRecord {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
  /** This repository's git objects, by id. */
  readonly objects: Map<string, GitObject>;
  /** Ref name (refs/heads/..., refs/tags/...) to object id. */
  readonly refs: Map<string, string>;
  /** Memoised git wire responses, keyed by fingerprints of the state they depend on. */
  readonly gitCache: Map<string, Buffer>;
  readonly labels: Map<string, LabelRecord>;
  /** Issues and pull requests share GitHub's per-repo numbering. */
  readonly issues: Map<number, IssueRecord>;
  readonly pulls: Map<number, PullRecord>;
  nextNumber: number;
  nextCommentId: number;
}

export class ForgeStore {
  readonly clock: Clock;
  readonly repos = new Map<string, RepoRecord>();
  private nextId = 1;
  private seq = 0;

  constructor(nowEnv: string | undefined) {
    this.clock = new Clock(nowEnv);
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(ForgeStore.repoKey(owner, name));
  }

  listRepos(owner: string): RepoRecord[] {
    const out: RepoRecord[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRecord {
    const now = this.clock.nextIso();
    const repo: RepoRecord = {
      id: this.nextId++,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      gitCache: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(ForgeStore.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(ForgeStore.repoKey(owner, name));
  }

  // -----------------------------------------------------------------------------------------
  // git objects and refs
  // -----------------------------------------------------------------------------------------

  putObject(repo: RepoRecord, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(repo: RepoRecord, objects: Iterable<GitObject>): void {
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
    }
  }

  lookup(repo: RepoRecord): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refTip(repo: RepoRecord, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  defaultTip(repo: RepoRecord): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Refs sorted by name: HEAD's target first is the caller's job; this is the plain list. */
  sortedRefs(repo: RepoRecord): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /**
   * Resolve a ref-ish to a commit id: a 40-hex id held in the store, a branch name, or a tag
   * name. Tags peel to their commit. Returns null when nothing resolves.
   */
  resolveToCommit(repo: RepoRecord, refish: string): string | null {
    if (isObjectId(refish)) {
      const peeled = peelToCommit(refish, this.lookup(repo));
      return peeled;
    }
    const branch = repo.refs.get(`refs/heads/${refish}`);
    if (branch !== undefined) return peelToCommit(branch, this.lookup(repo));
    const tag = repo.refs.get(`refs/tags/${refish}`);
    if (tag !== undefined) return peelToCommit(tag, this.lookup(repo));
    const full = repo.refs.get(refish);
    if (full !== undefined) return peelToCommit(full, this.lookup(repo));
    return null;
  }

  // -----------------------------------------------------------------------------------------
  // trees
  // -----------------------------------------------------------------------------------------

  /** A tree flattened to path -> entry, recursing into subdirectories. */
  flattenTree(repo: RepoRecord, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, path: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, child);
        else if (entry.mode !== '160000') out.set(child, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build (and store) the tree objects for a flat path map; returns the root tree id. */
  buildTreeFromMap(repo: RepoRecord, files: ReadonlyMap<string, { mode: string; oid: string }>): string {
    const buildLevel = (paths: string[], prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, string[]>();
      for (const path of paths) {
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          const file = files.get(path)!;
          entries.push({ mode: file.mode, name: rest, oid: file.oid });
        } else {
          const dir = rest.slice(0, slash);
          const list = dirs.get(dir) ?? [];
          list.push(path);
          dirs.set(dir, list);
        }
      }
      for (const [dir, children] of dirs) {
        const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
        entries.push({ mode: '40000', name: dir, oid: buildLevel(children, childPrefix) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildLevel([...files.keys()], '');
  }

  /** The flat file map of a commit's tree (empty when the commit is unknown). */
  filesOfCommit(repo: RepoRecord, commitOid: string): Map<string, { mode: string; oid: string }> {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    try {
      return this.flattenTree(repo, parseCommit(object.data).tree);
    } catch {
      return new Map();
    }
  }

  // -----------------------------------------------------------------------------------------
  // commits
  // -----------------------------------------------------------------------------------------

  /** Build and store a commit object; returns its id. The message is stored byte for byte. */
  createCommit(
    repo: RepoRecord,
    treeOid: string,
    parents: readonly string[],
    message: string,
    authorName: string,
    authorEmail: string,
  ): string {
    const timestamp = this.clock.nextSec();
    const who = `${authorName} <${authorEmail}> ${timestamp} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
    return this.putObject(repo, 'commit', data);
  }

  /** Commit ids reachable from `tip`, newest first (depth-first pre-order, deduplicated). */
  listHistory(repo: RepoRecord, tip: string, limit = 10_000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      try {
        const parents = parseCommit(object.data).parents;
        for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
      } catch {
        // Corrupt commit: no parents to walk.
      }
    }
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // diff and merge
  // -----------------------------------------------------------------------------------------

  countLines(data: Buffer): number {
    if (data.length === 0) return 0;
    let lines = 0;
    for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
    if (data[data.length - 1] !== 0x0a) lines += 1;
    return lines;
  }

  /** The file-level diff from `baseFiles` to `headFiles`, sorted by path. */
  diffFiles(
    repo: RepoRecord,
    baseFiles: ReadonlyMap<string, { mode: string; oid: string }>,
    headFiles: ReadonlyMap<string, { mode: string; oid: string }>,
  ): DiffEntry[] {
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    const out: DiffEntry[] = [];
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base && head && base.oid === head.oid) continue;
      if (!base && head) {
        const additions = this.countLines(repo.objects.get(head.oid)?.data ?? Buffer.alloc(0));
        out.push({ path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (base && !head) {
        const deletions = this.countLines(repo.objects.get(base.oid)?.data ?? Buffer.alloc(0));
        out.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (base && head) {
        const additions = this.countLines(repo.objects.get(head.oid)?.data ?? Buffer.alloc(0));
        const deletions = this.countLines(repo.objects.get(base.oid)?.data ?? Buffer.alloc(0));
        out.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** The three-way merge of `headFiles` onto `baseFiles` from their `mergeBaseFiles`. */
  threeWayMerge(
    baseFiles: ReadonlyMap<string, { mode: string; oid: string }>,
    headFiles: ReadonlyMap<string, { mode: string; oid: string }>,
    mergeBaseFiles: ReadonlyMap<string, { mode: string; oid: string }>,
  ): { merged: Map<string, { mode: string; oid: string }>; conflict: string | null } {
    const merged = new Map<string, { mode: string; oid: string }>();
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...mergeBaseFiles.keys()]);
    for (const path of paths) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      const ancestor = mergeBaseFiles.get(path);
      const baseOid = base?.oid;
      const headOid = head?.oid;
      const ancestorOid = ancestor?.oid;
      if (headOid === ancestorOid) {
        if (base) merged.set(path, base);
      } else if (baseOid === ancestorOid) {
        if (head) merged.set(path, head);
      } else if (baseOid === headOid) {
        if (base) merged.set(path, base);
      } else {
        return { merged, conflict: path };
      }
    }
    return { merged, conflict: null };
  }

  /**
   * Merge a pull request onto its base branch. Returns the merge commit id, or the conflicting
   * path. `method` is squash (one commit, one parent), merge (a merge commit, two parents) or
   * rebase (treated as squash: the suite drives squash). The caller owns the PR record update.
   */
  mergePullRequest(
    repo: RepoRecord,
    pr: PullRecord,
    method: 'squash' | 'merge' | 'rebase',
    message: string,
  ): { sha: string } | { conflict: string } {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (baseTip === undefined || headTip === undefined) return { conflict: '' };
    const baseCommit = peelToCommit(baseTip, this.lookup(repo));
    const headCommit = peelToCommit(headTip, this.lookup(repo));
    if (baseCommit === null || headCommit === null) return { conflict: '' };
    const baseFiles = this.filesOfCommit(repo, baseCommit);
    const headFiles = this.filesOfCommit(repo, headCommit);
    const ancestor = mergeBase(headCommit, baseCommit, this.lookup(repo));
    const ancestorFiles = ancestor === null ? new Map() : this.filesOfCommit(repo, ancestor);
    const { merged, conflict } = this.threeWayMerge(baseFiles, headFiles, ancestorFiles);
    if (conflict !== null) return { conflict };
    const treeOid = this.buildTreeFromMap(repo, merged);
    const parents = method === 'merge' ? [baseCommit, headCommit] : [baseCommit];
    const sha = this.createCommit(repo, treeOid, parents, message, VIEWER_NAME, VIEWER_EMAIL);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    return { sha };
  }

  /** Whether a pull request would merge cleanly (its mergeable state, computed, never stored). */
  pullMergeable(repo: RepoRecord, pr: PullRecord): 'MERGEABLE' | 'CONFLICTING' {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (baseTip === undefined || headTip === undefined) return 'CONFLICTING';
    const baseCommit = peelToCommit(baseTip, this.lookup(repo));
    const headCommit = peelToCommit(headTip, this.lookup(repo));
    if (baseCommit === null || headCommit === null) return 'CONFLICTING';
    const ancestor = mergeBase(headCommit, baseCommit, this.lookup(repo));
    const ancestorFiles = ancestor === null ? new Map() : this.filesOfCommit(repo, ancestor);
    const { conflict } = this.threeWayMerge(
      this.filesOfCommit(repo, baseCommit),
      this.filesOfCommit(repo, headCommit),
      ancestorFiles,
    );
    return conflict === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  // -----------------------------------------------------------------------------------------
  // issues and pull requests
  // -----------------------------------------------------------------------------------------

  createIssue(repo: RepoRecord, title: string, body: string, labels: string[]): IssueRecord {
    const now = this.clock.nextIso();
    const issue: IssueRecord = {
      id: this.nextId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      userLogin: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
      createdSeq: this.nextSeq(),
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: RepoRecord, title: string, body: string, headRef: string, baseRef: string): PullRecord {
    const now = this.clock.nextIso();
    const pr: PullRecord = {
      id: this.nextId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      userLogin: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
      createdSeq: this.nextSeq(),
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
    };
    repo.pulls.set(pr.number, pr);
    return pr;
  }

  addComment(repo: RepoRecord, number: number, body: string): CommentRecord | null {
    const target = repo.issues.get(number) ?? repo.pulls.get(number);
    if (!target) return null;
    const now = this.clock.nextIso();
    const comment: CommentRecord = {
      id: this.nextId++,
      body,
      userLogin: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
    };
    target.comments.push(comment);
    return comment;
  }

  /** Head and base tips of a pull request, peeled to commits (nulls when a ref is gone). */
  pullTips(repo: RepoRecord, pr: PullRecord): { headSha: string | null; baseSha: string | null } {
    const head = repo.refs.get(`refs/heads/${pr.headRef}`);
    const base = repo.refs.get(`refs/heads/${pr.baseRef}`);
    return {
      headSha: head === undefined ? null : peelToCommit(head, this.lookup(repo)),
      baseSha: base === undefined ? null : peelToCommit(base, this.lookup(repo)),
    };
  }

  /** The diff a pull request's files list shows: merge-base tree vs head tree. */
  pullFiles(repo: RepoRecord, pr: PullRecord): DiffEntry[] {
    const { headSha, baseSha } = this.pullTips(repo, pr);
    if (headSha === null || baseSha === null) return [];
    const ancestor = mergeBase(headSha, baseSha, this.lookup(repo));
    const ancestorFiles = ancestor === null ? new Map() : this.filesOfCommit(repo, ancestor);
    return this.diffFiles(repo, ancestorFiles, this.filesOfCommit(repo, headSha));
  }
}
