// graphql.ts — GitHub GraphQL v4 at /api/graphql: a small executor for exactly the
// documents gh and github-mcp-server send. It lexes, parses, validates field names
// against the schema, and executes against the same store REST and MCP use.
//
// Shapes: {query, variables} in, {data} or {data, errors} out; a JSON array body is
// GitHub's operation batching and answers an array in the same order. An unknown field
// is HTTP 200 with an errors array naming it; an unknown repository is data.repository
// = null with no errors. Global ids are base64 of a typed key: opaque, stable, decodable.

import { VIEWER_ID, VIEWER_LOGIN, type ForgeStore, type IssueRecord, type PullRecord, type RepoRecord } from './store.ts';
import { jsonReply, messageReply, type Ctx, type Reply } from './types.ts';

// -------------------------------------------------------------------------------------------
// global ids and cursors
// -------------------------------------------------------------------------------------------

export function repoGlobalId(repo: RepoRecord): string {
  return Buffer.from(`R:${repo.owner}/${repo.name}`, 'utf8').toString('base64');
}

export function issueGlobalId(repo: RepoRecord, number: number): string {
  return Buffer.from(`I:${repo.owner}/${repo.name}:${number}`, 'utf8').toString('base64');
}

export function pullGlobalId(repo: RepoRecord, number: number): string {
  return Buffer.from(`P:${repo.owner}/${repo.name}:${number}`, 'utf8').toString('base64');
}

export function commentGlobalId(repo: RepoRecord, commentId: number): string {
  return Buffer.from(`C:${repo.owner}/${repo.name}:${commentId}`, 'utf8').toString('base64');
}

type DecodedId =
  | { kind: 'repo'; owner: string; name: string }
  | { kind: 'issue'; owner: string; name: string; number: number }
  | { kind: 'pull'; owner: string; name: string; number: number }
  | { kind: 'comment'; owner: string; name: string; commentId: number }
  | null;

export function decodeGlobalId(id: string): DecodedId {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([RIPC]):([^/]+)\/([^:]+)(?::(\d+))?$/.exec(text);
  if (!match) return null;
  const kind = match[1]!;
  const owner = match[2]!;
  const name = match[3]!;
  const num = match[4] !== undefined ? Number.parseInt(match[4], 10) : NaN;
  if (kind === 'R' && match[4] === undefined) return { kind: 'repo', owner, name };
  if (kind === 'I' && Number.isSafeInteger(num)) return { kind: 'issue', owner, name, number: num };
  if (kind === 'P' && Number.isSafeInteger(num)) return { kind: 'pull', owner, name, number: num };
  if (kind === 'C' && Number.isSafeInteger(num)) return { kind: 'comment', owner, name, commentId: num };
  return null;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// lexer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") are not in the suite's documents; a triple quote opens one anyway.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < source.length) {
        const c = source[j]!;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (esc === 'u' && j + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += map[esc] ?? esc;
            j += 2;
          }
          continue;
        }
        value += c;
        j += 1;
      }
      if (!closed) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser (AST)
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selectionSet: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  readonly kind: 'fragmentSpread';
  readonly name: string;
}

interface InlineFragmentNode {
  readonly kind: 'inlineFragment';
  readonly typeCondition: string | null;
  readonly selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string }>;
  readonly selectionSet: SelectionNode[];
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly name: string;
  readonly typeCondition: string;
  readonly selectionSet: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      const operation = this.next().value as 'query' | 'mutation';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, variables, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected definition start ${JSON.stringify(token.value)}`);
  }

  private parseVariableDefinitions(): Array<{ name: string }> {
    const variables: Array<{ name: string }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          this.parseValue();
        }
        this.skipDirectives();
        variables.push({ name });
      }
      this.expectPunct(')');
    }
    return variables;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value ${JSON.stringify(token.value)}`);
  }
}

// -------------------------------------------------------------------------------------------
// schema: field return types and resolvers
// -------------------------------------------------------------------------------------------

interface Wrapper {
  readonly __typename: string;
  [key: string]: unknown;
}

