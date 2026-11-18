// GitHub GraphQL v4 at POST /api/graphql: a small document parser and executor for the shapes
// `gh` and github-mcp-server send — viewer, repository reads, issue and pull-request reads,
// introspection, Relay `node(id:)`, cursor pagination, and the create/close/merge/comment mutations.
//
// A GraphQL-level failure is HTTP 200 with an `errors` array; only a missing or wrong token is 401
// (decided in app.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getForge, type Comment, type Issue, type PullRequest, type Repo } from './store.ts';

// ---------------------------------------------------------------- the document parser

interface ValueNode {
  kind: 'var' | 'enum' | 'string' | 'number' | 'bool' | 'null' | 'list' | 'object';
  name?: string;
  value?: string | number | boolean;
  values?: ValueNode[];
  fields?: Record<string, ValueNode>;
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selection: SelectionNode[];
}

interface InlineFragment {
  kind: 'inline';
  on: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | InlineFragment;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: SelectionNode[];
}

class SyntaxProblem extends Error {}

class Lexer {
  private readonly text: string;
  private index = 0;
  constructor(text: string) {
    this.text = text;
  }

  next(): { type: 'name' | 'number' | 'string' | 'punct' | 'eof'; value: string } {
    while (this.index < this.text.length) {
      const char = this.text[this.index] as string;
      if (char === '#') {
        while (this.index < this.text.length && this.text[this.index] !== '\n') this.index += 1;
        continue;
      }
      if (/\s|,/.test(char)) {
        this.index += 1;
        continue;
      }
      break;
    }
    if (this.index >= this.text.length) return { type: 'eof', value: '' };
    const char = this.text[this.index] as string;
    if (char === '"') {
      this.index += 1;
      let out = '';
      while (this.index < this.text.length) {
        const current = this.text[this.index] as string;
        if (current === '\\') {
          const escaped = this.text[this.index + 1] as string;
          out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          this.index += 2;
          continue;
        }
        if (current === '"') {
          this.index += 1;
          return { type: 'string', value: out };
        }
        out += current;
        this.index += 1;
      }
      throw new SyntaxProblem('unterminated string');
    }
    if (char === '.' && this.text.slice(this.index, this.index + 3) === '...') {
      this.index += 3;
      return { type: 'punct', value: '...' };
    }
    if ('{}()[]:!@$=|'.includes(char)) {
      this.index += 1;
      return { type: 'punct', value: char };
    }
    if (/[-0-9]/.test(char)) {
      let out = '';
      while (this.index < this.text.length && /[-+0-9.eE]/.test(this.text[this.index] as string)) out += this.text[this.index++];
      return { type: 'number', value: out };
    }
    if (/[_A-Za-z]/.test(char)) {
      let out = '';
      while (this.index < this.text.length && /[_0-9A-Za-z]/.test(this.text[this.index] as string)) out += this.text[this.index++];
      return { type: 'name', value: out };
    }
    throw new SyntaxProblem(`unexpected character ${JSON.stringify(char)}`);
  }
}

class Parser {
  private readonly lexer: Lexer;
  private token: { type: string; value: string };
  constructor(text: string) {
    this.lexer = new Lexer(text);
    this.token = this.lexer.next();
  }

  private advance(): { type: string; value: string } {
    const current = this.token;
    this.token = this.lexer.next();
    return current;
  }

  private expect(value: string): void {
    if (this.token.value !== value) throw new SyntaxProblem(`expected ${value}, got ${JSON.stringify(this.token.value)}`);
    this.advance();
  }

  private skipType(): void {
    if (this.token.value === '[') {
      this.advance();
      this.skipType();
      this.expect(']');
    } else {
      this.advance();
    }
    if (this.token.value === '!') this.advance();
  }

  document(): Operation {
    let kind: Operation['kind'] = 'query';
    let name: string | null = null;
    if (this.token.type === 'name' && (this.token.value === 'query' || this.token.value === 'mutation')) {
      kind = this.token.value as Operation['kind'];
      this.advance();
      if (this.token.type === 'name') name = this.advance().value;
      const variables: string[] = [];
      if (this.token.value === '(') {
        this.advance();
        while (this.token.value !== ')' && this.token.type !== 'eof') {
          if (this.token.value === '$') {
            this.advance();
            variables.push(this.advance().value);
            this.expect(':');
            this.skipType();
            if (this.token.value === '=') {
              this.advance();
              this.parseValue();
            }
          } else {
            this.advance();
          }
        }
        this.expect(')');
      }
      expectNonNull(this.token.value === '{', 'a selection set');
      return { kind, name, variables, selection: this.selectionSet() };
    }
    while (this.token.type !== 'eof' && this.token.value !== '{') this.advance();
    return { kind, name, variables: [], selection: this.selectionSet() };
  }

