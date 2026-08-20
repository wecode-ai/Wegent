---
sidebar_position: 25
---

# Wework host plugin runtime

Scope: product composition, dynamic installation, lifecycle, UI contributions, desktop sidecars, and failure recovery for Wework React and Tauri, excluding the Executor implementation. Backend owns packages, account desired state, and device actual state, but never executes plugin code.

```mermaid
flowchart LR
    PROFILE[client-version-pinned profile] --> CONTEXT[Cordis Context]
    DESIRED[(InstalledPlugin account desired state)] --> HOST[dynamic plugin host]
    ROOTS[device plugin directory actual state] --> SCAN[Tauri manifest and SHA-256 validation]
    SCAN --> HOST
    HOST --> MODULE[same-realm ESM frontend module]
    HOST --> SIDECAR[desktop sidecar]
    MODULE --> CONTEXT
    CONTEXT --> ROUTES[Routes]
    CONTEXT --> APPS[Apps]
    CONTEXT --> SETTINGS[Settings]
    CONTEXT --> SLOTS[React UI Slots]
    SIDECAR <-->|JSON-RPC stdio| TAURI[Tauri sidecar host]
    CONTEXT --> EXECUTOR[Executor protocol boundary]
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
    C->>U: register built-in routes, apps, settings, and slots
    B->>D: enabled Wework plugin names
    D->>T: scan device plugin roots
    T->>T: canonicalize paths and verify SHA-256
    T-->>D: valid local manifests and entry paths
    D->>F: import selected ESM entry in the host realm
    F->>C: activate(plugin API)
    C->>U: publish reactive contributions

    alt activation failure
        C->>U: dispose the failed plugin fiber
        D->>S: stop a started sidecar
    end

    F->>S: optionally start or call a desktop capability
    S-->>F: JSON-RPC result
    B->>D: disable, uninstall, or update desired state
    D->>C: dispose plugin fiber
    C->>U: remove contributions and notify subscribers
    D->>S: stop process
```

| Edge                                                                          | Code owner                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Context, services, and plugin fibers                                          | Pinned `@deepseek-ai/cordis`                                       |
| Wework routes, apps, settings, slots, and SDK                                 | `wework/src/plugin-runtime/`                                       |
| React slot contracts and React 19 renderer                                    | `wework/src/plugin-runtime/slots.tsx`                              |
| Built-in required profile and product entrypoints                             | `wework/src/plugins/`                                              |
| Manifest scan, path/SHA-256 checks, sidecar lifecycle                         | `wework/src-tauri/src/workbench_plugins.rs`                        |
| Plugin manifests, account desired state, and device installation actual state | Backend plugin schemas/services and device capability sync         |
| Executor startup and protocol transport                                       | Existing Executor bridge; Executor internals are outside this flow |

Invariants: the product entrypoint loads only a profile and never enumerates concrete features; every registration belongs to a Cordis effect, and unloading may leave no route, slot, setting, app, listener, or process behind; React, ReactDOM, Cordis, and the Wework Plugin SDK have exactly one host instance across frontend plugins; required plugins must be pinned by the client profile to an exactly matching `clientVersion` and account desired state cannot disable them; optional plugins load only when the account enables them and the current device has a valid manifest with matching content hashes; dynamic registration and unloading must notify React subscribers; packages without `.wework-plugin/plugin.json` remain valid Executor capability plugins; frontend plugins execute in the same JavaScript realm with host-page authority, so SHA-256 proves content integrity but not publisher identity or permission isolation; sidecars may start only from verified files inside their package root and the requested plugin ID must match the manifest; Backend never loads or executes plugin code.
