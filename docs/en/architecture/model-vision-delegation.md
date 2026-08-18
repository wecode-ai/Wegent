---
sidebar_position: 30
---

# Text-model vision delegation

Scope: selecting a vision profile, building the sidecar upstream, and replacing images with descriptions before the primary request when Wework runs a DeepSeek V4 Pro/Flash Responses profile through local or cloud Codex execution.

```mermaid
flowchart LR
    PRIMARY[DeepSeek V4 Pro / Flash profile] --> EXPLICIT{Explicit vision profile?}
    EXPLICIT -->|local profile reference| LOCAL[local image-model config]
    EXPLICIT -->|cloud Model CRD reference| CLOUD[visionSidecarModel]
    EXPLICIT -->|no, authenticated| DEFAULT[catalog GPT-5.6 Luna profile]
    EXPLICIT -->|no, signed out| TEXT[remain text-only]
    LOCAL --> CONFIG[Wework vision_sidecar config]
    CLOUD --> CONFIG
    DEFAULT --> CONFIG
    CONFIG --> CATALOG[image-capable primary catalog]
    CATALOG --> EXECUTOR[Executor local-model proxy]
    IMAGE[input_image] --> EXECUTOR
    EXECUTOR --> VISION[vision profile]
    VISION --> DESCRIPTION[bounded text description]
    DESCRIPTION --> DEEPSEEK[DeepSeek primary request]
```

```mermaid
sequenceDiagram
    participant U as User
    participant W as Wework
    participant G as Backend model gateway
    participant E as Executor proxy
    participant V as Vision profile
    participant D as DeepSeek

    U->>W: select DeepSeek profile with an image
    alt explicit sidecar configured
        W->>W: preserve explicit local/cloud reference
    else authenticated DeepSeek V4 Pro/Flash
        W->>W: resolve and bind available GPT-5.6 Luna profile
    else no sidecar available
        W->>W: keep text-model catalog
    end
    W->>E: Responses request + isolated sidecar config
    E->>V: non-streaming image-description request
    V-->>E: text description
    E->>E: remove input_image in place and insert description
    E->>D: text-only primary request
    D-->>E: primary-model response
    E-->>W: Responses events
    W-->>U: model reply
```

| Edge                                      | Code owner                                                 |
| ----------------------------------------- | ---------------------------------------------------------- |
| Save and validate explicit local profile  | `wework/src/features/model-settings/localModelSettings.ts` |
| DeepSeek default in authenticated catalog | `wework/src/api/hybrid/hybridServices.ts`                  |
| Local/cloud reference serialization       | `wework/src/features/workbench/runtimeModelSelection.ts`   |
| Local/cloud sidecar upstream config       | `wework/src/api/local/localServices.ts`                    |
| Catalog image capability                  | `executor/src/server/codex_model_catalog.rs`               |
| Description, cache, limits, replacement   | `executor/src/server/local_model_proxy/vision.rs`          |
| Proxy registration and primary forwarding | `executor/src/server/local_model_proxy/mod.rs`             |
| Local and cloud desktop regressions       | `wework/e2e/desktop/modules/conversation-navigation.mjs`   |

Invariants: an explicit vision profile always overrides the default; the authenticated default applies only to confirmed `deepseek-v4-pro` and `deepseek-v4-flash` Responses models; the default profile must be resolved from the current authenticated cloud catalog by `modelId=gpt-5.6-luna` plus declared image-input capability, preferring a public profile while preserving its actual name, type, namespace, and resource owner; signed-out execution or a catalog without an eligible Luna profile must not synthesize cloud identity or routing; only a primary model with a valid sidecar uses an image-capable catalog, with DeepSeek-specific variants inheriting the primary model's reasoning, tool, context, and output metadata and the generic `wework-vision-sidecar` reserved for other models; the raw image goes only to the vision profile and the DeepSeek primary request receives text only; a sidecar timeout, invalid image, or upstream failure must remove the image and insert an explicit failure description; logs must not contain images, keys, or prompt bodies.

See [Wework settings](../wework/settings.md) for configuration and limits.