type Resolver = (parent: Wrapper, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface FieldDef {
  /** The named type a sub-selection is validated and executed against. */
  readonly named: string;
  readonly resolve: Resolver;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function repoWrapper(repo: RepoRecord): Wrapper {
  return { __typename: 'Repository', repo };
}

function issueWrapper(repo: RepoRecord, issue: IssueRecord): Wrapper {
  return { __typename: 'Issue', repo, issue };
}

function pullWrapper(repo: RepoRecord, pr: PullRecord): Wrapper {
  return { __typename: 'PullRequest', repo, pr };
}

function userWrapper(login: string): Wrapper {
  return { __typename: 'User', login };
}

function findRepo(store: ForgeStore, owner: unknown, name: unknown): RepoRecord | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function decodeRepoArg(store: ForgeStore, id: unknown): RepoRecord | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'repo') return null;
  if (decoded.owner !== VIEWER_LOGIN) return null;
  return store.getRepo(decoded.owner, decoded.name) ?? null;
}

const ISSUE_FIELD_NAMES = ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closed', 'closedAt', 'comments', 'labels', 'url', 'viewerCanUpdate'];
const PULL_FIELD_NAMES = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'isDraft', 'additions', 'deletions', 'changedFiles', 'comments', 'url'];
const REPO_FIELD_NAMES = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'fork', 'stargazerCount', 'watchers', 'homepageUrl', 'isArchived', 'isFork'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'REGISTRY_PACKAGE', 'APP'];
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: SEARCH_TYPE_VALUES,
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};
const TYPE_FIELD_NAMES: Record<string, string[]> = {
  Issue: ISSUE_FIELD_NAMES,
  PullRequest: PULL_FIELD_NAMES,
  Repository: REPO_FIELD_NAMES,
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { named: 'User', resolve: () => userWrapper(VIEWER_LOGIN) },
    repository: {
      named: 'Repository',
      resolve: (_parent, args, ctx) => {
        const repo = findRepo(ctx.store, args.owner, args.name);
        return repo === null ? null : repoWrapper(repo);
      },
    },
    node: {
      named: 'Node',
      resolve: (_parent, args, ctx) => {
        if (typeof args.id !== 'string') return null;
        const decoded = decodeGlobalId(args.id);
        if (decoded === null || decoded.owner !== VIEWER_LOGIN) return null;
        const repo = ctx.store.getRepo(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        if (decoded.kind === 'repo') return repoWrapper(repo);
        if (decoded.kind === 'issue') {
          const issue = repo.issues.get(decoded.number);
          return issue === undefined ? null : issueWrapper(repo, issue);
        }
        if (decoded.kind === 'pull') {
          const pr = repo.pulls.get(decoded.number);
          return pr === undefined ? null : pullWrapper(repo, pr);
        }
        return null;
      },
    },
    __type: {
      named: '__Type',
      resolve: (_parent, args) => {
        if (typeof args.name !== 'string') return null;
        const name = args.name;
        if (TYPE_FIELD_NAMES[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return { __typename: '__Type', typeName: name };
      },
    },
  },
  Mutation: {
    createIssue: {
      named: 'CreateIssuePayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = decodeRepoArg(ctx.store, input.repositoryId);
        if (repo === null) throw new GraphQLError('repository not found');
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const issue = ctx.store.createIssue(repo, title, body, []);
        return { __typename: 'CreateIssuePayload', repo, issue };
      },
    },
    closeIssue: {
      named: 'CloseIssuePayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        if (decoded === null || decoded.kind !== 'issue' || decoded.owner !== VIEWER_LOGIN) {
          throw new GraphQLError('issue not found');
        }
        const repo = ctx.store.getRepo(decoded.owner, decoded.name);
        const issue = repo?.issues.get(decoded.number);
        if (repo === undefined || issue === undefined) throw new GraphQLError('issue not found');
        issue.state = 'closed';
        issue.updatedAt = ctx.store.clock.nextIso();
        return { __typename: 'CloseIssuePayload', repo, issue };
      },
    },
    createPullRequest: {
      named: 'CreatePullRequestPayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = decodeRepoArg(ctx.store, input.repositoryId);
        if (repo === null) throw new GraphQLError('repository not found');
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new GraphQLError('head branch does not exist');
        if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new GraphQLError('base branch does not exist');
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const pr = ctx.store.createPull(repo, title, body, head, base);
        return { __typename: 'CreatePullRequestPayload', repo, pr };
      },
    },
    mergePullRequest: {
      named: 'MergePullRequestPayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        if (decoded === null || decoded.kind !== 'pull' || decoded.owner !== VIEWER_LOGIN) {
          throw new GraphQLError('pull request not found');
        }
        const repo = ctx.store.getRepo(decoded.owner, decoded.name);
        const pr = repo?.pulls.get(decoded.number);
        if (repo === undefined || pr === undefined) throw new GraphQLError('pull request not found');
        if (pr.merged) throw new GraphQLError('pull request is already merged');
        if (pr.state !== 'open') throw new GraphQLError('pull request is closed');
        const rawMethod = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
        const method = rawMethod === 'MERGE' ? 'merge' : rawMethod === 'REBASE' ? 'rebase' : 'squash';
        const message = typeof input.commitHeadline === 'string' ? input.commitHeadline : pr.title;
        const result = ctx.store.mergePullRequest(repo, pr, method, message);
        if ('conflict' in result) throw new GraphQLError(`merge conflict in ${result.conflict}`);
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = ctx.store.clock.nextIso();
        pr.mergeCommitSha = result.sha;
        pr.updatedAt = ctx.store.clock.nextIso();
        return { __typename: 'MergePullRequestPayload', repo, pr };
      },
    },
    addComment: {
      named: 'AddCommentPayload',
      resolve: (_parent, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        if (decoded === null || decoded.owner !== VIEWER_LOGIN) throw new GraphQLError('subject not found');
        const repo = ctx.store.getRepo(decoded.owner, decoded.name);
        if (repo === undefined) throw new GraphQLError('subject not found');
        const number = decoded.kind === 'issue' || decoded.kind === 'pull' ? decoded.number : NaN;
        if (!Number.isSafeInteger(number)) throw new GraphQLError('subject not found');
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = ctx.store.addComment(repo, number, body);
        if (comment === null) throw new GraphQLError('subject not found');
        return { __typename: 'AddCommentPayload', repo, comment, commentId: comment.id };
      },
    },
  },
  Repository: {
    id: { named: 'ID', resolve: (parent) => repoGlobalId(parent.repo as RepoRecord) },
    databaseId: { named: 'Int', resolve: (parent) => (parent.repo as RepoRecord).id },
    name: { named: 'String', resolve: (parent) => (parent.repo as RepoRecord).name },
    nameWithOwner: { named: 'String', resolve: (parent) => `${(parent.repo as RepoRecord).owner}/${(parent.repo as RepoRecord).name}` },
    owner: { named: 'User', resolve: (parent) => userWrapper((parent.repo as RepoRecord).owner) },
    defaultBranchRef: { named: 'Ref', resolve: (parent) => ({ __typename: 'Ref', name: (parent.repo as RepoRecord).defaultBranch }) },
    viewerPermission: { named: 'RepositoryPermission', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { named: 'Boolean', resolve: () => true },
    description: { named: 'String', resolve: (parent) => (parent.repo as RepoRecord).description },
    isPrivate: { named: 'Boolean', resolve: (parent) => (parent.repo as RepoRecord).isPrivate },
    issue: {
      named: 'Issue',
      resolve: (parent, args) => {
        const repo = parent.repo as RepoRecord;
        const number = typeof args.number === 'number' ? args.number : NaN;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueWrapper(repo, issue);
      },
    },
    issues: {
      named: 'IssueConnection',
      resolve: (parent, args) => {
        const repo = parent.repo as RepoRecord;
        let issues = [...repo.issues.values()];
        if (Array.isArray(args.states)) {
          const wanted = new Set(args.states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : '')));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = orderBy.direction === 'DESC' ? -1 : 1;
        issues.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
        const first = typeof args.first === 'number' ? args.first : 100;
        let start = 0;
        if (typeof args.after === 'string' && args.after !== '') {
          const cursorNumber = decodeCursor(args.after);
          if (cursorNumber !== null) {
            const at = issues.findIndex((issue) => issue.number === cursorNumber);
            if (at >= 0) start = at + 1;
          }
        }
        const page = issues.slice(start, start + Math.max(0, first));
        const hasNextPage = start + page.length < issues.length;
        const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
        return {
          __typename: 'IssueConnection',
          nodes: page.map((issue) => issueWrapper(repo, issue)),
          pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
          totalCount: issues.length,
        };
      },
    },
    pullRequests: {
      named: 'PullRequestConnection',
      resolve: (parent, args) => {
        const repo = parent.repo as RepoRecord;
        const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
        const first = typeof args.first === 'number' ? args.first : 100;
        const page = pulls.slice(0, Math.max(0, first));
        return {
          __typename: 'PullRequestConnection',
          nodes: page.map((pr) => pullWrapper(repo, pr)),
          pageInfo: { __typename: 'PageInfo', hasNextPage: page.length < pulls.length, endCursor: null },
          totalCount: pulls.length,
        };
      },
    },
    pullRequest: {
      named: 'PullRequest',
      resolve: (parent, args) => {
        const repo = parent.repo as RepoRecord;
        const number = typeof args.number === 'number' ? args.number : NaN;
        const pr = repo.pulls.get(number);
        return pr === undefined ? null : pullWrapper(repo, pr);
      },
    },
  },
  User: {
    id: { named: 'ID', resolve: (parent) => (parent.login === VIEWER_LOGIN ? String(VIEWER_ID) : '0') },
    login: { named: 'String', resolve: (parent) => parent.login as string },
    name: { named: 'String', resolve: (parent) => (parent.login === VIEWER_LOGIN ? 'ada iversen' : parent.login as string) },
  },
  Ref: {
    name: { named: 'String', resolve: (parent) => parent.name as string },
  },
  Issue: {
    id: { named: 'ID', resolve: (parent) => issueGlobalId(parent.repo as RepoRecord, (parent.issue as IssueRecord).number) },
    number: { named: 'Int', resolve: (parent) => (parent.issue as IssueRecord).number },
    title: { named: 'String', resolve: (parent) => (parent.issue as IssueRecord).title },
    state: { named: 'IssueState', resolve: (parent) => ((parent.issue as IssueRecord).state === 'open' ? 'OPEN' : 'CLOSED') },
    body: { named: 'String', resolve: (parent) => (parent.issue as IssueRecord).body },
  },
  IssueConnection: {
    nodes: { named: 'Issue', resolve: (parent) => parent.nodes as unknown[] },
    pageInfo: { named: 'PageInfo', resolve: (parent) => parent.pageInfo as Wrapper },
    totalCount: { named: 'Int', resolve: (parent) => parent.totalCount as number },
  },
  PageInfo: {
    hasNextPage: { named: 'Boolean', resolve: (parent) => parent.hasNextPage as boolean },
    hasPreviousPage: { named: 'Boolean', resolve: () => false },
    endCursor: { named: 'String', resolve: (parent) => (parent.endCursor as string | null) ?? null },
    startCursor: { named: 'String', resolve: () => null },
  },
  PullRequest: {
    id: { named: 'ID', resolve: (parent) => pullGlobalId(parent.repo as RepoRecord, (parent.pr as PullRecord).number) },
    number: { named: 'Int', resolve: (parent) => (parent.pr as PullRecord).number },
    title: { named: 'String', resolve: (parent) => (parent.pr as PullRecord).title },
    body: { named: 'String', resolve: (parent) => (parent.pr as PullRecord).body },
    state: {
      named: 'PullRequestState',
      resolve: (parent) => {
        const pr = parent.pr as PullRecord;
        return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      },
    },
    merged: { named: 'Boolean', resolve: (parent) => (parent.pr as PullRecord).merged },
    headRefName: { named: 'String', resolve: (parent) => (parent.pr as PullRecord).headRef },
    baseRefName: { named: 'String', resolve: (parent) => (parent.pr as PullRecord).baseRef },
    mergeable: {
      named: 'MergeableState',
      resolve: (parent, _args, ctx) => ctx.store.pullMergeable(parent.repo as RepoRecord, parent.pr as PullRecord),
    },
    files: {
      named: 'PullRequestChangedFileConnection',
      resolve: (parent, args, ctx) => {
        const repo = parent.repo as RepoRecord;
        const files = ctx.store.pullFiles(repo, parent.pr as PullRecord);
        const first = typeof args.first === 'number' ? args.first : 100;
        const page = files.slice(0, Math.max(0, first));
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: page.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.path })),
        };
      },
    },
  },
  PullRequestConnection: {
    nodes: { named: 'PullRequest', resolve: (parent) => parent.nodes as unknown[] },
    pageInfo: { named: 'PageInfo', resolve: (parent) => parent.pageInfo as Wrapper },
    totalCount: { named: 'Int', resolve: (parent) => parent.totalCount as number },
  },
  PullRequestChangedFileConnection: {
    nodes: { named: 'PullRequestChangedFile', resolve: (parent) => parent.nodes as unknown[] },
  },
  PullRequestChangedFile: {
    path: { named: 'String', resolve: (parent) => parent.path as string },
  },
  CreateIssuePayload: {
    issue: {
      named: 'Issue',
      resolve: (parent) => issueWrapper(parent.repo as RepoRecord, parent.issue as IssueRecord),
    },
  },
  CloseIssuePayload: {
    issue: {
      named: 'Issue',
      resolve: (parent) => issueWrapper(parent.repo as RepoRecord, parent.issue as IssueRecord),
    },
  },
  CreatePullRequestPayload: {
    pullRequest: {
      named: 'PullRequest',
      resolve: (parent) => pullWrapper(parent.repo as RepoRecord, parent.pr as PullRecord),
    },
  },
  MergePullRequestPayload: {
    pullRequest: {
      named: 'PullRequest',
      resolve: (parent) => pullWrapper(parent.repo as RepoRecord, parent.pr as PullRecord),
    },
  },
  AddCommentPayload: {
    commentEdge: {
      named: 'CommentEdge',
      resolve: (parent) => ({ __typename: 'CommentEdge', repo: parent.repo, comment: parent.comment, commentId: parent.commentId }),
    },
  },
  CommentEdge: {
    node: {
      named: 'IssueComment',
      resolve: (parent) => ({
        __typename: 'IssueComment',
        repo: parent.repo,
        comment: parent.comment,
        commentId: parent.commentId,
      }),
    },
  },
  IssueComment: {
    id: { named: 'ID', resolve: (parent) => commentGlobalId(parent.repo as RepoRecord, parent.commentId as number) },
    body: { named: 'String', resolve: (parent) => (parent.comment as { body: string }).body },
  },
  // The Node interface: validation needs its field; execution always resolves through
  // the concrete type, so this resolver only runs for a bare node { id } selection.
  Node: {
    id: {
      named: 'ID',
      resolve: (parent) => {
        const repo = parent.repo as RepoRecord | undefined;
        if (repo === undefined) return null;
        if (parent.issue !== undefined) return issueGlobalId(repo, (parent.issue as IssueRecord).number);
        if (parent.pr !== undefined) return pullGlobalId(repo, (parent.pr as PullRecord).number);
        return repoGlobalId(repo);
      },
    },
  },
  __Type: {
    name: { named: 'String', resolve: (parent) => parent.typeName as string },
    fields: {
      named: '__Field',
      resolve: (parent) => {
        const names = TYPE_FIELD_NAMES[parent.typeName as string] ?? [];
        return names.map((name) => ({ __typename: '__Field', name }));
      },
    },
    enumValues: {
      named: '__EnumValue',
      resolve: (parent) => {
        const values = ENUM_VALUES[parent.typeName as string] ?? [];
        return values.map((name) => ({ __typename: '__EnumValue', name }));
      },
    },
  },
  __Field: {
    name: { named: 'String', resolve: (parent) => parent.name as string },
  },
  __EnumValue: {
    name: { named: 'String', resolve: (parent) => parent.name as string },
  },
};

