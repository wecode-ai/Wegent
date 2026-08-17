---
sidebar_position: 38
---

# Embedded Browser

Wework's embedded browser displays an interactive web page inside the desktop workbench right panel and lets the local runtime control the same page through the WKWebView bridge. It is not a screenshot preview, and it should not open a separate external Chrome window.

## Architecture

The embedded browser has three layers:

- The Wework Tauri native layer creates the embedded WebView and updates its bounds, navigation URL, and visibility through commands.
- The Wework React workbench mounts the browser panel into the right workspace pane and owns panel, task, and annotation state.
- `executor/src/browser_mcp` exposes browser MCP tools to Codex and uses the Wework bridge to operate the WKWebView bound to the current task.

When Executor launches Codex, it injects the browser MCP server configuration. Browser tool calls from the model read the current bridge identity and send controlled requests to the Wework process's loopback bridge. The bridge then schedules WKWebView navigation, page inspection, DOM actions, waits, and screenshots on the main thread.

Each Wework process binds an independent random local bridge port and atomically writes the bridge identity to `runtime/embedded-browser-bridge.json` under the active Executor home. The identity contains a schema version, process PID, loopback address, authentication token, and start time. Directory and file permissions should be restricted to the current user, and the token must not be logged. The MCP server reads the latest identity before each request and accepts only loopback addresses, so multiple Wework instances do not route browser requests to the wrong window.

Bridge requests must include the authentication token. `open` and `navigate` allow only safe web schemes; do not allow `file:`, `javascript:`, or other URLs that could read local files or execute arbitrary script through the Agent navigation path.

The bridge supports limited concurrency. A long `waitFor` request must not block independent `click`, `fill`, or `inspect` requests; when the concurrency limit is reached, return an explicit busy error instead of waiting forever.

## Agent Browser Capabilities

The model sees browser action tools, not raw WebKit APIs. Common capabilities include:

- `browser_open` / `browser_navigate`: open or navigate pages.
- `browser_inspect`: return a structured page inspection result.
- `browser_click`, `browser_type`, `browser_fill`, `browser_press_key`, `browser_hover`, `browser_focus`: operate page elements.
- `browser_scroll`, `browser_scroll_into_view`, `browser_select_option`, `browser_set_checked`: cover common scrolling and form controls.
- `browser_wait`: wait for page stability, URL conditions, text, or element state.
- `browser_take_screenshot`: capture a real browser screenshot.
- `browser_capabilities`, `browser_native_input_probe`, `browser_ax_probe`, `browser_present_probe`: report WKWebView capability boundaries and diagnostics.

Combined tools may collapse frequent flows into one model call, such as `browser_open_and_inspect`, `browser_click_and_inspect`, and `browser_wait_and_inspect`. Combined tools must appear in MCP `tools/list` so the protocol remains self-describing.

`inspect` means structured page inspection, while `screenshot` means an actual image capture. Do not reuse `snapshot` for structured DOM output because that conflicts with real screenshot semantics.

Structured inspect results should include at least the page URL, title, viewport, node list, and text summary. Nodes should consistently include:

- `ref` and `index`: used by later actions for targeting.
- `role`, `name`, `text`, and `value`: used by the model to understand semantics.
- `rect`, `visible`, `disabled`, and `actionable`: used to decide whether the node can be operated.
- `frameId`, `selector`, or other diagnostic locator data: useful for debugging, but the model should not depend on fragile selectors.
- `warnings`: occlusion, invisibility, sensitive input, cross-frame limits, or other risks.

Action tools should prefer `ref` values produced by `inspect`. If page re-rendering invalidates a `ref`, return a recoverable error that asks the model to inspect again instead of silently guessing a selector. Action results should describe the observed effect, such as value change, DOM change, URL change, or only dispatching an event without an observed effect.

## Task Binding

Browser instances are bound by pane/task label:

- A new conversation without a runtime task uses the current pane key as a temporary browser label.
- After sending from a new conversation creates a runtime task, Wework relabels the temporary browser to the new task label.
- When the user switches tasks, only the browser bound to the active pane/task is visible; pages from other tasks must not leak across panes.
- Executor injects a task-specific label for an existing runtime task. Only temporary new conversations use the default or pane label, and only the active task may claim the default label.
- When a top-level task tab becomes inactive, its workbench effects must stay active so the task-specific bridge listener can handle background `open`, `waitFor`, and `inspect` requests. Hide the React surface with `hidden` and keep the native WebView invisible; non-task tabs should not pay this keep-alive cost.
- When the right browser panel is closed, the native WebView is hidden offscreen and must not cover the chat area, debug panel, or splitter.

This binding keeps the browser the user sees and the browser the agent controls as the same object.

Each pane/task label currently maps to one browser host. Wework can keep multiple top-level task tabs and their independent browsers alive, but there is no browser-internal multi-tab model inside one task. Adding browser-internal tabs must extend bridge routing identity, lifecycle ownership, and the Agent tool protocol instead of reusing another task's host.

