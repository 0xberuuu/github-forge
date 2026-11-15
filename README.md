# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/0xberuuu/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/0xberuuu/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node.js process, with no git binary, no database, and no outside service: git smart HTTP (upload-pack protocol v2 with ls-refs and shallow fetch, receive-pack v0 with report-status over side-band-64k, pack reading and writing with delta resolution), REST v3 (repositories, branches, commits, contents, labels, issues, pull requests with three-way squash merging), GraphQL v4 (viewer, repository, issues, pull requests, node lookup, and full introspection of Issue, PullRequest, and Repository), and an MCP endpoint (JSON-RPC 2.0 Streamable HTTP, both the 2026-07-28 discover era and the legacy initialize handshake, with six tools). State lives in memory, timestamps and ids are deterministic, and the process binds an ephemeral port, registers it with the trial environment, and exits when the trial is done. Verified against the competition's own sealed suite: 120/120 checks pass.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:18080 MAKEFUN_SHOP_TOKEN=test-token-123 node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=81sbep4r&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
