---
sidebar_position: 20
---

# 内置浏览器导航与多标签

范围：Agent/测试通过 bridge 首次打开页面，以及右侧多个浏览器标签的路由、加载真值和关闭。

```mermaid
flowchart LR
    CALLER[E2E / Browser MCP] --> BRIDGE[认证 loopback bridge]
    BRIDGE --> ROUTE[active_tabs / agent_tabs]
    ROUTE --> ENTRY[(logical label entry)]
    BRIDGE -->|宿主不存在| PENDING[(pending_open_requests)]
    PENDING --> MAIN[DesktopWorkbenchMain]
    MAIN --> PANEL[WorkspaceBrowserPanel]
    PANEL -->|仅创建 about:blank 宿主| WEBVIEW[原生 WKWebView]
    WEBVIEW --> ENTRY
    BRIDGE -->|宿主 Ready 后唯一目标导航| WEBVIEW
    WEBVIEW -->|PageLoadEvent::Finished| LOADED[loaded_url 真值]
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
    participant W as WKWebView
    participant H as HTTP 服务

    C->>B: open(base label, URL)
    B->>S: 解析 logical label
    B->>S: 保存 pending open
    B-->>R: open-request
    R->>W: 创建 about:blank 宿主
    W->>S: Opening -> Ready
    R->>R: 结束一次性 bridge 宿主请求
    B->>W: navigate(URL)
    W->>H: GET URL
    H-->>W: response
    W-->>S: Finished(URL)
    S->>S: loaded_url = URL
    S-->>B: 导航完成
    B-->>C: success

    Note over R,W: 后续关闭再由 UI 打开
    R->>W: 直接创建目标 URL 宿主
```

| 边                                            | 代码归属                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| bridge 认证与分发                             | `wework/src-tauri/src/embedded_browser/bridge_server.rs`                  |
| logical-label 路由、pending request、导航真值 | `wework/src-tauri/src/embedded_browser.rs`                                |
| 标签创建、选择和关闭                          | `wework/src/components/layout/DesktopWorkbenchMain.tsx`                   |
| `about:blank` 宿主创建与 UI 状态              | `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx` |
| 多标签真实桌面回归                            | `wework/e2e/desktop/scenarios/embedded-browser-multi-tabs.scenario.mjs`   |

不变量：base label 只负责入口路由；每个标签拥有独立 logical label 和 WebView；bridge 请求只在首次宿主创建期间有效，React 创建 `about:blank` 后必须结束该一次性请求；bridge 是首次目标 URL 的唯一导航者，后续 UI 重建直接使用当前目标 URL；`Ready` 不等于加载成功，只有 `Finished → loaded_url` 可以完成 `open`；关闭只能销毁 expected native label。

详细能力与验证说明见 [内置浏览器开发指南](../wework/developer-guide/wework-embedded-browser.md)。
