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

## Startup Experience

Wework 启动时以“人和机器人共同准备工作台”为核心语义，依次呈现整理项目、连接工具和唤醒智能体三个阶段。启动动效必须保持文案与阶段图形同步，支持深色模式和减少动态效果偏好，并避免原生窗口阴影形成额外黑色边框。

The Wework startup experience represents a person and a robot preparing the
workbench together. It progresses through project organization, tool
connection, and agent activation. Keep the copy synchronized with the visual
stage, support dark mode and reduced motion, and avoid native window shadows
that create an extra dark outline.

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
pnpm --filter wework build:release
```

GitHub releases are built by `.github/workflows/wework-app.yml`.

## Related Documentation

- [Local-First Cloud Connection](../docs/en/developer-guide/wework-cloud-connection.md)
- [Runtime Local Work](../docs/en/wegent/developer-guide/runtime-local-work.md)
- [Priority Task Filtering](../docs/en/wegent/user-guide/coding/priority-activity-filter.md)
- [Wework Performance Diagnostics](../docs/en/developer-guide/wework-performance-diagnostics.md)
- [Wework E2E Automation](../docs/en/developer-guide/wework-e2e-automation.md)
