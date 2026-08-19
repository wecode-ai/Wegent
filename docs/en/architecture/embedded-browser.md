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
    PANEL -->|sync device viewport bounds| WEBVIEW
    WEBVIEW -->|Linux: GtkFixed child size| LINUX_HOST[absolute GTK host]
    WEBVIEW --> ENTRY
    WEBVIEW -->|macOS: about:blank Finished| READY[host Ready]
    WEBVIEW -->|other platforms: builder binds initial URL atomically| READY
    READY --> BRIDGE
    BRIDGE -->|sole destination navigation| WEBVIEW
    WEBVIEW -->|on_navigation accepts navigation| LOADING[tab loading indicator]
    LOADING --> PANEL
    WEBVIEW -->|PageLoadEvent::Finished| LOADED[loaded_url truth]
    WEBVIEW -->|native navigation identity + failure callback| FAILED[navigation error truth]
    LOADED --> BRIDGE
    LOADED --> PANEL
    FAILED --> PANEL
    FAILED --> BRIDGE
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
    R->>W: sync device viewport bounds
    Note over W: Linux allocates the child WebView in GtkFixed and must not expand it to the host width
    alt macOS post-build navigation
        W-->>S: Finished(about:blank)
    else builder binds the initial URL atomically
        W-->>S: build completes with no post-build navigation
    end
    S->>S: Opening -> Ready
    R->>R: finish one-shot bridge host request
    B->>W: navigate(URL)
    W-->>S: accept navigation
    S->>S: navigation_generation += 1
    S-->>R: isLoading = true
    R->>R: replace the tab icon with a spinner
    W->>H: GET URL
    H-->>W: response
    alt page loads successfully
        W-->>S: Finished(URL)
        S->>S: loaded_url = URL
        S-->>R: isLoading = false
        S-->>B: navigation complete
        B-->>C: success
    else page load fails
        W-->>S: native platform navigation failure callback(generation, error)
        alt generation is current
            S->>S: navigation_error = error
            S-->>R: isLoading = false + navigationError
            R->>R: hide the native blank page and show the failure state
            S-->>B: navigation failed
            B-->>C: error
        else delayed failure from an older navigation
            S->>S: ignore failure and preserve current loading
        end
    end

    Note over R,W: later UI reopen after closure
    R->>W: create host directly at destination URL
```

| Edge                                                      | Code owner                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| Bridge authentication and dispatch                        | `wework/src-tauri/src/embedded_browser/bridge_server.rs`                  |
| Logical-label routing, pending request, navigation truth  | `wework/src-tauri/src/embedded_browser.rs`                                |
| macOS TLS and navigation-failure callbacks                | `wework/src-tauri/src/embedded_browser_tls.rs`                            |
| Linux failure callback, child positioning, and allocation | `wework/src-tauri/src/embedded_browser/linux_host.rs`                     |
| Tab creation, selection, and closure                      | `wework/src/components/layout/DesktopWorkbenchMain.tsx`                   |
| `about:blank` host creation and UI state                  | `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx` |
| Real-desktop multi-tab regression                         | `wework/e2e/desktop/scenarios/embedded-browser-multi-tabs.scenario.mjs`   |

Invariants: a base label is only a routing entry; every tab owns a distinct logical label and WebView; a bridge request is valid only while its first host is being created, and React uses ensure-host semantics that never navigate an existing host; on macOS, `build()` means only that the object exists, so the post-build bootstrap `about:blank` must emit `Finished` before `Opening → Ready`; other platforms bind the initial URL atomically in the builder and have no post-build navigation race; the bridge solely owns the first post-build destination navigation; native `on_navigation` acceptance increments `navigation_generation` and starts tab loading, and either successful `Finished` or a non-cancellation failure matching the current generation must end it; platform callbacks must preserve the native-navigation-to-generation mapping, and a stale failure must not stop current loading or write an error even when its URL equals the current navigation; stale-page or post-failure synthetic `Finished` events must never overwrite the current navigation or failure truth; loading replaces the existing tab icon instead of adding another information slot; the device-toolbar viewport bounds must reach the native child WebView, and Linux must not expand the `GtkFixed` child to the host width; only the current navigation's `Finished → loaded_url` completes `open`, while failure returns a navigation error; React must hide the failed native blank page and use the same content slot for a failure message, with recovery reusing the existing reload action; close may destroy only the expected native label.

See the [embedded-browser developer guide](../wework/developer-guide/wework-embedded-browser.md) for capabilities and verification details.
