---
sidebar_position: 25
---

# Wework 宿主插件运行时

范围：Wework React 与 Tauri 中除 Executor 实现之外的产品功能装配、动态插件安装、生命周期、UI 贡献、桌面 sidecar 和故障恢复。Backend 只拥有插件包、账号期望态和设备实态，不执行插件代码。

```mermaid
flowchart LR
    PROFILE[客户端版本锁定 profile] --> CONTEXT[Cordis Context]
    DESIRED[(InstalledPlugin 账号期望态)] --> HOST[动态插件宿主]
    ROOTS[设备插件目录实态] --> SCAN[Tauri 清单与 SHA-256 校验]
    SCAN --> HOST
    HOST --> MODULE[同 realm ESM 前端模块]
    HOST --> SIDECAR[桌面 sidecar]
    MODULE --> CONTEXT
    CONTEXT --> ROUTES[Routes]
    CONTEXT --> APPS[Apps]
    CONTEXT --> SETTINGS[Settings]
    CONTEXT --> SLOTS[React UI Slots]
    SIDECAR <-->|JSON-RPC stdio| TAURI[Tauri sidecar host]
    CONTEXT --> EXECUTOR[Executor 协议边界]
```

```mermaid
sequenceDiagram
    participant P as Profile
    participant B as InstalledPlugin
    participant D as Dynamic plugin host
    participant T as Tauri scanner
    participant C as Cordis Context
    participant F as Frontend module
    participant S as Desktop sidecar
    participant U as React slot renderer

    P->>C: apply required entries with exact clientVersion
    C->>U: register built-in routes, apps, settings and slots
    B->>D: enabled Wework plugin names
    D->>T: scan device plugin roots
    T->>T: canonicalize paths and verify SHA-256
    T-->>D: valid local manifests and entry paths
    D->>F: import selected ESM entry in host realm
    F->>C: activate(plugin API)
    C->>U: publish reactive contributions

    alt activation failure
        C->>U: dispose the failed plugin fiber
        D->>S: stop a started sidecar
    end

    F->>S: optionally start or call desktop capability
    S-->>F: JSON-RPC result
    B->>D: disable, uninstall, or update desired state
    D->>C: dispose plugin fiber
    C->>U: remove contributions and notify subscribers
    D->>S: stop process
```

| 边                                              | 代码归属                                                  |
| ----------------------------------------------- | --------------------------------------------------------- |
| Context、service 和插件 fiber                   | 固定版本的 `@deepseek-ai/cordis`                          |
| Wework routes、apps、settings、slots 和 SDK     | `wework/src/plugin-runtime/`                              |
| React slot 合同和 React 19 renderer             | `wework/src/plugin-runtime/slots.tsx`                     |
| 内置 required profile 和产品插件入口            | `wework/src/plugins/`                                     |
| 清单扫描、路径与 SHA-256 校验、sidecar 生命周期 | `wework/src-tauri/src/workbench_plugins.rs`               |
| 插件清单、账号期望态和设备安装实态              | Backend plugin schemas/services 和 device capability sync |
| Executor 的启动和协议传输                       | 现有 Executor bridge；Executor 内部不属于本流程           |

不变量：产品入口只加载 profile，不枚举具体功能；所有注册必须属于一个 Cordis effect，插件卸载后不得残留 route、slot、settings、app、listener 或进程；React、ReactDOM、Cordis 和 Wework Plugin SDK 在所有前端插件中只有一个宿主实例；required 插件必须随客户端 profile 锁定到完全一致的 `clientVersion`，且不能由账号期望态禁用；可选插件同时满足账号启用和当前设备存在、清单有效、内容哈希匹配才会加载；动态注册和卸载必须通知 React 订阅者；没有 `.wework-plugin/plugin.json` 的旧包仍是合法 Executor capability plugin；前端插件在同一 JS realm 运行，拥有宿主页面权限，SHA-256 只证明内容完整性，不构成发布者身份或权限隔离；sidecar 只能从包根目录内的已校验文件启动，插件 ID 必须与清单一致；Backend 不加载或执行插件代码。
