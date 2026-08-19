---
sidebar_position: 25
---

# DeepSeek Harness capability apps

Scope: Wework imports a local DeepSeek Harness plugin package, binds it to one Wework model without modifying Harness source, and runs it in an independent workspace tab.

```mermaid
flowchart LR
    PLUGINS[Plugin center / Manage plugins] --> MANAGE[Harness capabilities section]
    MANAGE --> ZIP
    ZIP[Plugin ZIP] --> VALIDATE[manifest / SHA-256 / path / size validation]
    VALIDATE --> STORE[(Immutable version directory)]
    STORE --> INSTANCE[(Isolated DSH_HOME)]
    RUNTIME[Wework-managed DSH runtime] --> INSTANCE
    MODEL[Wework model] --> PROXY[Local Anthropic Messages proxy]
    PROXY --> INSTANCE
    INSTANCE --> PROCESS[Independent process group and port]
    PROCESS --> TAB[Wework native WebView tab]
    STOP[Stop / uninstall / app exit] --> PROCESS
```

```mermaid
sequenceDiagram
    participant U as User
    participant C as Plugin management
    participant UI as HarnessAppsPage
    participant T as Tauri HarnessAppRuntime
    participant P as Wework model proxy
    participant D as DeepSeek Harness
    participant W as Native WebView

    U->>C: Manage plugins → Harness capabilities
    C->>UI: Preserve plugin-center sidebar and peer navigation
    U->>UI: Select ZIP and fixed model
    UI->>T: preview / install
    T->>T: Validate manifest, hash, and versions
    T->>T: Store package/name/version
    U->>UI: Open capability
    UI->>P: Register fixed model route
    P-->>UI: base URL + token
    UI->>T: start(installation, model route)
    T->>T: Create isolated DSH_HOME and instance patch
    T->>D: plugin add + profile --port
    D-->>T: HTTP ready
    T-->>UI: loopback URL
    UI->>W: Create capability tab
    U->>UI: Stop or uninstall
    UI->>T: stop
    T->>D: Terminate instance process group
    UI->>P: Unregister model route
```

| Edge | Code ownership |
| --- | --- |
| ZIP, manifest, version, and storage validation | `wework/src-tauri/src/harness_apps.rs` |
| Runtime resolution, instance directories, process groups, and ports | `wework/src-tauri/src/harness_apps.rs` |
| Wework model to Anthropic Messages proxy | `wework/src/features/local-harness/localHarnessModels.ts` |
| Plugin-center entry, sidebar, and management section navigation | `wework/src/pages/PluginManagementPage.tsx`, `wework/src/components/plugins/PluginManagementSectionNav.tsx` |
| Installation, management, and lifecycle UI | `wework/src/pages/HarnessAppsPage.tsx` |
| Workspace tabs and native WebViews | `wework/src/App.tsx`, `wework/src/features/workspace-tabs/workspaceTabs.ts` |

Invariants: Harness capability management remains inside the plugin-center management shell and provides explicit routes back to plugin management and the plugin marketplace; DeepSeek Harness source remains read-only; packages are validated before being written to immutable `name/version` directories; the package DSH version range must contain the actual runtime version; every capability instance owns an isolated `DSH_HOME`, port, and process group; the selected model is fixed in the installation record while credentials exist only in the runtime proxy and child environment; starting, stopping, or failing one instance cannot affect another; when no activity API exists, the instance remains resident until an explicit lifecycle event; stop, uninstall, and Wework exit reclaim the complete process group; a tab is created only after HTTP readiness.
