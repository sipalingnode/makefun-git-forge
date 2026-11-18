// Model Context Protocol over Streamable HTTP at POST /mcp: JSON-RPC 2.0, revision 2026-07-28
// (server/discover, no handshake) with a legacy `initialize` handshake for older clients.
//
// The tool list is a module constant, so two tools/list answers are byte-identical, and every tool
// acts on the same store the REST and GraphQL surfaces read.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getForge, type Issue, type PullRequest, type Repo } from './store.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0', title: 'makefun GitHub-compatible forge' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

const str = (description: string): Record<string, unknown> => ({ type: 'string', description });
const num = (description: string): Record<string, unknown> => ({ type: 'number', description });
const bool = (description: string): Record<string, unknown> => ({ type: 'boolean', description });

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user and return the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The repository name, for example "hello-world".'),
        description: str('A short description of the repository.'),
        private: bool('Whether the repository is private.'),
        owner: str('The account the repository belongs to; defaults to the authenticated user.'),
        full_name: str('The repository full name, "owner/name".'),
      },
      required: ['name'],
      additionalProperties: true,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        full_name: str('The repository full name, "owner/name".'),
      },
      required: ['owner', 'repo'],
      additionalProperties: true,
    },
  },
  {
    name: 'list_repos',
    description: 'List the authenticated user\'s repositories.',
    inputSchema: {
      type: 'object',
      properties: { per_page: num('How many repositories to return (default 30).') },
      required: [],
      additionalProperties: true,
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository and return the created issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The issue title.'),
        body: str('The issue body.'),
        full_name: str('The repository full name, "owner/name".'),
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: true,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        state: str('Only list issues in this state: open, closed or all.'),
        full_name: str('The repository full name, "owner/name".'),
      },
      required: ['owner', 'repo'],
      additionalProperties: true,
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        issue_number: num('The issue number.'),
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: true,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The pull request title.'),
        body: str('The pull request body.'),
        head: str('The branch the changes come from.'),
        base: str('The branch the changes go into.'),
        full_name: str('The repository full name, "owner/name".'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: true,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        pull_number: num('The pull request number.'),
        merge_method: str('The merge method: merge, squash or rebase.'),
        full_name: str('The repository full name, "owner/name".'),
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: true,
    },
  },
  {
    name: 'create_comment',
    description: 'Comment on an issue and return the created comment.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        issue_number: num('The issue number.'),
        body: str('The comment body.'),
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
      additionalProperties: true,
    },
  },
];

// ---------------------------------------------------------------- serialisers

function userJson(): Record<string, unknown> {
  const forge = getForge();
  return { id: forge.viewer.id, login: forge.viewer.login, name: forge.viewer.name, email: forge.viewer.email };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `https://example.invalid/${repo.full_name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels,
    user: userJson(),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    repository: repo.full_name,
    html_url: `https://example.invalid/${repo.full_name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state: pr.state,
    merged: pr.merged,
    mergeable: pr.mergeable,
    head: { ref: pr.head, sha: pr.head_sha },
    base: { ref: pr.base, sha: pr.base_sha },
    user: userJson(),
    repository: repo.full_name,
  };
}

// ---------------------------------------------------------------- tool execution

class ToolFailure extends Error {}

function findRepo(owner: string, name: string): Repo {
  const forge = getForge();
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw new ToolFailure(`Repository ${owner}/${name} was not found`);
  return repo;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new ToolFailure(`the ${name} argument is required`);
  return value;
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new ToolFailure(`the ${name} argument is required`);
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (typeof value === 'string') return value;
  return undefined;
}

