---
sidebar_position: 25
---

# Smart apps (DeepSeek Harness runtime)

Scope: Wework imports a DeepSeek Harness package as a Smart app, binds it to one Wework model without modifying Harness source, and runs it in an independent workspace tab.

```mermaid
flowchart LR
    EXPERIMENT[Experimental features toggle] --> PLUS[Top tab bar +]
    EXPERIMENT --> APPS[Applications workspace]
    EXPERIMENT --> ROUTES[Smart app view and resident restoration]
    PLUS --> APPS
    APPS --> SITES[Sites]
    APPS --> MINIAPP[Mini Programs]
    APPS --> MARKET[Smart apps]
    ROUTES --> MARKET
    MARKET --> BUILDER[Smart App Builder plugin]
    BUILDER --> DISCOVER[DSH setup / discovery / composition]
    DISCOVER --> BROWSER[Wework built-in browser verification]
    BROWSER --> ZIP
    MARKET --> INSTALLED[Installed Smart apps]
    MARKET --> ZIP
    INSTALLED --> ZIP
    ZIP[Smart app ZIP] --> VALIDATE[manifest / SHA-256 / path / size validation]
    VALIDATE --> STORE[(Immutable version directory)]
    STORE --> INSTANCE[(Isolated DSH_HOME)]
    STAGING[DSH runtime staging directory] --> SIGN[macOS Mach-O pre-signing]
    SIGN --> RUNTIME[Single-file Wework-managed DSH runtime archive]
    RUNTIME --> EXTRACT[(Content-addressed extraction)]
    EXTRACT --> INSTANCE
    MODEL[Wework model] --> PROXY[Local Anthropic Messages proxy]
    INSTALLED --> MODEL
    PROXY --> INSTANCE
    INSTANCE --> PROCESS[Independent process group and port]
    PROCESS --> MOTION[App-to-tab launch motion]
    MOTION --> TAB[Wework native WebView tab]
    RESIDENT[Resident setting] --> STARTUP[Main-window startup manager]
    STARTUP --> MODEL
    STARTUP --> PROCESS
    STARTUP --> TAB
    STOP[Stop / uninstall / app exit] --> PROCESS
```

```mermaid
sequenceDiagram
    participant U as User
    participant C as Top tab bar
    participant A as Applications workspace
    participant M as Smart apps view
    participant B as Smart App Builder
    participant WB as Wework built-in browser
    participant UI as HarnessAppsPage
    participant T as Tauri HarnessAppRuntime
    participant P as Wework model proxy
    participant D as DeepSeek Harness
    participant W as Native WebView

    U->>C: + → Smart apps
    C->>A: Open the Applications workspace
    A->>M: Select Smart apps beside Sites and Mini Programs
    alt Create a Smart app
        U->>M: Create Smart app
        M->>B: Start a new chat with smart-app-builder
        B->>B: Prepare DSH, discover plugins, and compose the app
        B->>WB: Launch the local profile and verify its primary flow
        B-->>U: Produce a validated ZIP
    else Use an existing package
        U->>M: Import a local package or open Installed
    end
    M->>UI: Open installed Smart apps
    U->>UI: Select ZIP and model
    UI->>T: preview / install
    T->>T: Validate manifest, hash, and versions
    T->>T: Store package/name/version
    U->>UI: Change the bound model while stopped or enable Resident
    UI->>T: update(modelKey / resident)
    U->>UI: Open capability
    UI->>P: Register the currently bound model route
    P-->>UI: base URL + token
    UI->>T: start(installation, model route)
    T->>T: Create isolated DSH_HOME and instance patch
    T->>D: plugin add + profile --port
    D-->>T: HTTP ready
    T-->>UI: loopback URL
    UI->>W: Animate into the tab strip and create the app tab
    U->>UI: Stop or uninstall
    UI->>T: stop
    T->>D: Terminate instance process group
    UI->>P: Unregister model route

    opt Next Wework launch and app is Resident
        UI->>T: list
        T-->>UI: resident installation
        UI->>P: Register bound model route
        UI->>T: start
        UI->>W: Open the app tab automatically
    end
```

