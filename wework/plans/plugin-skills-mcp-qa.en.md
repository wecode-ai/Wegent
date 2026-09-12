---
sidebar_position: 1
---

# Standalone Skills and MCP verification

The existing Plugins entry contains Plugins, Skills, and MCP tabs. Skills can be previewed from Git, a directory, or ZIP, then installed into the isolated personal Codex home or a selected project's `.agents/skills`. A plugin manifest is not required. MCP configuration, discovery, reload, and OAuth use native Codex APIs. Repository history stays local; no publication, sharing, automatic repository updates, or cloud synchronization is introduced. Duplicate installations are rejected, and reinstalling preserves Codex's enabled preference for that path.

Environment: macOS arm64, branch `feature/plugin-skills-mcp`, isolated Electron and Executor home, Codex 0.153.3. Only synthetic entries are modified. Codex can discover shared host Skills, which the tests do not modify.

Verification plan and results:

- Existing plugin and new capability unit tests: 132 passing in focused runs. TypeScript, ESLint, and Prettier passed.
- Eight native tests cover full directory and ZIP imports, executable script permissions, project scope, duplicate batches without partial writes, cancellation, traversal, symlinks, and excessive nesting. Existing plugin archive tests (14) and the native RPC allowlist test passed.
- Real Electron session `2026-09-10T15-52-07-881Z-29843`: install a synthetic Skill, disable/enable it, attempt a duplicate import, recover, and uninstall; then add a real local STDIO MCP service, discover its tool, disable/enable it, and remove its configuration. Both complete lifecycles passed. Screenshots are under that session's `capabilities/` directory.
- Read-only Git preview of `https://github.com/openai/skills.git` discovered 44 Skills. Cancelling removed the preview; none of the repository's Skills were installed.
- The final revision passed the complete isolated Electron lifecycle again in session `2026-09-10T15-58-17-925Z-45655`, including blocking duplicate actions while refreshing a saved MCP configuration. All isolated sessions were stopped.
- Native integration revealed that optional null defaults returned by `config/read` cannot be serialized back to TOML. Writes now omit those defaults while preserving configured values, with regression coverage.
- The `plugin-capabilities` checkpoint is registered in the standard desktop runner and core CI shard 17. CI classification tests passed. Remote GitHub CI has not run.
- The packaged application passed `pnpm --filter wework e2e:desktop --segment plugin-capabilities`. Evidence is under `test-results/desktop-e2e/2026-09-10T15-56-43-657Z-40987`. The scenario now waits for the installation dialog to close before asserting installed files, preventing preview text from prematurely satisfying the success check.

Pending external verification: private corporate Git authentication, OAuth against an available corporate MCP service, and Windows desktop. Project scope and ZIP behavior were tested through native file operations; the complete Electron lifecycle used personal-directory installation. UI unit tests use mocks; desktop coverage uses real Executor, Codex, and a local MCP service. All synthetic installed entries and preview directories are removed during cleanup, and the isolated Electron session is stopped.
