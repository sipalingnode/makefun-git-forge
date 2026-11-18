// GitHub REST v3 under /api/v3: repositories, branches, commits, contents, issues, comments,
// labels, pull requests, files and merges.
//
// Every reply is JSON, every reply carries a request id (added by app.ts), a body that cannot be
// parsed as JSON is a 400, and an unknown route is a JSON 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getForge, parseTree, type Issue, type Label, type PullRequest, type Repo, type User } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const OAUTH_SCOPES = 'repo, read:org, write:discussion';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-oauth-scopes': OAUTH_SCOPES,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-oauth-scopes': OAUTH_SCOPES, ...headers });
  res.end();
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null) {
      const name = asString((entry as Record<string, unknown>).name);
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------- serialisers

function userJson(user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `U_${user.id}`,
    avatar_url: 'https://avatars.example.invalid/u/1',
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://example.invalid/${user.login}`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    owner: userJson(getForge().viewer),
    html_url: `https://example.invalid/${repo.full_name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.full_name}`,
    default_branch: repo.default_branch,
    has_issues: repo.has_issues,
    open_issues_count: 0,
    open_issues: 0,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
    visibility: repo.private ? 'private' : 'public',
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: `L_${label.id}`, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const forge = getForge();
  const labels = issue.labels
    .map((name) => forge.getLabel(forge.repoKey(repo.owner, repo.name), name))
    .filter((label): label is Label => label !== undefined)
    .map(labelJson);
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    state_reason: null,
    labels,
    user: userJson(issue.user),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments,
    locked: false,
    active_lock_reason: null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.full_name}`,
    html_url: `https://example.invalid/${repo.full_name}/issues/${issue.number}`,
    labels_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/labels`,
    comments_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments`,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const head = {
    ref: pr.head,
    sha: pr.head_sha,
    label: `${repo.owner}:${pr.head}`,
    user: userJson(pr.user),
    repo: repoJson(repo),
  };
  const base = {
    ref: pr.base,
    sha: pr.base_sha,
    label: `${repo.owner}:${pr.base}`,
    user: userJson(pr.user),
    repo: repoJson(repo),
  };
  return {
    id: pr.id,
    node_id: `PR_${pr.id}`,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    mergeable: pr.mergeable,
    mergeable_state: pr.mergeable === false ? 'dirty' : 'clean',
    draft: false,
    head,
    base,
    user: userJson(pr.user),
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    url: `/api/v3/repos/${repo.full_name}/pulls/${pr.number}`,
    html_url: `https://example.invalid/${repo.full_name}/pull/${pr.number}`,
  };
}

// ---------------------------------------------------------------- helpers

function pageOf(query: URLSearchParams): { perPage: number; page: number } {
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '', 10);
  const rawPage = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(rawPerPage) && rawPerPage > 0 ? Math.min(100, rawPerPage) : 30;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  return { perPage, page };
}