| Edge                                                                           | Code ownership                                                                                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ZIP, manifest, version, and storage validation                                 | `wework/src-tauri/src/harness_apps.rs`                                                                                                       |
| Runtime archive, content fingerprint, macOS pre-signing, and build preparation | `wework/scripts/prepare-deepseek-harness-runtime.mjs`, `wework/scripts/lib/deepseek-harness-signing.mjs`, `wework/src-tauri/tauri.conf.json` |
| Runtime extraction, instance directories, process groups, and ports            | `wework/src-tauri/src/harness_apps.rs`                                                                                                       |
| Wework model to Anthropic Messages proxy                                       | `wework/src/features/local-harness/localHarnessModels.ts`                                                                                    |
| Top tab bar entry                                                              | `wework/src/features/workspace-tabs/WorkspaceTabStrip.tsx`                                                                                   |
| Applications workspace and Sites / Mini Programs / Smart apps navigation       | `wework/src/pages/SitesPage.tsx`, `wework/src/components/sites/SitesWorkspace.tsx`                                                           |
| Smart app marketplace and Marketplace / Installed navigation                   | `wework/src/pages/SmartAppsMarketplacePage.tsx`, `wework/src/components/smart-apps/SmartAppsSectionNav.tsx`                                  |
| Smart app creation workflow plugin                                             | `wework/src-tauri/bundled-plugins/wework-personal/plugins/smart-app-builder/`                                                                |
| Installation, management, and lifecycle UI                                     | `wework/src/pages/HarnessAppsPage.tsx`                                                                                                       |
| Resident app startup restoration                                               | `wework/src/features/harness-apps/ResidentSmartAppsManager.tsx`                                                                              |
| App-to-tab launch motion                                                       | `wework/src/features/harness-apps/smartAppLaunchAnimation.ts`, `wework/src/styles/globals.css`                                               |
| Workspace tabs and native WebViews                                             | `wework/src/App.tsx`, `wework/src/features/workspace-tabs/workspaceTabs.ts`                                                                  |

Invariants: all user-facing names use “Smart apps,” while DeepSeek Harness appears only as a runtime implementation detail; Smart apps belong to the Applications workspace and must appear as a peer application type beside Sites and Mini Programs, while the plugin marketplace and plugin management page do not host Smart app management UI; `smart-app-builder` may exist as a development-tool plugin, but its product entry belongs to the experimental Smart app marketplace, its workflow keeps DSH source read-only, composes external plugin packages, verifies them in the Wework built-in browser, and ends installation through native preview, version validation, and model confirmation instead of editing the local installation registry; the entire Smart apps feature is experimental, so when the toggle is off the top “+” and Applications workspace expose no Smart apps entry, direct visits to `/sites?app_type=smart_app` and stale app tabs leave the feature, and resident apps are not restored; when enabled, `/sites?app_type=smart_app` owns the Smart app marketplace and installed management views, while running apps use independent tabs, with no mixing of the Applications workspace, management view, and runtime tab responsibilities; top tab bar “+ → Smart apps” opens the Smart apps type inside Applications, while the workspace tab title remains “Applications”; DeepSeek Harness source remains read-only; build output packages the DSH runtime as one managed archive, Tauri must not recursively watch or register its `node_modules`, and runtime extraction is content-addressed under app data and validates the executable entry before use; production macOS builds sign every Mach-O file in the staging directory with a Developer ID, secure timestamp, and hardened runtime before creating the archive, and the signing mode and identity are part of the content fingerprint so an unsigned archive or one signed by another identity is never reused; packages are validated before being written to immutable `name/version` directories; the package DSH version range must contain the actual runtime version; every Smart app instance owns an isolated `DSH_HOME`, port, and process group; the bound model is persisted and can only be changed while the app is stopped, while credentials exist only in the runtime proxy and child environment; Resident means that the main window automatically starts the app and opens its tab once per Wework launch; a normal Open action animates from the app card into the top tab strip after HTTP readiness and before tab creation, while reduced-motion preferences skip the animation; starting, stopping, or failing one instance cannot affect another; stop, uninstall, disabling experimental features, and Wework exit reclaim the complete process group.
