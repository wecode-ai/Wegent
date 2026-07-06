---
sidebar_position: 38
---

# Embedded Browser

Wework's embedded browser displays an interactive web page inside the desktop workbench right panel and lets the local runtime control the same page through a CDP-backed Browser Session. It is not a screenshot preview, and it should not open a separate external Chrome window.

## Architecture

The embedded browser has three layers:

- The Wework Tauri native layer creates the embedded WebView and updates its bounds, navigation URL, and visibility through commands.
- The Wework React workbench mounts the browser panel into the right workspace pane and owns panel, task, and annotation state.
- `deps/browser/relay-server` exposes the browser MCP tools used by Codex. Tool names describe the capability as the Wework embedded browser, avoiding implementation details such as Playwright.

When Executor launches Codex, it injects the relay server configuration. Browser tool calls from the model go through the relay server, which uses Wework local IPC to operate the embedded browser bound to the current task.

## Task Binding

Browser instances are bound by pane/task label:

- A new conversation without a runtime task uses the current pane key as a temporary browser label.
- After sending from a new conversation creates a runtime task, Wework relabels the temporary browser to the new task label.
- When the user switches tasks, only the browser bound to the active pane/task is visible; pages from other tasks must not leak across panes.
- When the right browser panel is closed, the native WebView is hidden offscreen and must not cover the chat area, debug panel, or splitter.

This binding keeps the browser the user sees and the browser the agent controls as the same object.

## Annotation Flow

The browser address bar includes an annotation icon. In annotation mode:

- Hovering the page highlights only the current DOM element.
- Clicking an element opens a comment editor.
- Pressing Enter in the editor publishes the annotation into the Wework main composer attachment area.
- After sending, the conversation displays the comment attachment style and clears the composer attachment.
- The model receives hidden `<workspace_comment_context>` content that describes the annotated visible web page region; the UI does not display that raw hidden context.

Annotations are comments on the visible web page, not code selection comments. `browser_annotation` items should be interpreted by the model as comments on current visible page elements.

## Development Checks

After changing embedded browser code, run at least:

```bash
pnpm --filter wework typecheck
pnpm --filter wework lint
cd wework && pnpm vitest run src/lib/embedded-browser.test.ts src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx
cd wework/src-tauri && cargo check
cd deps/browser/relay-server && npm run test:mcp
```

When the Executor Codex launch configuration changes, also run:

```bash
cd executor && cargo test codex_launch_config_includes_cdp_browser_mcp_server
```
