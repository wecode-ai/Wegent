# Wework

Wework is the Wegent desktop workbench for local-first AI coding and workplace
workflows. It is built with Electron, Vite, React, and TypeScript.

## Capabilities

- Run local Codex-backed tasks through a managed Executor sidecar.
- Work with local projects, conversations, attachments, terminals, file
  previews, and code review without Backend login.
- Connect to a Wegent Backend for cloud models, cloud devices, remote runtime
  work, project spaces, and encrypted Codex authentication sync.
- Package macOS, Windows, and Linux applications with Executor, Codex, DWS,
  plugins, and runtime resources.

## Development

Requires Node.js 20+ and pnpm.

From the repository root:

```bash
pnpm install
pnpm --filter wework dev:desktop
```

Useful checks:

```bash
pnpm --filter wework typecheck
pnpm --filter wework lint
pnpm --filter wework test
pnpm --filter wework e2e
```

## Desktop Build

Prepare the bundled resources and build the Electron application for the
current platform:

```bash
pnpm --filter wework run prepare:codex --materialize
pnpm --filter wework run prepare:dws
pnpm --filter wework run prepare:harness-runtime --materialize
pnpm --filter wework build:desktop
```

GitHub releases are built by `.github/workflows/wework-app.yml`.

## Related Documentation

- [Local-First Cloud Connection](../docs/en/developer-guide/wework-cloud-connection.md)
- [Runtime Local Work](../docs/en/wegent/developer-guide/runtime-local-work.md)
- [Priority Task Filtering](../docs/en/wegent/user-guide/coding/priority-activity-filter.md)
- [Wework Performance Diagnostics](../docs/en/developer-guide/wework-performance-diagnostics.md)
- [Wework E2E Automation](../docs/en/developer-guide/wework-e2e-automation.md)