function linkHeader(req: IncomingMessage, url: URL, page: number, perPage: number, hasNext: boolean, hasPrev: boolean): Record<string, string> {
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${url.pathname}`;
  const parts: string[] = [];
  if (hasNext) parts.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (hasPrev) parts.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  parts.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  return parts.length > 0 ? { link: parts.join(', ') } : {};
}

/** Resolve a ref query (branch name, tag name or 40-hex commit) to a commit oid. */
function resolveCommit(key: string, ref: string | null): string | undefined {
  const forge = getForge();
  if (ref === null || ref === '') return forge.headOid(key);
  const direct = forge.getRefOid(key, `refs/heads/${ref}`) ?? forge.getRefOid(key, `refs/tags/${ref}`);
  if (direct !== undefined) {
    const object = forge.getObject(key, direct);
    return object !== undefined && object.type === 'tag' ? resolveTagTarget(key, direct) : direct;
  }
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  return undefined;
}

function resolveTagTarget(key: string, oid: string): string {
  const forge = getForge();
  let current = oid;
  for (let depth = 0; depth < 5; depth += 1) {
    const object = forge.getObject(key, current);
    if (object === undefined || object.type !== 'tag') break;
    current = (object.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m) ?? [])[1] ?? current;
  }
  return current;
}

function requireRepo(owner: string, name: string): Repo {
  const forge = getForge();
  if (owner !== forge.viewer.login) throw new HttpError(404, 'Not Found');
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

function keyOf(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

function branchData(repo: Repo, name: string): Record<string, unknown> | undefined {
  const forge = getForge();
  const key = keyOf(repo);
  const oid = forge.getRefOid(key, `refs/heads/${name}`);
  if (oid === undefined) return undefined;
  return {
    name,
    commit: { sha: oid, url: `/api/v3/repos/${repo.full_name}/commits/${oid}` },
    protected: false,
    protection: { enabled: false },
    protection_url: `/api/v3/repos/${repo.full_name}/branches/${name}/protection`,
  };
}

function refJson(ref: string, oid: string): Record<string, unknown> {
  return {
    ref,
    node_id: `Ref_${oid.slice(0, 8)}`,
    url: `/api/v3/repos/x/y/git/refs/${ref}`,
    object: { sha: oid, type: 'commit', url: `/api/v3/repos/x/y/git/commits/${oid}` },
  };
}

// ---------------------------------------------------------------- entry point

export async function handleRestRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const forge = getForge();
  const method = (req.method ?? 'GET').toUpperCase();
  const parts = url.pathname.split('/').filter((part) => part.length > 0).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  // /api/v3/... -> drop the two prefix segments
  const seg = parts.slice(2);
  const query = url.searchParams;

  try {
    if (seg.length === 0) {
      send(res, 200, {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://example.invalid/settings/connections/applications{/client_id}',
        authorizations_url: '/api/v3/authorizations',
        repositories_url: '/api/v3/user/repos',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
        emojis_url: '/api/v3/emojis',
        rate_limit_url: '/api/v3/rate_limit',
      });
      return true;
    }

    if (seg[0] === 'meta' && seg.length === 1) {
      send(res, 200, { installed_version: 'makefun-forge-1.0.0', verifiable_password_authentication: false });
      return true;
    }

    if (seg[0] === 'rate_limit') {
      send(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } });
      return true;
    }

    if (seg[0] === 'user') {
      if (seg.length === 1 && method === 'GET') {
        send(res, 200, { ...userJson(forge.viewer), name: forge.viewer.name, email: forge.viewer.email, bio: null, public_repos: forge.allRepos().length });
        return true;
      }
      if (seg.length === 2 && seg[1] === 'repos') {
        if (method === 'POST') {
          const body = await readJson(req);
          const name = asString(body.name);
          if (name === undefined || name === '') throw new HttpError(422, 'Repository creation failed: name is required');
          if (forge.getRepo(forge.viewer.login, name) !== undefined) throw new HttpError(422, 'Repository creation failed: name already exists on this account');
          const repo = forge.createRepo(name, asString(body.description) ?? null, asBoolean(body.private) ?? false);
          send(res, 201, repoJson(repo));
          return true;
        }
        if (method === 'GET') {
          const { perPage, page } = pageOf(query);
          const all = [...forge.allRepos()].sort((a, b) => a.id - b.id);
          const start = (page - 1) * perPage;
          const items = all.slice(start, start + perPage);
          send(res, 200, items.map(repoJson), linkHeader(req, url, page, perPage, start + perPage < all.length, page > 1));
          return true;
        }
      }
    }

    if (seg[0] === 'users' && seg.length === 2 && method === 'GET') {
      if (seg[1] === forge.viewer.login) {
        send(res, 200, { ...userJson(forge.viewer), name: forge.viewer.name, email: forge.viewer.email });
        return true;
      }
      throw new HttpError(404, 'Not Found');
    }

    if (seg[0] === 'repos' && seg.length >= 3) {
      const repo = requireRepo(seg[1] as string, seg[2] as string);
      const key = keyOf(repo);
      const rest = seg.slice(3);

      if (rest.length === 0) {
        if (method === 'GET') {
          send(res, 200, repoJson(repo));
          return true;
        }
        if (method === 'PATCH') {
          const body = await readJson(req);
          const description = body.description;
          if (typeof description === 'string' || description === null) repo.description = description as string | null;
          const privateFlag = asBoolean(body.private);
          if (privateFlag !== undefined) repo.private = privateFlag;
          const name = asString(body.name);
          if (name !== undefined && name !== repo.name) {
            if (forge.getRepo(repo.owner, name) !== undefined) throw new HttpError(422, 'name already exists');
            const renamed = forge.renameRepo(repo.name, name) ?? repo;
            send(res, 200, repoJson(renamed));
            return true;
          }
          forge.touch(repo);
          send(res, 200, repoJson(repo));
          return true;
        }
        if (method === 'DELETE') {
          forge.deleteRepo(repo.owner, repo.name);
          sendRaw(res, 204);
          return true;
        }
      }

      if (rest[0] === 'branches') {
        if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
        if (rest.length === 1) {
          const list: Array<Record<string, unknown>> = [];
          for (const branch of forge.branches(key)) {
            const data = branchData(repo, branch.name);
            if (data !== undefined) list.push(data);
          }
          send(res, 200, list);
          return true;
        }
        const name = rest.slice(1).join('/');
        const data = branchData(repo, name);
        if (data === undefined) throw new HttpError(404, 'Branch not found');
        send(res, 200, data);
        return true;
      }

      if (rest[0] === 'git' && rest[1] === 'refs') {
        if (rest.length === 2) {
          if (method === 'GET') {
            send(res, 200, forge.refList(key).map((entry) => refJson(entry.ref, entry.oid)));
            return true;
          }
          if (method === 'POST') {
            const body = await readJson(req);
            const ref = asString(body.ref);
            const sha = asString(body.sha) ?? asString((body.object as Record<string, unknown> | undefined)?.sha);
            if (ref === undefined || sha === undefined) throw new HttpError(422, 'ref and sha are required');
            if (forge.getRefOid(key, ref) !== undefined) throw new HttpError(422, 'Reference already exists');
            if (!/^[0-9a-f]{40}$/.test(sha) || forge.getObject(key, sha) === undefined) throw new HttpError(422, 'Object does not exist');
            forge.setRefOid(key, ref, sha);
            send(res, 201, refJson(ref, sha));
            return true;
          }
        }
        if (method === 'GET') {
          const head = rest[2];
          const ref = head === 'heads' || head === 'tags' ? ['refs', ...rest.slice(2)].join('/') : rest.slice(2).join('/');
          const oid = forge.getRefOid(key, ref);
          if (oid === undefined) throw new HttpError(404, 'Not Found');
          send(res, 200, refJson(ref, oid));
          return true;
        }
      }

      if (rest[0] === 'git' && rest[1] === 'commits' && rest.length === 3 && method === 'GET') {
        const oid = rest[2] as string;
        const object = forge.getObject(key, oid);
        if (object === undefined || object.type !== 'commit') throw new HttpError(404, 'Not Found');
        send(res, 200, commitJson(repo, oid, object.data));
        return true;
      }

      if (rest[0] === 'git' && rest[1] === 'trees' && rest.length === 3 && method === 'GET') {
        const oid = rest[2] as string;
        const object = forge.getObject(key, oid);
        if (object === undefined || object.type !== 'tree') throw new HttpError(404, 'Not Found');
        const entries: Array<Record<string, unknown>> = [];
        for (const entry of parseTree(object.data)) {
          entries.push({ path: entry.name, mode: entry.mode, type: entry.mode === '40000' ? 'tree' : 'blob', sha: entry.oid, size: 0, url: '' });
        }
        send(res, 200, { sha: oid, url: '', tree: entries, truncated: false });
        return true;
      }

      if (rest[0] === 'git' && rest[1] === 'blobs' && rest.length === 3 && method === 'GET') {
        const oid = rest[2] as string;
        const object = forge.getObject(key, oid);
        if (object === undefined || object.type !== 'blob') throw new HttpError(404, 'Not Found');
        send(res, 200, { sha: oid, size: object.data.length, content: object.data.toString('base64').replace(/(.{60})/g, '$1\n'), encoding: 'base64' });
        return true;
      }

      if (rest[0] === 'commits' && method === 'GET') {
        const sha = query.get('sha');
        const start = resolveCommit(key, sha);
        if (start === undefined) throw new HttpError(404, 'Not Found');
        const { perPage, page } = pageOf(query);
        const chain = forge.commitChain(key, start);
        const slice = chain.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
        const out: Array<Record<string, unknown>> = [];
        for (const oid of slice) {
          const object = forge.getObject(key, oid);
          if (object !== undefined && object.type === 'commit') out.push(commitJson(repo, oid, object.data));
        }
        send(res, 200, out);
        return true;
      }

      if (rest[0] === 'contents') {
        const path = rest.slice(1).join('/');
        if (method === 'GET') {
          contentsGet(res, repo, path, query.get('ref'));
          return true;
        }
        if (method === 'PUT') {
          await contentsPut(req, res, repo, path);
          return true;
        }
        if (method === 'DELETE') {
          await contentsDelete(req, res, repo, path);
          return true;
        }
      }

      if (rest[0] === 'labels') {
        if (method === 'GET') {
          send(res, 200, forge.listLabels(key).map(labelJson));
          return true;
        }
        if (method === 'POST' && rest.length === 1) {
          const body = await readJson(req);
          const name = asString(body.name);
          if (name === undefined || name === '') throw new HttpError(422, 'name is required');
          if (forge.getLabel(key, name) !== undefined) throw new HttpError(422, 'Label already exists');
          const label = forge.createLabel(key, name, asString(body.color) ?? 'ededed', asString(body.description) ?? null);
          send(res, 201, labelJson(label));
          return true;
        }
      }

      if (rest[0] === 'issues') {
        if (rest.length === 1) {
          if (method === 'GET') {
            const state = query.get('state') ?? 'open';
            const sort = query.get('sort') ?? 'created';
            const direction = query.get('direction') ?? 'desc';
            let issues = forge.listIssues(key);
            if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
            const sign = direction === 'asc' ? 1 : -1;
            issues.sort((a, b) => {
              const primary = sort === 'updated' ? a.updated_at.localeCompare(b.updated_at) : a.created_at.localeCompare(b.created_at);
              const first = primary === 0 ? a.number - b.number : primary;
              return sign * first;
            });
            const { perPage, page } = pageOf(query);
            const slice = issues.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
            send(res, 200, slice.map((issue) => issueJson(repo, issue)));
            return true;
          }
          if (method === 'POST') {
            const body = await readJson(req);
            const title = asString(body.title);
            if (title === undefined || title === '') throw new HttpError(422, 'title is required');
            const names = labelNamesOf(body.labels);
            for (const name of names) {
              if (forge.getLabel(key, name) === undefined) throw new HttpError(422, `Label does not exist: ${name}`);
            }
            const issue = forge.createIssue(key, title, asString(body.body) ?? null, names);
            send(res, 201, issueJson(repo, issue));
            return true;
          }
        }
        const number = Number.parseInt(rest[1] ?? '', 10);
        if (!Number.isFinite(number)) throw new HttpError(404, 'Not Found');
        const issue = forge.getIssue(key, number);
        if (issue === undefined) throw new HttpError(404, 'Not Found');
        if (rest.length === 2) {
          if (method === 'GET') {
            send(res, 200, issueJson(repo, issue));
            return true;
          }
          if (method === 'PATCH') {
            const body = await readJson(req);
            const state = asString(body.state);
            if (state === 'open' || state === 'closed') {
              issue.state = state;
              issue.closed_at = state === 'closed' ? forge.now : null;
            }
            const title = asString(body.title);
            if (title !== undefined) issue.title = title;
            if (typeof body.body === 'string' || body.body === null) issue.body = body.body as string | null;
            if (body.labels !== undefined) {
              const names = labelNamesOf(body.labels);
              for (const name of names) if (forge.getLabel(key, name) === undefined) throw new HttpError(422, `Label does not exist: ${name}`);
              issue.labels = names;
            }
            issue.updated_at = forge.now;
            send(res, 200, issueJson(repo, issue));
            return true;
          }
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'GET') {
            send(res, 200, forge.listComments(key).map((comment) => ({
              id: comment.id,
              node_id: `C_${comment.id}`,
              body: comment.body,
              user: userJson(comment.user),
              created_at: comment.created_at,
              updated_at: comment.updated_at,
              url: `/api/v3/repos/${repo.full_name}/issues/comments/${comment.id}`,
            })));
            return true;
          }
          if (method === 'POST') {
            const body = await readJson(req);
            const text = asString(body.body);
            if (text === undefined) throw new HttpError(422, 'body is required');
            const comment = forge.createComment(key, text);
            issue.comments += 1;
            send(res, 201, {
              id: comment.id,
              node_id: `C_${comment.id}`,
              body: comment.body,
              user: userJson(comment.user),
              created_at: comment.created_at,
              updated_at: comment.updated_at,
              url: `/api/v3/repos/${repo.full_name}/issues/comments/${comment.id}`,
            });
            return true;
          }
        }
        if (rest.length === 3 && rest[2] === 'labels' && method === 'POST') {
          const body = await readJson(req);
          for (const name of labelNamesOf(body)) {
            if (forge.getLabel(key, name) === undefined) throw new HttpError(422, `Label does not exist: ${name}`);
            if (!issue.labels.includes(name)) issue.labels.push(name);
          }
          send(res, 200, issue.labels.map((name) => labelJson(forge.getLabel(key, name) as Label)));
          return true;
        }
      }

      if (rest[0] === 'pulls') {
        if (rest.length === 1) {
          if (method === 'GET') {
            const state = query.get('state') ?? 'open';
            let pulls = forge.listPulls(key);
            if (state !== 'all') pulls = pulls.filter((pr) => pr.state === state);
            pulls.sort((a, b) => b.number - a.number);
            const { perPage, page } = pageOf(query);
            const slice = pulls.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
            send(res, 200, slice.map((pr) => pullJson(repo, pr)));
            return true;
          }
          if (method === 'POST') {
            const body = await readJson(req);
            const title = asString(body.title);
            const head = asString(body.head);
            const base = asString(body.base);
            if (title === undefined || head === undefined || base === undefined) throw new HttpError(422, 'title, head and base are required');
            if (forge.getRefOid(key, `refs/heads/${head}`) === undefined) throw new HttpError(422, `No commits between ${base} and ${head}`);
            if (forge.getRefOid(key, `refs/heads/${base}`) === undefined) throw new HttpError(422, `Base branch ${base} not found`);
            const pr = forge.createPullRequest(key, title, asString(body.body) ?? null, head, base);
            send(res, 201, pullJson(repo, pr));
            return true;
          }
        }
        const number = Number.parseInt(rest[1] ?? '', 10);
        if (!Number.isFinite(number)) throw new HttpError(404, 'Not Found');
        const pr = forge.getPull(key, number);
        if (pr === undefined) throw new HttpError(404, 'Not Found');
        if (rest.length === 2 && method === 'GET') {
          send(res, 200, pullJson(repo, pr));
          return true;
        }
        if (rest.length === 2 && method === 'PATCH') {
          const body = await readJson(req);
          const title = asString(body.title);
          if (title !== undefined) pr.title = title;
          if (typeof body.body === 'string' || body.body === null) pr.body = body.body as string | null;
          const state = asString(body.state);
          if (state === 'closed') {
            pr.state = 'closed';
            pr.closed_at = forge.now;
          }
          pr.updated_at = forge.now;
          send(res, 200, pullJson(repo, pr));
          return true;
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const headTip = forge.getRefOid(key, `refs/heads/${pr.head}`) ?? pr.head_sha;
          const baseTip = forge.getRefOid(key, `refs/heads/${pr.base}`) ?? pr.base_sha;
          const files = forge.diff(key, baseTip, headTip);
          send(res, 200, files.map((file) => ({
            sha: file.sha,
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            blob_url: `/api/v3/repos/${repo.full_name}/blob/${headTip}/${file.filename}`,
            raw_url: `/api/v3/repos/${repo.full_name}/raw/${headTip}/${file.filename}`,
            contents_url: `/api/v3/repos/${repo.full_name}/contents/${file.filename}?ref=${headTip}`,
          })));
          return true;
        }
        if (rest.length === 3 && rest[2] === 'commits' && method === 'GET') {
          const headTip = forge.getRefOid(key, `refs/heads/${pr.head}`) ?? pr.head_sha;
          const baseTip = forge.getRefOid(key, `refs/heads/${pr.base}`) ?? pr.base_sha;
          const base = forge.mergeBase(key, headTip, baseTip);
          const chain = forge.commitChain(key, headTip).filter((oid) => oid !== base);
          send(res, 200, chain.map((oid) => {
            const object = forge.getObject(key, oid);
            return object === undefined ? { sha: oid } : commitJson(repo, oid, object.data);
          }));
          return true;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          const body = await readJson(req);
          if (pr.merged || pr.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
          const methodName = asString(body.merge_method) ?? 'merge';
          const sha = forge.merge(key, pr, methodName);
          if (sha === null) throw new HttpError(405, 'Pull Request is not mergeable');
          pr.mergeable = null;
          send(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
          return true;
        }
      }
    }

    send(res, 404, { message: 'Not Found' });
    return true;
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, { message: err.message });
      return true;
    }
    send(res, 500, { message: 'Internal Server Error' });
    return true;
  }
}

// ---------------------------------------------------------------- commits and contents

function commitJson(repo: Repo, oid: string, data: Buffer): Record<string, unknown> {
  const commit = parseCommitData(data);
  const author = identityJson(commit.author);
  const committer = identityJson(commit.committer);
  return {
    sha: oid,
    node_id: `C_${oid.slice(0, 10)}`,
    commit: {
      author,
      committer,
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.full_name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.full_name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.full_name}/commits/${oid}`,
    html_url: `https://example.invalid/${repo.full_name}/commit/${oid}`,
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.full_name}/commits/${parent}` })),
  };
}

function identityJson(line: string): Record<string, unknown> {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: '', email: '', date: '2026-01-01T00:00:00Z' };
  const seconds = Number.parseInt(match[3] as string, 10);
  return { name: match[1], email: match[2], date: new Date(seconds * 1000).toISOString() };
}

function parseCommitData(data: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  // import-free parse: the same header rules as store.parseCommit
  const blank = data.indexOf('\n\n');
  const header = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const view = { tree: '', parents: [] as string[], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5);
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7));
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

function contentsGet(res: ServerResponse, repo: Repo, path: string, ref: string | null): void {
  const forge = getForge();
  const key = keyOf(repo);
  const commit = resolveCommit(key, ref);
  if (commit === undefined) throw new HttpError(404, 'Not Found');
  const files = forge.flatTree(key, commit);
  if (path === '' || path === '/') return contentsDirectory(res, repo, files, '', commit);
  const file = files.get(path);
  if (file !== undefined) {
    const blob = forge.getObject(key, file.oid);
    if (blob === undefined) throw new HttpError(404, 'Not Found');
    const base64 = blob.data.toString('base64').replace(/(.{60})/g, '$1\n');
    send(res, 200, {
      name: path.split('/').pop(),
      path,
      sha: file.oid,
      size: blob.data.length,
      type: 'file',
      content: base64,
      encoding: 'base64',
      url: `/api/v3/repos/${repo.full_name}/contents/${path}?ref=${commit}`,
      git_url: `/api/v3/repos/${repo.full_name}/git/blobs/${file.oid}`,
      html_url: `https://example.invalid/${repo.full_name}/blob/${commit}/${path}`,
      download_url: `https://example.invalid/${repo.full_name}/raw/${commit}/${path}`,
      _links: { self: `/api/v3/repos/${repo.full_name}/contents/${path}?ref=${commit}`, git: `/api/v3/repos/${repo.full_name}/git/blobs/${file.oid}` },
    });
    return;
  }
  const prefix = `${path}/`;
  if ([...files.keys()].some((candidate) => candidate.startsWith(prefix))) return contentsDirectory(res, repo, files, prefix, commit);
  throw new HttpError(404, 'Not Found');
}

