---
sidebar_position: 30
---

# Text-model vision delegation

Scope: when Wework runs an image-bearing Codex request with a text-only model, it constructs a sidecar only from the explicit vision-model reference in the Model CRD and replaces images with text descriptions before the primary request. DeepSeek V4 Pro/Flash are the first integrations that preserve their own catalog capabilities while delegation is enabled.

```mermaid
flowchart LR
    CRD[Text Model CRD] --> REF{modelConfig.visionSidecarModel complete and valid?}
    REF -->|No| TEXT[Text-only catalog]
    TEXT --> DIRECT[No sidecar configuration]
    REF -->|Yes| OPTION[Wework hidden execution option]
    OPTION --> CONFIG[Isolated vision_sidecar upstream config]
    CONFIG --> CATALOG{DeepSeek V4 catalog?}
    CATALOG -->|Yes| DEEPSEEK[Matching DeepSeek vision catalog]
    CATALOG -->|No| GENERIC[Generic vision-sidecar catalog]
    DEEPSEEK --> EXECUTOR[Executor local model proxy]
    GENERIC --> EXECUTOR
    IMAGE[input_image] --> EXECUTOR
    EXECUTOR --> VISION[Explicitly referenced vision model]
    VISION --> DESCRIPTION[Bounded text description]
    DESCRIPTION --> PRIMARY[Text-only primary model]
```

```mermaid
sequenceDiagram
    participant U as User
    participant W as Wework
    participant E as Executor proxy
    participant V as Referenced vision model
    participant P as Text-only primary model

    U->>W: Select model and send message
    alt visionSidecarModel is complete and valid
        W->>E: Primary config + vision_sidecar
        opt Message contains images
            E->>V: Non-streaming image-description request
            V-->>E: Text description
            E->>E: Remove input_image in place and insert description
        end
        E->>P: Text-only primary request
    else Reference is absent or invalid
        W->>E: Primary config only
        E->>P: No additional vision-model call
    end
    P-->>U: Primary-model response
```

| Edge                                             | Code ownership                                           |
| ------------------------------------------------ | -------------------------------------------------------- |
| Cloud explicit-reference editing and constraints | `frontend/src/features/settings/`                        |
| Safe Model CRD config aggregation                | `backend/app/services/model_aggregation_service.py`      |
| Cloud-reference validation and hidden option     | `wework/src/features/workbench/runtimeModelSelection.ts` |
| Local/cloud sidecar upstream and catalog choice  | `wework/src/api/local/localServices.ts`                  |
| DeepSeek text and delegated-vision catalogs      | `shared/assets/codex-models/deepseek.json`               |
| Image description, cache, limits, replacement    | `executor/src/server/local_model_proxy/vision.rs`        |
| Proxy registration and primary forwarding        | `executor/src/server/local_model_proxy/mod.rs`           |
| Cloud Model to Codex catalog identity mapping    | Wework runtime selection and Backend trigger paths       |

Invariants: the vision model comes only from an explicit `modelConfig.visionSidecarModel` reference and is never selected automatically from sign-in state, model names, or defaults; an absent or structurally invalid reference must not configure a sidecar, advertise image capability, or make an additional model call; the explicit reference contains model name, type, namespace, resource owner, and protocol while Wework receives no credentials; only DeepSeek V4 Pro/Flash models with a configured sidecar use their matching vision catalog, while unconfigured models remain text-only; the original image reaches only the referenced vision model and the primary model receives text; sidecar timeouts, invalid images, or upstream failures remove the original image and insert an explicit failure description; logs contain no images, credentials, or prompt bodies.

See [Wework settings](../wework/settings.md) for configuration and limits.