function runTool(name: string, args: Record<string, unknown>): unknown {
  const forge = getForge();
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      const existing = forge.getRepo(forge.viewer.login, repoName);
      if (existing !== undefined) return repoJson(existing);
      const repo = forge.createRepo(repoName, optionalString(args, 'description') ?? null, args.private === true);
      return repoJson(repo);
    }
    case 'get_repo': {
      const repo = findRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      return repoJson(repo);
    }
    case 'list_repos': {
      const limit = typeof args.per_page === 'number' ? Math.max(1, Math.min(100, args.per_page)) : 30;
      return [...forge.allRepos()].slice(0, limit).map(repoJson);
    }
    case 'create_issue': {
      const repo = findRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      const issue = forge.createIssue(`${repo.owner}/${repo.name}`, stringArg(args, 'title'), optionalString(args, 'body') ?? null, []);
      return issueJson(repo, issue);
    }
    case 'list_issues': {
      const repo = findRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      const state = optionalString(args, 'state') ?? 'open';
      const key = `${repo.owner}/${repo.name}`;
      return forge
        .listIssues(key)
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueJson(repo, issue));
    }
    case 'get_issue': {
      const repo = findRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      const number = numberArg(args, 'issue_number');
      const issue = forge.getIssue(`${repo.owner}/${repo.name}`, number);
      if (issue === undefined) throw new ToolFailure(`Issue #${number} was not found`);
      return issueJson(repo, issue);
    }
    case 'create_pull_request': {
      const repo = findRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      const key = `${repo.owner}/${repo.name}`;
      if (forge.getRefOid(key, `refs/heads/${head}`) === undefined) throw new ToolFailure(`the head branch ${head} does not exist`);
      if (forge.getRefOid(key, `refs/heads/${base}`) === undefined) throw new ToolFailure(`the base branch ${base} does not exist`);
      const pr = forge.createPullRequest(key, stringArg(args, 'title'), optionalString(args, 'body') ?? null, head, base);
      return pullJson(repo, pr);
    }
    case 'merge_pull_request': {
      const repo = findRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      const number = numberArg(args, 'pull_number');
      const key = `${repo.owner}/${repo.name}`;
      const pr = forge.getPull(key, number);
      if (pr === undefined) throw new ToolFailure(`Pull request #${number} was not found`);
      const method = optionalString(args, 'merge_method') ?? 'merge';
      const sha = forge.merge(key, pr, method);
      if (sha === null) throw new ToolFailure(`Pull request #${number} is not mergeable`);
      return { number: pr.number, merged: true, sha, message: 'Pull Request successfully merged', state: pr.state };
    }
    case 'create_comment': {
      const repo = findRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      const number = numberArg(args, 'issue_number');
      const key = `${repo.owner}/${repo.name}`;
      const issue = forge.getIssue(key, number);
      if (issue === undefined) throw new ToolFailure(`Issue #${number} was not found`);
      const comment = forge.createComment(key, stringArg(args, 'body'));
      issue.comments += 1;
      return { id: comment.id, body: comment.body, user: userJson(), created_at: comment.created_at };
    }
    default:
      throw new ToolFailure(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (body === null || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function handleOne(message: RpcRequest): { body: Record<string, unknown> | null; status: number } {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = typeof message.params === 'object' && message.params !== null && !Array.isArray(message.params) ? (message.params as Record<string, unknown>) : {};
  const isNotification = id === undefined || id === null;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repositories, issues, pull requests and git over smart HTTP.',
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1] as string;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge.',
      }),
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: isNotification ? 202 : 200, body: isNotification ? null : rpcResult(id, {}) };
  }
  if (method === 'ping') return { status: 200, body: rpcResult(id, {}) };
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
    const missing = tool.inputSchema.required.filter((property) => args[property] === undefined || args[property] === null || args[property] === '');
    if (missing.length > 0) return { status: 200, body: rpcError(id, -32602, `Invalid params: missing required argument(s) ${missing.join(', ')}`) };
    try {
      const value = runTool(name, args);
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'the tool failed';
      return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text: message }], isError: true }) };
    }
  }
  if (method === 'resources/list') return { status: 200, body: rpcResult(id, { resources: [] }) };
  if (method === 'prompts/list') return { status: 200, body: rpcResult(id, { prompts: [] }) };
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = (req.method ?? 'POST').toUpperCase();
  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (method === 'GET') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'the MCP endpoint answers POST' }));
    return true;
  }
  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'the MCP endpoint answers POST' }));
    return true;
  }
  const text = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (Array.isArray(parsed)) {
    const out: Array<Record<string, unknown> | null> = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) {
        out.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      out.push(handleOne(entry as RpcRequest).body);
    }
    send(res, 200, out.filter((entry) => entry !== null));
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    send(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const outcome = handleOne(parsed as RpcRequest);
  send(res, outcome.status, outcome.body);
  return true;
}

export { TOOLS };