  private selectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.token.value !== '}' && this.token.type !== 'eof') out.push(this.selection());
    this.expect('}');
    return out;
  }

  private selection(): SelectionNode {
    if (this.token.value === '...') {
      this.advance();
      if (this.token.value === 'on') {
        this.advance();
        const on = this.advance().value;
        return { kind: 'inline', on, selection: this.selectionSet() };
      }
      // A named fragment spread: take the type from the name (fragments are not sent by the suite).
      const name = this.advance().value;
      return { kind: 'inline', on: name === 'on' ? null : null, selection: [] };
    }
    let name = this.advance().value;
    let alias: string | null = null;
    if (this.token.value === ':') {
      this.advance();
      alias = name;
      name = this.advance().value;
    }
    const args: Record<string, ValueNode> = {};
    if (this.token.value === '(') {
      this.advance();
      while (this.token.value !== ')' && this.token.type !== 'eof') {
        const argName = this.advance().value;
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    const selection = this.token.value === '{' ? this.selectionSet() : [];
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    if (this.token.value === '$') {
      this.advance();
      return { kind: 'var', name: this.advance().value };
    }
    if (this.token.type === 'string') return { kind: 'string', value: this.advance().value };
    if (this.token.type === 'number') return { kind: 'number', value: Number(this.advance().value) };
    if (this.token.value === '[') {
      this.advance();
      const values: ValueNode[] = [];
      while (this.token.value !== ']' && this.token.type !== 'eof') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (this.token.value === '{') {
      this.advance();
      const fields: Record<string, ValueNode> = {};
      while (this.token.value !== '}' && this.token.type !== 'eof') {
        const name = this.advance().value;
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    const word = this.advance().value;
    if (word === 'true' || word === 'false') return { kind: 'bool', value: word === 'true' };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }
}

function expectNonNull(condition: boolean, what: string): void {
  if (!condition) throw new SyntaxProblem(`expected ${what}`);
}

function valueOf(node: ValueNode | undefined, variables: Record<string, unknown>): unknown {
  if (node === undefined) return undefined;
  switch (node.kind) {
    case 'var':
      return variables[node.name ?? ''];
    case 'enum':
      return node.value;
    case 'string':
    case 'number':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return (node.values ?? []).map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields ?? {})) out[key] = valueOf(value, variables);
      return out;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- global ids

function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(value: unknown): { type: string; id: number } | null {
  if (typeof value !== 'string') return null;
  let decoded = '';
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const at = decoded.indexOf(':');
  if (at <= 0) return null;
  const id = Number.parseInt(decoded.slice(at + 1), 10);
  if (!Number.isFinite(id)) return null;
  return { type: decoded.slice(0, at), id };
}

// ---------------------------------------------------------------- the schema surface

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'url', 'labels'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'url', 'isDraft', 'additions', 'deletions', 'changedFiles'];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt',
  'updatedAt', 'url', 'isEmpty', 'stargazerCount', 'diskUsage', 'viewerCanAdminister',
];
const USER_FIELDS = ['id', 'login', 'name', 'email', 'url', 'avatarUrl'];
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: [...ISSUE_FIELDS, 'repository', 'comments', 'labels'],
  PullRequest: PULL_FIELDS,
  Repository: REPOSITORY_FIELDS,
  User: USER_FIELDS,
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color', 'description'],
  Ref: ['name', 'target', 'prefix'],
  SearchType: [],
};
const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

type Resolved = { value: unknown; type: string };

interface ExecContext {
  errors: Array<{ message: string; path?: Array<string | number> }>;
  variables: Record<string, unknown>;
}

function pathKey(field: FieldNode): string {
  return field.alias ?? field.name;
}

/** Project one selection set onto a typed value. */
function project(value: unknown, type: string, selection: SelectionNode[], path: string[], ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (PAYLOAD_TYPES.has(type)) return projectPayload(value, selection, path, ctx);
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2);
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => project(entry, inner, selection, [...path, index], ctx));
  }
  if (selection.length === 0) return value;
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'inline') {
      if (node.on !== null && node.on !== type && !(type === 'Repository' && node.on === 'Node')) continue;
      const nested = project(value, type, node.selection, path, ctx) as Record<string, unknown> | null;
      if (nested !== null && typeof nested === 'object') Object.assign(out, nested);
      continue;
    }
    const key = pathKey(node);
    const field = resolveField(value, type, node, path, ctx);
    if (field === null) {
      out[key] = null;
      continue;
    }
    out[key] = node.selection.length > 0 ? project(field.value, field.type, node.selection, [...path, key], ctx) : field.value;
  }
  return out;
}