A programmatic first open must treat "the panel was requested" and "the native WebView is ready for navigation" as separate phases. The bridge stores pending navigation with a request ID and executes it only after the browser host for that task has nonzero visible bounds and reaches the ready state. If the frontend listener registers after the request, it recovers the event from the pending-request snapshot. The tool may report success only after the native WebView has navigated to the requested URL, not merely because the right panel or a blank WebView was created.

Close requests triggered by task switching or component unmounting must include the expected native label. A stale pane may close only the WebView it created; it must not close an instance that was relabeled or adopted by a replacement pane. An inactive task may prepare a hidden ready browser, but it cannot display that browser over the active task.

## Main-interface overlays and address synchronization

The embedded browser is a separate native WebView, so the main React WebView cannot cover it with `z-index`. When a dialog, menu, listbox, or system-level overlay intersects the browser bounds, the browser panel must make the native WebView invisible and restore it after the overlay is removed or no longer intersects. Add `data-embedded-browser-occlusion` when a custom overlay cannot be identified through a semantic role or shared layer class; do not duplicate native visibility calls across feature components.

Page-state polling owns the browser's actual URL, while the address field owns the user's editing draft. While the address field is focused, polling may update page URL state, title, and favicon, but it must not overwrite the draft. Restore the actual URL after focus leaves the field. New navigation and page-state synchronization paths must preserve this boundary.

## WebView Compatibility

- Browser WebViews use a fixed isolated data-store identifier and app data directory. They must not share Wework's main-interface sign-in storage, and the browser settings clear action only targets this store.
- Wegent Agent application tabs in Tauri also use native child WebViews instead of cross-origin iframes. All application tabs share the same fixed data-store identifier, so the complete website storage for an origin, including every `localStorage` key, cookies, and IndexedDB, remains available after closing and reopening a tab or restarting the application. A tab label identifies only the WebView lifecycle; it does not partition storage. On macOS 14 and later, `data_store_identifier` selects the persistent `WKWebsiteDataStore`, while `data_directory` primarily serves other platforms. Do not mirror or restore page storage key by key in the Wework main interface.
- Browser WebViews use a Safari-compatible User-Agent so websites do not treat a WebKit User-Agent without a browser product identifier as an unsupported client.
- Popups, OAuth, SSO, and payment flows may use `window.open` or new-window navigation. Implementations should route them to a controlled browser window or explicitly hand them to the system; the Agent must not operate invisible hidden pages.
- The download handler reads the download directory and ask-before-download preference. Cancelling the system save dialog must cancel that download.
- Page-load events write the current URL into application state. Do not synchronously read the native WebView URL while handling IPC or custom protocols because macOS WebKit may temporarily have no URL while creating or destroying a WebView.
- Page action scripts may only perform behavior that matches the current tool semantics. Do not wrap arbitrary DOM mutations in internal evaluate calls to bypass safety checks.
- macOS App Transport Security permits HTTP only for embedded web content. An invalid server certificate must first fail system trust evaluation; only then may the browser continue that server-trust challenge and publish risk state containing the native WebView identity and origin to the frontend. Register the TLS handler before the first navigation so initial loading cannot race asynchronous `with_webview` configuration. Keep the warning across same-origin pages, and clear it after cross-origin navigation or WebView closure.

## Optional Cloud Desktop Extension

The public Wework codebase defines only cloud-desktop UI slots, the internal-page classifier contract, and an unavailable default implementation. It does not include connection credentials, launch targets, launch orchestration, a concrete remote desktop protocol, authentication endpoint, proxy, page, or third-party client assets. The workbench and device settings use this capability only through `src/extensions/cloud-desktop-contract.ts`; the default implementation sets `available` to `false`, so no desktop action is shown.

Product distributions may provide an implementation for `@extensions/cloud-desktop` at build time. The generic contract exposes `DeviceAction` and `WorkspaceAction` entry points for settings and project workspaces. A concrete implementation owns its connection types, launch target, asynchronous state, and launch orchestration, and must use `isCurrent` to ignore asynchronous requests after the project, device, or connection context changes. Public Wework provides only an unavailable fallback and must not contain concrete remote-desktop protocols, pages, assets, or dedicated copy.

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
cargo check --manifest-path executor/Cargo.toml
cargo check --manifest-path wework/src-tauri/Cargo.toml
cargo test --manifest-path executor/Cargo.toml browser_mcp
cargo test --manifest-path wework/src-tauri/Cargo.toml embedded_browser
pnpm --filter wework e2e:desktop:embedded-browser
```

`e2e:desktop:embedded-browser` must create task A, switch to task B, and then use task A's specific label for the first bridge `open`, `waitFor`, and `inspect`. It verifies that the inactive task completes background navigation before the tool timeout without taking over task B's browser, and that the same page state is visible after switching back to task A. A test that covers only a second open, an active-task open, or a manually exposed browser panel does not exercise the first-open and inactive-task routing races.

When the browser change touches Tauri commands, native WebView behavior, IPC, or the Agent action path, also start an isolated real Tauri session with `pnpm --filter wework ai:verify start` and record evidence for opening a page, inspect, actions, and screenshot. If the full E2E is too slow locally, document why it was not run and make sure CI runs `e2e:desktop:embedded-browser`.

When the Executor Codex launch configuration changes, also run the matching Codex launch config unit tests to verify that the browser MCP server is injected correctly.