function contentsDirectory(res: ServerResponse, repo: Repo, files: Map<string, { oid: string; mode: string }>, prefix: string, commit: string): void {
  const forge = getForge();
  const key = keyOf(repo);
  const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const tail = path.slice(prefix.length);
    const slash = tail.indexOf('/');
    if (slash < 0) {
      const blob = forge.getObject(key, entry.oid);
      children.set(tail, { type: 'file', oid: entry.oid, size: blob?.data.length ?? 0 });
    } else {
      const name = tail.slice(0, slash);
      if (!children.has(name)) children.set(name, { type: 'dir', oid: '', size: 0 });
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [name, child] of [...children].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const childPath = prefix === '' ? name : `${prefix}${name}`;
    let sha = child.oid;
    if (child.type === 'dir') {
      const subset = new Map<string, { oid: string; mode: string }>();
      for (const [path, entry] of files) if (path.startsWith(`${childPath}/`)) subset.set(path.slice(childPath.length + 1), entry);
      sha = forge.buildTreeFrom(key, subset);
    }
    out.push({
      name,
      path: childPath,
      sha,
      size: child.size,
      type: child.type,
      url: `/api/v3/repos/${repo.full_name}/contents/${childPath}?ref=${commit}`,
      html_url: `https://example.invalid/${repo.full_name}/tree/${commit}/${childPath}`,
    });
  }
  send(res, 200, out);
}

