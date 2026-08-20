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
    PANEL -->|创建宿主| WEBVIEW[原生 WebView]
    PANEL -->|同步设备 viewport bounds| WEBVIEW
    WEBVIEW -->|Linux: GtkFixed 固定子视图尺寸| LINUX_HOST[absolute GTK host]
    WEBVIEW --> ENTRY
    WEBVIEW -->|macOS: about:blank Finished| READY[宿主 Ready]
    WEBVIEW -->|其他平台: builder 原子绑定初始 URL| READY
    READY --> BRIDGE
    BRIDGE -->|唯一目标导航| WEBVIEW
    PANEL -->|用户导航意图| LOADING[标签加载动画]
    WEBVIEW -->|on_navigation 接受导航| LOADING[标签加载动画]
    LOADING --> PANEL
    WEBVIEW -->|PageLoadEvent::Finished| LOADED[loaded_url 真值]
    WEBVIEW -->|平台原生导航标识 + 失败回调| FAILED[导航错误真值]
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
    participant W as 原生 WebView
    participant H as HTTP 服务

    C->>B: open(base label, URL)
    B->>S: 解析 logical label
    B->>S: 保存 pending open
    B-->>R: open-request
    R->>W: ensure host（已存在则禁止导航）
    R->>W: 同步设备 viewport bounds
    Note over W: Linux 在 GtkFixed 中按 bounds 分配子 WebView，不能扩展到宿主宽度
    alt macOS 后置导航
        W-->>S: Finished(about:blank)
    else builder 原子绑定初始 URL
        W-->>S: build 完成且无后置导航
    end
    S->>S: Opening -> Ready
    R->>R: 结束一次性 bridge 宿主请求
    B->>W: navigate(URL)
    W-->>S: 接受导航
    S->>S: navigation_generation += 1
    S-->>R: isLoading = true
    R->>R: 标签图标显示加载动画
    Note over R,W: 用户从地址栏或刷新按钮发起导航时，React 在调用原生命令前立即进入加载态
    W->>H: GET URL
    H-->>W: response
    alt 页面成功加载
        W-->>S: Finished(URL)
        S->>S: loaded_url = URL
        S-->>R: isLoading = false
        S-->>B: 导航完成
        B-->>C: success
    else 页面加载失败
        W-->>S: 平台原生导航失败回调(generation, error)
        alt generation 是当前导航
            S->>S: navigation_error = error
            S-->>R: isLoading = false + navigationError
            R->>R: 隐藏原生空白页并显示失败提示
            S-->>B: 导航失败
            B-->>C: error
        else 旧导航延迟失败
            S->>S: 忽略失败，不覆盖当前加载态
        end
    end

    Note over R,W: 后续关闭再由 UI 打开
    R->>W: 直接创建目标 URL 宿主
```

| 边                                            | 代码归属                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| bridge 认证与分发                             | `wework/src-tauri/src/embedded_browser/bridge_server.rs`                  |
| logical-label 路由、pending request、导航真值 | `wework/src-tauri/src/embedded_browser.rs`                                |
| macOS TLS 与导航失败回调                      | `wework/src-tauri/src/embedded_browser_tls.rs`                            |
| Linux 失败回调、子视图定位与尺寸分配          | `wework/src-tauri/src/embedded_browser/linux_host.rs`                     |
| 标签创建、选择和关闭                          | `wework/src/components/layout/DesktopWorkbenchMain.tsx`                   |
| `about:blank` 宿主创建与 UI 状态              | `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx` |
| 多标签真实桌面回归                            | `wework/e2e/desktop/scenarios/embedded-browser-multi-tabs.scenario.mjs`   |

不变量：base label 只负责入口路由；每个标签拥有独立 logical label 和 WebView；bridge 请求只在首次宿主创建期间有效，React 用 ensure-host 创建宿主且复用时禁止导航；macOS 的 `build()` 只代表对象创建，后置 bootstrap `about:blank` 的 `Finished` 才能把宿主从 `Opening` 变为 `Ready`，其他平台由 builder 原子绑定初始 URL，无后置导航竞争；bridge 是首次目标 URL 的唯一后置导航者；用户从地址栏或刷新按钮发起导航时，React 必须在调用原生命令前立即进入加载态，不能等待平台可能延迟或瞬时完成的 `Started` 事件；原生 `on_navigation` 接受导航即递增 `navigation_generation` 并确认加载态，成功 `Finished` 或匹配当前 generation 的非取消导航失败都必须结束加载；平台回调必须保留原生导航标识到 generation 的映射，过期失败即使 URL 与当前导航相同也不得停止当前加载或写入错误；过期页面或失败后合成的 `Finished` 不得覆盖当前导航及失败真值；加载时替换现有标签图标而不增加信息位；设备工具栏的 viewport bounds 必须到达原生子 WebView，Linux 的 `GtkFixed` 子视图不得扩展到宿主宽度；目标 URL 只有当前导航的 `Finished → loaded_url` 才能完成 `open`，失败则返回导航错误；React 必须隐藏失败后的原生空白页并在同一内容位显示错误提示，恢复操作复用现有刷新入口；关闭只能销毁 expected native label。

详细能力与验证说明见 [内置浏览器开发指南](../wework/developer-guide/wework-embedded-browser.md)。