/** The interface Node resolves to, for fragment type conditions. */
const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'IssueComment']);

class GraphQLError extends Error {}

// -------------------------------------------------------------------------------------------
// validation: every selected field must exist on its type
// -------------------------------------------------------------------------------------------

function typeMatches(condition: string, typename: string): boolean {
  if (condition === typename) return true;
  if (condition === 'Node' && NODE_TYPES.has(typename)) return true;
  return false;
}

function validateSelections(
  selections: readonly SelectionNode[],
  typeName: string,
  fragments: ReadonlyMap<string, FragmentNode>,
  errors: string[],
  depth: number,
): void {
  if (depth > 32) {
    errors.push('selection is nested too deep');
    return;
  }
  const fields = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      const def = fields?.[selection.name];
      if (def === undefined) {
        errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
        continue;
      }
      if (selection.selectionSet !== null) {
        validateSelections(selection.selectionSet, def.named, fragments, errors, depth + 1);
      }
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push(`Unknown fragment "${selection.name}".`);
        continue;
      }
      validateSelections(fragment.selectionSet, fragment.typeCondition, fragments, errors, depth + 1);
    } else {
      const narrowed = selection.typeCondition ?? typeName;
      validateSelections(selection.selectionSet, narrowed, fragments, errors, depth + 1);
    }
  }
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