async function contentsPut(req: IncomingMessage, res: ServerResponse, repo: Repo, path: string): Promise<void> {
  const forge = getForge();
  const key = keyOf(repo);
  const body = await readJson(req);
  const message = asString(body.message);
  const content = asString(body.content);
  if (message === undefined || content === undefined) throw new HttpError(422, 'message and content are required');
  if (path === '') throw new HttpError(422, 'path is required');
  let data: Buffer;
  try {
    data = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    throw new HttpError(422, 'content is not base64');
  }
  const branch = asString(body.branch) ?? repo.default_branch;
  if (forge.getRefOid(key, `refs/heads/${branch}`) === undefined && branch !== repo.default_branch) throw new HttpError(404, `Branch ${branch} not found`);
  const sha = asString(body.sha);
  const existed = forge.flatTree(key, forge.getRefOid(key, `refs/heads/${branch}`)).has(path);
  const written = forge.writeFile(key, branch, path, data, message, sha);
  if (written === 'stale') throw new HttpError(409, 'sha does not match the current content');
  const base64 = data.toString('base64').replace(/(.{60})/g, '$1\n');
  send(res, existed ? 200 : 201, {
    content: {
      name: path.split('/').pop(),
      path,
      sha: written.blob,
      size: data.length,
      type: 'file',
      content: base64,
      encoding: 'base64',
      url: `/api/v3/repos/${repo.full_name}/contents/${path}`,
      git_url: `/api/v3/repos/${repo.full_name}/git/blobs/${written.blob}`,
    },
    commit: {
      sha: written.commit,
      node_id: `C_${written.commit.slice(0, 10)}`,
      message,
      url: `/api/v3/repos/${repo.full_name}/git/commits/${written.commit}`,
    },
  });
}

async function contentsDelete(req: IncomingMessage, res: ServerResponse, repo: Repo, path: string): Promise<void> {
  const forge = getForge();
  const key = keyOf(repo);
  const body = await readJson(req);
  const message = asString(body.message) ?? `Delete ${path}`;
  const branch = asString(body.branch) ?? repo.default_branch;
  const tip = forge.getRefOid(key, `refs/heads/${branch}`);
  const files = forge.flatTree(key, tip);
  const current = files.get(path);
  if (current === undefined) throw new HttpError(404, 'Not Found');
  const sha = asString(body.sha);
  if (sha !== undefined && sha !== '' && sha !== current.oid) throw new HttpError(409, 'sha does not match the current content');
  const removed = forge.deleteFile(key, branch, path, message);
  send(res, 200, {
    content: null,
    commit: {
      sha: removed.commit,
      node_id: `C_${removed.commit.slice(0, 10)}`,
      message,
      url: `/api/v3/repos/${repo.full_name}/git/commits/${removed.commit}`,
    },
  });
}
