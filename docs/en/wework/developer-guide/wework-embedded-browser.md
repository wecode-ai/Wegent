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

Each Wework process binds an independent random local bridge port at startup and passes the resolved address to the Executor it launches. It must not reuse a bridge address inherited from a parent process, because concurrently running Wework instances could otherwise route browser requests to the wrong window.

## Task Binding

Browser instances are bound by pane/task label:

- A new conversation without a runtime task uses the current pane key as a temporary browser label.
- After sending from a new conversation creates a runtime task, Wework relabels the temporary browser to the new task label.
- When the user switches tasks, only the browser bound to the active pane/task is visible; pages from other tasks must not leak across panes.
- MCP open requests initially use the default label. When the current pane becomes inactive, Wework moves its WebView to a task-specific label, and only the active task may claim the default label.
- When the right browser panel is closed, the native WebView is hidden offscreen and must not cover the chat area, debug panel, or splitter.

This binding keeps the browser the user sees and the browser the agent controls as the same object.

## WebView Compatibility

- Browser WebViews use a fixed isolated data-store identifier and app data directory. They must not share Wework's main-interface sign-in storage, and the browser settings clear action only targets this store.
- The download handler reads the download directory and ask-before-download preference. Cancelling the system save dialog must cancel that download.
- Page-load events write the current URL into application state. Do not synchronously read the native WebView URL while handling IPC or custom protocols because macOS WebKit may temporarily have no URL while creating or destroying a WebView.
- The embedded browser uses a standard Safari-compatible User-Agent so websites do not treat a WebKit User-Agent without a browser product identifier as an unsupported client.

## Optional Cloud Desktop Extension

The public Wework codebase defines only cloud-desktop UI slots, the internal-page classifier contract, and an unavailable default implementation. It does not include connection credentials, launch targets, launch orchestration, a concrete remote desktop protocol, authentication endpoint, proxy, page, or third-party client assets. The workbench and device settings use this capability only through `src/extensions/cloud-desktop-contract.ts`; the default implementation sets `available` to `false`, so no desktop action is shown.

Product distributions may provide an implementation for `@extensions/cloud-desktop` at build time. The generic contract exposes `DeviceAction` and `WorkspaceAction` entry points for settings and project workspaces. A concrete implementation owns its connection types, launch target, asynchronous state, and launch orchestration, and must use `isCurrent` to ignore asynchronous requests after the project, device, or connection context changes. Public Wework provides only an unavailable fallback and must not contain concrete remote-desktop protocols, pages, assets, or dedicated copy.

### Wecode VNC implementation

The Wecode distribution provides the cloud-device Desktop action under **Settings → Connections** and in project workspaces. The settings action opens the system default browser through a Wecode viewer bridge bound only to a random `127.0.0.1` port; the project workspace action continues to use Wework's embedded browser. Both entries first read `GET /api/cloud-devices/{device_id}/vnc-config`, then establish a noVNC WebSocket connection through `/vnc-proxy/{device_id}` without depending on the optional `/status.vnc_url` field.

The WebSocket URL and Bearer token must not appear in the browser address, history, or React-visible route. The extension calls `prepare_vnc_session` to place the connection data in a two-minute in-memory handoff session owned by the Tauri Rust process. The embedded browser opens the app-local `/vnc.html?sessionId=...&sandboxId=...` page, which retrieves credentials through the `get_vnc_session_config` IPC command. The system browser opens `http://127.0.0.1:<ephemeral-port>/vnc.html?sessionId=...&sandboxId=...`, and that page retrieves the same in-memory configuration through same-origin `/session/{sessionId}`. The loopback bridge validates the Host header, disables CORS and caching, and sends `no-referrer`, so it does not write the token to the page URL or disk. The two-minute limit applies only to the handoff from the main WebView to the VNC page. After the first read, the VNC page caches the authenticated WebSocket URL for its own lifetime, so disconnect retries do not depend on the handoff TTL. If a full page reload occurs after the handoff expires, the user must reopen the desktop from the cloud-device entry.

The VNC page sets its connected marker only after a real noVNC connection succeeds. Disconnect and connection-error paths must clear the marker and expose retry state. Cloud desktop pages do not support web annotation mode. Only the settings action may open through the restricted loopback bridge; app-internal viewer URLs must still never be exported directly.

#### Code ownership and host boundary

VNC is a Wecode distribution capability, not a default capability of the public Wework embedded browser. Code follows these ownership rules:

- `wework/wecode/features/vnc/` owns the VNC API, session orchestration, settings action, workspace desktop entry, open flow, page, noVNC assets, and unit tests.
- `wework/wecode/extensions/cloud-desktop.tsx` binds the VNC feature's settings `DeviceAction` and workspace `WorkspaceAction` to the generic `cloudDesktopExtension` contract.
- `wework/wecode/extensions/desktop-control.ts` owns Wecode desktop-automation actions for closing, evaluating, and relabeling embedded browsers. Public automation delegates unhandled commands only through `wework/src/extensions/desktop-control-contract.ts`.
- `wework/wecode/vitePlugins.mjs` owns the Wecode build-plugin collection and loads the VNC asset plugin internally. Public `vite.config.ts` only loads the optional Wecode plugin collection and does not recognize VNC files or asset names.
- `wework/wecode/e2e/desktop/` owns the simulated RFB server, VNC HTTP/WebSocket fixture, feature state, and cloud-desktop verification flow. The Wecode wrapper injects an optional scenario into public Desktop E2E through `WEWORK_E2E_DESKTOP_SCENARIO_MODULE`; the public runner does not import Wecode directly.
- `wework/wecode/i18n/` owns VNC-specific English and Chinese copy and registers it in internal builds through the generic i18n extension-resource contract.
- `wework/src-tauri/src/wecode/vnc_session.rs` owns VNC credential handoff, TTL, security validation, the system-browser loopback viewer bridge, and native unit tests.

Public `wework/src/` keeps only protocol-neutral cloud-desktop UI slots and the internal-page classifier, the unavailable fallback, host calls, and the desktop-control and i18n extension contracts and delegation entries. It does not own cloud-desktop connection types, launch orchestration, dedicated copy, or concrete embedded-browser evaluation actions. Public component tests verify extension wiring only; concrete VNC integration assertions belong to Wecode feature tests or Desktop E2E.

`wework/src-tauri/src/wecode/` owns `VncSessionState` initialization, loopback bridge startup, and the dedicated command-registration list. Public `lib.rs` composes the native build only through generic Wecode setup and invoke-handler entries and does not identify concrete VNC commands. Backend VNC configuration APIs, the WebSocket proxy, and this documentation remain outside Wework's Wecode directory. Apart from those composition entries, public Vite configuration, React components, E2E control code, and tests must not add VNC, noVNC, or dedicated IPC implementations.

Changes to these flows must preserve IPC command names, the two-minute handoff TTL, authentication, the RFB handshake, existing `data-testid` values, error recovery, and project-workspace embedded-browser behavior. Verification must cover ownership-boundary tests, VNC feature tests, public host tests, TypeScript, ESLint, the Vite build, Rust tests, and real Desktop E2E. The settings E2E must additionally prove that the system browser completes the RFB handshake without creating a Wework browser tab.

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