function executeSelections(
  selections: readonly SelectionNode[],
  typeName: string,
  parent: Wrapper,
  variables: Record<string, unknown>,
  fragments: ReadonlyMap<string, FragmentNode>,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = SCHEMA[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = typeName;
        continue;
      }
      const def = fields[selection.name];
      if (def === undefined) continue; // Validation already reported it; execution never runs.
      let value: unknown;
      try {
        value = def.resolve(parent, argsOf(selection, variables), ctx);
      } catch (err) {
        if (err instanceof GraphQLError) throw err;
        throw new GraphQLError((err as Error).message);
      }
      if (selection.selectionSet !== null && value !== null && value !== undefined) {
        if (Array.isArray(value)) {
          value = value.map((item) =>
            item !== null && typeof item === 'object' && '__typename' in (item as Wrapper)
              ? executeSelections(selection.selectionSet!, (item as Wrapper).__typename, item as Wrapper, variables, fragments, ctx)
              : item,
          );
        } else if (typeof value === 'object' && '__typename' in (value as Wrapper)) {
          value = executeSelections(selection.selectionSet, (value as Wrapper).__typename, value as Wrapper, variables, fragments, ctx);
        }
      }
      out[key] = value ?? null;
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment !== undefined && typeMatches(fragment.typeCondition, typeName)) {
        Object.assign(out, executeSelections(fragment.selectionSet, typeName, parent, variables, fragments, ctx));
      }
    } else {
      if (selection.typeCondition === null || typeMatches(selection.typeCondition, typeName)) {
        Object.assign(out, executeSelections(selection.selectionSet, typeName, parent, variables, fragments, ctx));
      }
    }
  }
  return out;
}

