---
sidebar_position: 20
---

# Embedded-browser navigation and tabs

Scope: first page open through the bridge by an Agent or test, plus routing, load truth, and closure for multiple right-workspace browser tabs.

```mermaid
flowchart LR
    CALLER[E2E / Browser MCP] --> BRIDGE[authenticated loopback bridge]
    BRIDGE --> ROUTE[active_tabs / agent_tabs]
    ROUTE --> ENTRY[(logical label entry)]
    BRIDGE -->|host absent| PENDING[(pending_open_requests)]
    PENDING --> MAIN[DesktopWorkbenchMain]
    MAIN --> PANEL[WorkspaceBrowserPanel]
    PANEL -->|create host| WEBVIEW[native WebView]
    WEBVIEW --> ENTRY
    WEBVIEW -->|macOS: about:blank Finished| READY[host Ready]
    WEBVIEW -->|other platforms: builder binds initial URL atomically| READY
    READY --> BRIDGE
    BRIDGE -->|sole destination navigation| WEBVIEW
    WEBVIEW -->|PageLoadEvent::Finished| LOADED[loaded_url truth]
    LOADED --> BRIDGE
    LOADED --> PANEL
    MAIN -->|set_active_tab| ROUTE
    MAIN -->|expected native label| CLOSE[close / close_many]
    CLOSE --> ENTRY
```

```mermaid
sequenceDiagram
    participant C as E2E / Browser MCP
    participant B as bridge
    participant S as EmbeddedBrowserState
    participant R as React
    participant W as native WebView
    participant H as HTTP service

    C->>B: open(base label, URL)
    B->>S: resolve logical label
    B->>S: persist pending open
    B-->>R: open-request
    R->>W: ensure host (never navigate an existing host)
    alt macOS post-build navigation
        W-->>S: Finished(about:blank)
    else builder binds the initial URL atomically
        W-->>S: build completes with no post-build navigation
    end
    S->>S: Opening -> Ready
    R->>R: finish one-shot bridge host request
    B->>W: navigate(URL)
    W->>H: GET URL
    H-->>W: response
    W-->>S: Finished(URL)
    S->>S: loaded_url = URL
    S-->>B: navigation complete
    B-->>C: success

    Note over R,W: later UI reopen after closure
    R->>W: create host directly at destination URL
```

| Edge                                                     | Code owner                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Bridge authentication and dispatch                       | `wework/src-tauri/src/embedded_browser/bridge_server.rs`                  |
| Logical-label routing, pending request, navigation truth | `wework/src-tauri/src/embedded_browser.rs`                                |
| Tab creation, selection, and closure                     | `wework/src/components/layout/DesktopWorkbenchMain.tsx`                   |
| `about:blank` host creation and UI state                 | `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx` |
| Real-desktop multi-tab regression                        | `wework/e2e/desktop/scenarios/embedded-browser-multi-tabs.scenario.mjs`   |

Invariants: a base label is only a routing entry; every tab owns a distinct logical label and WebView; a bridge request is valid only while its first host is being created, and React uses ensure-host semantics that never navigate an existing host; on macOS, `build()` means only that the object exists, so the post-build bootstrap `about:blank` must emit `Finished` before `Opening → Ready`; other platforms bind the initial URL atomically in the builder and have no post-build navigation race; the bridge solely owns the first post-build destination navigation; only destination `Finished → loaded_url` completes `open`; close may destroy only the expected native label.

See the [embedded-browser developer guide](../wework/developer-guide/wework-embedded-browser.md) for capabilities and verification details.