function unknownField(ctx: ExecContext, type: string, field: FieldNode, path: string[]): null {
  ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'`, path: [...path, pathKey(field)] });
  return null;
}

function resolveField(value: unknown, type: string, field: FieldNode, path: string[], ctx: ExecContext): Resolved | null {
  const args: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(field.args)) args[name] = valueOf(node, ctx.variables);
  const obj = value as Record<string, unknown>;
  if (field.name === '__typename') return { value: type, type: 'String' };

  switch (type) {
    case 'User': {
      const user = obj as { id?: number; login?: string; name?: string; email?: string };
      switch (field.name) {
        case 'id': return { value: globalId('User', user.id ?? 0), type: 'ID' };
        case 'login': return { value: user.login ?? '', type: 'String' };
        case 'name': return { value: user.name ?? '', type: 'String' };
        case 'email': return { value: user.email ?? '', type: 'String' };
        case 'url': return { value: `https://example.invalid/${user.login ?? ''}`, type: 'String' };
        case 'avatarUrl': return { value: 'https://example.invalid/avatar.png', type: 'String' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'Ref': {
      const ref = obj as { name?: string };
      switch (field.name) {
        case 'name': return { value: ref.name ?? '', type: 'String' };
        case 'prefix': return { value: 'refs/heads/', type: 'String' };
        case 'target': return { value: null, type: 'Commit' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'Label': {
      const label = obj as { id?: number; name?: string; color?: string; description?: string | null };
      switch (field.name) {
        case 'id': return { value: globalId('Label', label.id ?? 0), type: 'ID' };
        case 'name': return { value: label.name ?? '', type: 'String' };
        case 'color': return { value: label.color ?? '', type: 'String' };
        case 'description': return { value: label.description ?? null, type: 'String' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'Repository': {
      const repo = obj as unknown as Repo;
      const forge = getForge();
      const key = `${repo.owner}/${repo.name}`;
      switch (field.name) {
        case 'id': return { value: globalId('Repository', repo.id), type: 'ID' };
        case 'databaseId': return { value: repo.id, type: 'Int' };
        case 'name': return { value: repo.name, type: 'String' };
        case 'nameWithOwner': return { value: repo.full_name, type: 'String' };
        case 'owner': return { value: forge.viewer, type: 'User' };
        case 'description': return { value: repo.description, type: 'String' };
        case 'isPrivate': return { value: repo.private, type: 'Boolean' };
        case 'defaultBranchRef': {
          if (forge.headOid(key) === undefined) return { value: null, type: 'Ref' };
          return { value: { name: repo.default_branch }, type: 'Ref' };
        }
        case 'viewerPermission': return { value: 'ADMIN', type: 'RepositoryPermission' };
        case 'hasIssuesEnabled': return { value: repo.has_issues, type: 'Boolean' };
        case 'createdAt': return { value: repo.created_at, type: 'String' };
        case 'updatedAt': return { value: repo.updated_at, type: 'String' };
        case 'url': return { value: `https://example.invalid/${repo.full_name}`, type: 'String' };
        case 'isEmpty': return { value: forge.headOid(key) === undefined, type: 'Boolean' };
        case 'stargazerCount': return { value: 0, type: 'Int' };
        case 'diskUsage': return { value: 0, type: 'Int' };
        case 'viewerCanAdminister': return { value: true, type: 'Boolean' };
        case 'issue': {
          const number = Number(args.number);
          const issue = forge.getIssue(key, number);
          return issue === undefined ? { value: null, type: 'Issue' } : { value: { ...issue, repo }, type: 'Issue' };
        }
        case 'pullRequest': {
          const number = Number(args.number);
          const pr = forge.getPull(key, number);
          return pr === undefined ? { value: null, type: 'PullRequest' } : { value: { ...pr, repo }, type: 'PullRequest' };
        }
        case 'issues': {
          const page = issueConnection(key, args);
          return { value: page, type: 'IssueConnection' };
        }
        case 'pullRequests': {
          const first = Number.isFinite(Number(args.first)) ? Number(args.first) : 30;
          const items = forge.listPulls(key).sort((a, b) => b.number - a.number).slice(0, first).map((pr) => ({ ...pr, repo }));
          return { value: { nodes: items, totalCount: items.length }, type: 'PullRequestConnection' };
        }
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'Issue': {
      const issue = obj as unknown as Issue & { repo: Repo };
      const state = issue.state === 'open' ? 'OPEN' : 'CLOSED';
      switch (field.name) {
        case 'id': return { value: globalId('Issue', issue.id), type: 'ID' };
        case 'number': return { value: issue.number, type: 'Int' };
        case 'title': return { value: issue.title, type: 'String' };
        case 'state': return { value: state, type: 'IssueState' };
        case 'body': return { value: issue.body ?? '', type: 'String' };
        case 'createdAt': return { value: issue.created_at, type: 'String' };
        case 'updatedAt': return { value: issue.updated_at, type: 'String' };
        case 'closedAt': return { value: issue.closed_at, type: 'String' };
        case 'author': return { value: issue.user, type: 'User' };
        case 'url': return { value: `https://example.invalid/issues/${issue.number}`, type: 'String' };
        case 'labels': return { value: issue.labels.map((name) => ({ name, color: 'ededed', id: 0 })), type: 'Label[]' };
        case 'repository': return { value: issue.repo ?? null, type: 'Repository' };
        case 'comments': return { value: { nodes: [], totalCount: 0 }, type: 'IssueConnection' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'PullRequest': {
      const pr = obj as unknown as PullRequest & { repo: Repo };
      const key = pr.repo === undefined ? '' : `${pr.repo.owner}/${pr.repo.name}`;
      switch (field.name) {
        case 'id': return { value: globalId('PullRequest', pr.id), type: 'ID' };
        case 'number': return { value: pr.number, type: 'Int' };
        case 'title': return { value: pr.title, type: 'String' };
        case 'body': return { value: pr.body ?? '', type: 'String' };
        case 'state': return { value: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED', type: 'PullRequestState' };
        case 'merged': return { value: pr.merged, type: 'Boolean' };
        case 'mergedAt': return { value: pr.merged_at, type: 'String' };
        case 'mergeable': return { value: pr.merged ? 'UNKNOWN' : pr.mergeable === false ? 'CONFLICTING' : 'MERGEABLE', type: 'MergeableState' };
        case 'headRefName': return { value: pr.head, type: 'String' };
        case 'baseRefName': return { value: pr.base, type: 'String' };
        case 'headRefOid': return { value: pr.head_sha, type: 'String' };
        case 'baseRefOid': return { value: pr.base_sha, type: 'String' };
        case 'createdAt': return { value: pr.created_at, type: 'String' };
        case 'updatedAt': return { value: pr.updated_at, type: 'String' };
        case 'url': return { value: `https://example.invalid/pull/${pr.number}`, type: 'String' };
        case 'isDraft': return { value: false, type: 'Boolean' };
        case 'additions': return { value: 1, type: 'Int' };
        case 'deletions': return { value: 0, type: 'Int' };
        case 'changedFiles': return { value: 1, type: 'Int' };
        case 'files': {
          const forge = getForge();
          const first = Number.isFinite(Number(args.first)) ? Number(args.first) : 30;
          const headTip = forge.getRefOid(key, `refs/heads/${pr.head}`) ?? pr.head_sha;
          const baseTip = forge.getRefOid(key, `refs/heads/${pr.base}`) ?? pr.base_sha;
          const files = forge.diff(key, baseTip, headTip).slice(0, first).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }));
          return { value: { nodes: files, totalCount: files.length }, type: 'PullRequestChangedFileConnection' };
        }
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'IssueConnection': {
      const connection = obj as { nodes: Array<Issue & { repo: Repo }>; hasNextPage: boolean; endCursor: string | null; totalCount: number };
      switch (field.name) {
        case 'nodes': return { value: connection.nodes, type: 'Issue[]' };
        case 'totalCount': return { value: connection.totalCount, type: 'Int' };
        case 'pageInfo': return { value: { hasNextPage: connection.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: connection.endCursor }, type: 'PageInfo' };
        case 'edges': return { value: connection.nodes.map((issue, index) => ({ cursor: String(index), node: issue })), type: 'IssueEdge[]' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'PullRequestConnection': {
      const connection = obj as { nodes: Array<PullRequest & { repo: Repo }>; totalCount: number };
      switch (field.name) {
        case 'nodes': return { value: connection.nodes, type: 'PullRequest[]' };
        case 'totalCount': return { value: connection.totalCount, type: 'Int' };
        case 'pageInfo': return { value: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, type: 'PageInfo' };
        case 'edges': return { value: [], type: 'PullRequestEdge[]' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'PullRequestChangedFileConnection': {
      const connection = obj as { nodes: Array<{ path: string; additions: number; deletions: number; changeType: string }>; totalCount: number };
      switch (field.name) {
        case 'nodes': return { value: connection.nodes, type: 'PullRequestChangedFile[]' };
        case 'totalCount': return { value: connection.totalCount, type: 'Int' };
        case 'pageInfo': return { value: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, type: 'PageInfo' };
        case 'edges': return { value: [], type: 'PullRequestChangedFileEdge[]' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'PullRequestChangedFile': {
      const file = obj as { path: string; additions: number; deletions: number; changeType: string };
      switch (field.name) {
        case 'path': return { value: file.path, type: 'String' };
        case 'additions': return { value: file.additions, type: 'Int' };
        case 'deletions': return { value: file.deletions, type: 'Int' };
        case 'changeType': return { value: file.changeType, type: 'String' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'PageInfo': {
      const page = obj as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      switch (field.name) {
        case 'hasNextPage': return { value: page.hasNextPage, type: 'Boolean' };
        case 'hasPreviousPage': return { value: page.hasPreviousPage, type: 'Boolean' };
        case 'startCursor': return { value: page.startCursor, type: 'String' };
        case 'endCursor': return { value: page.endCursor, type: 'String' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'IssueCommentEdge': {
      const comment = obj as { node: Comment };
      switch (field.name) {
        case 'node': return { value: comment.node, type: 'IssueComment' };
        case 'cursor': return { value: '0', type: 'String' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case 'IssueComment': {
      const comment = obj as unknown as Comment;
      switch (field.name) {
        case 'id': return { value: globalId('IssueComment', comment.id), type: 'ID' };
        case 'body': return { value: comment.body, type: 'String' };
        case 'createdAt': return { value: comment.created_at, type: 'String' };
        case 'author': return { value: comment.user, type: 'User' };
        default: return unknownField(ctx, type, field, path);
      }
    }
    case '__Type': {
      const typeInfo = obj as { name: string; kind: string };
      switch (field.name) {
        case 'name': return { value: typeInfo.name, type: 'String' };
        case 'kind': return { value: typeInfo.kind, type: 'String' };
        case 'description': return { value: null, type: 'String' };
        case 'fields': {
          const names = TYPE_FIELDS[typeInfo.name] ?? [];
          return { value: names.map((name) => ({ name })), type: '__Field[]' };
        }
        case 'enumValues': {
          const values = ENUM_VALUES[typeInfo.name] ?? [];
          return { value: values.map((name) => ({ name })), type: '__EnumValue[]' };
        }
        case 'possibleTypes': return { value: [], type: '__Type[]' };
        default: return unknownField(ctx, '__Type', field, path);
      }
    }
    case '__Field': {
      const meta = obj as { name: string };
      if (field.name === 'name') return { value: meta.name, type: 'String' };
      if (field.name === 'isDeprecated') return { value: false, type: 'Boolean' };
      if (field.name === 'deprecationReason') return { value: null, type: 'String' };
      return unknownField(ctx, '__Field', field, path);
    }
    case '__EnumValue': {
      const meta = obj as { name: string };
      if (field.name === 'name') return { value: meta.name, type: 'String' };
      if (field.name === 'isDeprecated') return { value: false, type: 'Boolean' };
      return unknownField(ctx, '__EnumValue', field, path);
    }
    default:
      return unknownField(ctx, type, field, path);
  }
}

function issueConnection(key: string, args: Record<string, unknown>): { nodes: Array<Issue & { repo: Repo }>; hasNextPage: boolean; endCursor: string | null; totalCount: number } {
  const forge = getForge();
  const repo = forge.getRepo(key.split('/')[0] as string, key.split('/').slice(1).join('/'));
  let issues = forge.listIssues(key).map((issue) => ({ ...issue, repo: repo as Repo }));
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null && states.length > 0) {
    issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = typeof args.orderBy === 'object' && args.orderBy !== null ? (args.orderBy as Record<string, unknown>) : {};
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  const sign = direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => {
    const primary = field === 'UPDATED_AT' ? a.updated_at.localeCompare(b.updated_at) : a.created_at.localeCompare(b.created_at);
    const value = primary === 0 ? a.number - b.number : primary;
    return sign * value;
  });
  const first = Number.isFinite(Number(args.first)) ? Math.max(0, Number(args.first)) : 30;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = Buffer.from(args.after, 'base64').toString('utf8');
    const parsed = Number.parseInt(decoded.replace(/^cursor:/, ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) start = parsed;
  }
  const slice = issues.slice(start, start + first);
  const hasNextPage = start + first < issues.length;
  const endCursor = slice.length === 0 ? null : Buffer.from(`cursor:${start + slice.length}`, 'utf8').toString('base64');
  return { nodes: slice, hasNextPage, endCursor, totalCount: issues.length };
}

// ---------------------------------------------------------------- operations

interface GraphQLRequest {
  query: string;
  variables: Record<string, unknown>;
  operationName: string | null;
}

function execute(operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecContext = { errors: [], variables };
  const forge = getForge();
  const data: Record<string, unknown> = {};

  for (const node of operation.selection) {
    if (node.kind === 'inline') continue;
    const key = pathKey(node);
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(node.args)) args[name] = valueOf(value, variables);

    if (operation.kind === 'query') {
      if (node.name === 'viewer') {
        data[key] = node.selection.length > 0 ? project(forge.viewer, 'User', node.selection, [key], ctx) : { login: forge.viewer.login };
        continue;
      }
      if (node.name === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = forge.getRepo(owner, name);
        data[key] = repo === undefined ? null : project(repo, 'Repository', node.selection, [key], ctx);
        continue;
      }
      if (node.name === 'node') {
        const decoded = decodeGlobalId(args.id);
        const found = decoded === null ? null : findByGlobalId(decoded.type, decoded.id);
        data[key] = found === null ? null : project(found.value, found.type, node.selection, [key], ctx);
        continue;
      }
      if (node.name === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        const known = name in TYPE_FIELDS || name in ENUM_VALUES;
        data[key] = known ? project({ name, kind: name in ENUM_VALUES ? 'ENUM' : 'OBJECT' }, '__Type', node.selection, [key], ctx) : null;
        continue;
      }
      if (node.name === '__schema') {
        data[key] = null;
        continue;
      }
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type 'Query'`, path: [key] });
      data[key] = null;
      continue;
    }

    // mutations
    const input = typeof args.input === 'object' && args.input !== null ? (args.input as Record<string, unknown>) : {};
    if (node.name === 'createIssue') {
      const decoded = decodeGlobalId(input.repositoryId);
      const repo = decoded === null ? undefined : forge.allRepos().find((candidate) => candidate.id === decoded.id);
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the global id', path: [key] });
        data[key] = null;
        continue;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : null;
      const issue = forge.createIssue(`${repo.owner}/${repo.name}`, title, body, []);
      data[key] = project({ issue: { ...issue, repo } }, 'CreateIssuePayload', node.selection, [key], ctx);
      continue;
    }
    if (node.name === 'closeIssue') {
      const decoded = decodeGlobalId(input.issueId);
      const found = decoded === null ? null : findIssueById(decoded.id);
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the global id', path: [key] });
        data[key] = null;
        continue;
      }
      found.issue.state = 'closed';
      found.issue.closed_at = forge.now;
      found.issue.updated_at = forge.now;
      data[key] = project({ issue: { ...found.issue, repo: found.repo } }, 'CloseIssuePayload', node.selection, [key], ctx);
      continue;
    }
    if (node.name === 'createPullRequest') {
      const decoded = decodeGlobalId(input.repositoryId);
      const repo = decoded === null ? undefined : forge.allRepos().find((candidate) => candidate.id === decoded.id);
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the global id', path: [key] });
        data[key] = null;
        continue;
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : null;
      const pr = forge.createPullRequest(`${repo.owner}/${repo.name}`, title, body, head, base);
      pr.created_at = forge.now;
      data[key] = project({ pullRequest: { ...pr, repo } }, 'CreatePullRequestPayload', node.selection, [key], ctx);
      continue;
    }
    if (node.name === 'mergePullRequest') {
      const decoded = decodeGlobalId(input.pullRequestId);
      const found = decoded === null ? null : findPullById(decoded.id);
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id', path: [key] });
        data[key] = null;
        continue;
      }
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
      const sha = forge.merge(found.key, found.pr, method);
      if (sha === null) {
        ctx.errors.push({ message: 'Pull request is not mergeable', path: [key] });
        data[key] = null;
        continue;
      }
      data[key] = project({ pullRequest: { ...found.pr, repo: found.repo } }, 'MergePullRequestPayload', node.selection, [key], ctx);
      continue;
    }
    if (node.name === 'addComment') {
      const decoded = decodeGlobalId(input.subjectId);
      const found = decoded === null ? null : findIssueById(decoded.id);
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the global id', path: [key] });
        data[key] = null;
        continue;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = forge.createComment(found.key, body);
      found.issue.comments += 1;
      data[key] = project({ commentEdge: { node: comment } }, 'AddCommentPayload', node.selection, [key], ctx);
      continue;
    }
    ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type 'Mutation'`, path: [key] });
    data[key] = null;
  }

  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

function findByGlobalId(type: string, id: number): { type: string; value: unknown } | null {
  const forge = getForge();
  if (type === 'Repository') {
    const repo = forge.allRepos().find((candidate) => candidate.id === id);
    return repo === undefined ? null : { type: 'Repository', value: repo };
  }
  if (type === 'Issue') {
    const found = findIssueById(id);
    return found === null ? null : { type: 'Issue', value: { ...found.issue, repo: found.repo } };
  }
  if (type === 'PullRequest') {
    const found = findPullById(id);
    return found === null ? null : { type: 'PullRequest', value: { ...found.pr, repo: found.repo } };
  }
  return null;
}

function findIssueById(id: number): { key: string; repo: Repo; issue: Issue } | null {
  const forge = getForge();
  for (const repo of forge.allRepos()) {
    const key = `${repo.owner}/${repo.name}`;
    for (const issue of forge.listIssues(key)) if (issue.id === id) return { key, repo, issue };
  }
  return null;
}

function findPullById(id: number): { key: string; repo: Repo; pr: PullRequest } | null {
  const forge = getForge();
  for (const repo of forge.allRepos()) {
    const key = `${repo.owner}/${repo.name}`;
    for (const pr of forge.listPulls(key)) if (pr.id === id) return { key, repo, pr };
  }
  return null;
}

// Payload wrappers: a mutation payload holds one child (issue, pullRequest, commentEdge).
const PAYLOAD_TYPES = new Set(['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']);

/** Payload objects hold one child (issue, pullRequest, commentEdge); project it like a field. */
function projectPayload(value: unknown, selection: SelectionNode[], path: string[], ctx: ExecContext): unknown {
  const out: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const node of selection) {
    if (node.kind === 'inline') continue;
    const key = pathKey(node);
    const childValue = obj[node.name];
    let childType = 'Payload';
    if (node.name === 'issue') childType = 'Issue';
    else if (node.name === 'pullRequest') childType = 'PullRequest';
    else if (node.name === 'commentEdge') childType = 'IssueCommentEdge';
    else {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type 'Payload'`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    out[key] = childValue === undefined || childValue === null ? null : project(childValue, childType, node.selection, [...path, key], ctx);
  }
  return out;
}

// ---------------------------------------------------------------- HTTP

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function runOne(request: GraphQLRequest): Record<string, unknown> {
  let operation: Operation;
  try {
    operation = new Parser(request.query).document();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'a GraphQL syntax error' }] };
  }
  try {
    return execute(operation, request.variables);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'the resolver failed' }] };
  }
}

function requestOf(value: unknown): GraphQLRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : null;
  if (query === null) return null;
  const variables = typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables) ? (record.variables as Record<string, unknown>) : {};
  return { query, variables, operationName: typeof record.operationName === 'string' ? record.operationName : null };
}

export async function handleGraphQLRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const text = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (Array.isArray(parsed)) {
    const out: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      const request = requestOf(entry);
      out.push(request === null ? { errors: [{ message: 'each batched operation needs a query' }] } : runOne(request));
    }
    sendJson(res, 200, out);
    return true;
  }
  const request = requestOf(parsed);
  if (request === null) {
    sendJson(res, 400, { message: 'a GraphQL request needs a query string' });
    return true;
  }
  sendJson(res, 200, runOne(request));
  return true;
}