interface OperationInput {
  readonly query: unknown;
  readonly variables: Record<string, unknown>;
  readonly operationName: string | null;
}

function executeOperation(input: OperationInput, ctx: Ctx): Record<string, unknown> {
  if (typeof input.query !== 'string' || input.query.trim() === '') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(lex(input.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation: OperationNode | undefined;
  if (input.operationName !== null) {
    operation = operations.find((candidate) => candidate.name === input.operationName);
    if (operation === undefined) {
      return { errors: [{ message: `Unknown operation named "${input.operationName}".` }] };
    }
  } else {
    if (operations.length !== 1) {
      return { errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
    }
    operation = operations[0]!;
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(operation.selectionSet, rootType, fragments, errors, 0);
  if (errors.length > 0) {
    return { errors: errors.map((message) => ({ message })) };
  }
  try {
    const root: Wrapper = { __typename: rootType };
    const data = executeSelections(operation.selectionSet, rootType, root, input.variables, fragments, ctx);
    return { data };
  } catch (err) {
    if (err instanceof GraphQLError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    return { data: null, errors: [{ message: `Internal error: ${(err as Error).message}` }] };
  }
}

// -------------------------------------------------------------------------------------------
// HTTP entry point
// -------------------------------------------------------------------------------------------

export function handleGraphQL(ctx: Ctx): Reply {
  if (ctx.method !== 'POST') return messageReply(405, 'Method Not Allowed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return jsonReply(400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
  const toInput = (entry: unknown): OperationInput => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const variables = record.variables;
      return {
        query: record.query,
        variables: variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {},
        operationName: typeof record.operationName === 'string' ? record.operationName : null,
      };
    }
    return { query: undefined, variables: {}, operationName: null };
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeOperation(toInput(entry), ctx));
    return jsonReply(200, results);
  }
  return jsonReply(200, executeOperation(toInput(parsed), ctx));
}
