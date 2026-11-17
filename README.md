# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sipalingnode/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sipalingnode/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process. It serves git smart HTTP, the REST v3 API, GraphQL v4 and a Model Context Protocol endpoint from a single in-memory store. There is no UI and nothing to install.

## Surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | `200 {"ok":true}` |
| `GET /api/v3/` | API root, `X-OAuth-Scopes: repo, read:org` |
| `/api/v3/...` | REST v3: repositories, contents, refs, issues, labels, pull requests |
| `POST /api/graphql` | GraphQL v4 for the `gh` and `github-mcp-server` documents |
| `POST /mcp` | MCP streamable HTTP, revision `2026-07-28` |
| `/<owner>/<repo>.git/...` | git smart HTTP: upload-pack protocol v2, receive-pack v0 |

A repository is created with `POST /api/v3/user/repos`. Pushes are fast-forward only. The authenticated user is the fixed scenario owner `adaiversen`.

## Layout

- `main.ts` — entry lifecycle. Leave it as the starter shipped it.
- `app.ts` — HTTP routing.
- `store.ts` — repositories, issues, pull requests and the shared git backend.
- `git.ts` — object ids, packfiles and the smart-HTTP protocol.
- `graphql.ts` — the GraphQL subset the suite executes.
- `mcp.ts` — JSON-RPC tools over the same store.

## License

MIT. See `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=w9xzqpzj&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
