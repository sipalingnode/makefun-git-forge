// The forge's HTTP server: one process, one store, every surface on it.
//
//   GET  /healthz                     the env's boot probe
//   *    /api/v3/...                  GitHub REST v3            (rest.ts)
//   POST /api/graphql                 GitHub GraphQL v4         (graphql.ts)
//   *    /mcp                         Model Context Protocol    (mcp.ts)
//   *    /{owner}/{repo}.git/...      git smart HTTP            (git.ts)
//
// Everything under /api/v3, /api/graphql and /mcp needs the trial's bearer token; git smart HTTP
// takes the token too but does not require it. Every reply carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createForge } from './store.ts';
import { handleRestRequest } from './rest.ts';
import { handleGraphQLRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import { handleGitRequest } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null;
  if (match === null) return false;
  if (expected === '') return true;
  return (match[1] as string).trim() === expected;
}

export function createApp(): Server {
  const now = process.env.MAKEFUN_TRIAL_NOW ?? '2026-01-01T00:00:00Z';
  createForge(now);
  let requestSeq = 0;

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    requestSeq += 1;
    res.setHeader('x-github-request-id', `forge-${requestSeq}`);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://forge');
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      if (path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }
        await handleRestRequest(req, res, url);
        return;
      }

      if (path === '/api/graphql') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        await handleGraphQLRequest(req, res);
        return;
      }

      if (path === '/mcp') {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        await handleMcpRequest(req, res);
        return;
      }

      if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
        const handled = await handleGitRequest(req, res, url);
        if (handled) return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      process.stderr.write(`[forge] request ${method} ${path} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    }
  });
}
