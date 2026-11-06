---
sidebar_position: 1
---

# Wework product operations for AI

Issue: WEWORK2D8526-43. Source baseline: `f0482a994d55191f82dd211ccd12e090ae741b8e`.

The sections after the implementation record retain the original full-product proposal. They are not an implemented capability inventory. The [Chinese plan](WEWORK2D8526-43-ai-workbench-control.md) contains the detailed inventory and verification matrix.

Updated to `origin/main` commit `5e380fe5934872ca896b147ae50ecb376dbc8503` on 2026-10-27. The new stand-in MCP and scheduler paths are preserved. Stand-in identities and external connection work retain their scoped tools and confirmation flow without receiving personal control.

Updated again to `66e6e3e8a9fe94cf405960e12740cf56c1f9e704` on 2026-10-28, preserving the latest CI shards and Runtime dispatcher split. Creation intent and model-profile synchronization use the new boxed RPC dispatcher. Claude retains both upstream artifact instructions and personal-control instructions, with delegated execution restrictions intact.

## Implemented managed wework_control

Local APP conversations bound to cloud projects are created and continued locally. Existing `/runtime-work/materialize` compiles `projectId`, uploaded `attachmentIds` and project execution permissions before existing local Runtime dispatch. Both creation and continuation check current project/Issue visibility and execute authority, including Viewer denial for project-only bindings without an Issue. Other devices retain Backend remote-control policy. Authorized IM continuation reuses its existing APP messaging grant to read original identity; ordinary HTTP callers gain no remote control. No HTTP API or RPC was added.

The Executor now exposes 30 application tools plus `list_capabilities`, `describe_capability` and `invoke_capability`. Personal Codex/Claude conversations and personal scheduled runs receive the managed MCP automatically, without a separate MCP setup or personal API key.

Ordinary follow-ups reuse the personal-control transport only while device, task address, Backend, credentials and origin remain identical. This preserves the native thread, background processes and subscriptions. Every call still validates its binding and resolves the current execution context. Authority changes use the existing MCP reload path; project grants and restricted executions retain execution-scoped contexts.

Continuation identity uses the existing transcript's `conversationContextOnly` projection with a one-message limit, preserving the original workspace, Runtime and origin. Codex and Claude share the same canonical-identity and project-execution permission checks.

Cloud-bound conversation checks reuse `/runtime-work/transcript` with its top-level `deviceId`, `taskId` and `workspacePath` fields. Listings and searches expose `coverage.unavailable_reasons` to distinguish invalid Backend requests, denied access, connectivity failures and authorization timeouts; incomplete results do not establish that a conversation is absent. Regressions cover strict request parsing, Chinese title search and mixed allowed/denied matches. The existing `workbench-control` CI checkpoint also covers creation and discovery through the real cloud Backend.

Implemented operations cover federated conversation listing, pagination, full-history search, safe metadata and history reads, plus explicit-device creation and continuation on this device and other owned online devices, plus owning-device rename, archive, cancellation and guidance; goals/supervisors can be read or cleared. Explicit PR/MR bindings are persisted on the Runtime and resolve as unique, missing or ambiguous. Schedule CRUD, version checks, enable/disable, immediate runs and run history reuse the existing scheduler. Five minutes is `{"type":"interval","value":5,"unit":"minutes"}`.

```mermaid
flowchart LR
  AI[Codex / Claude] --> MCP[Executor managed HTTP MCP]
  MCP --> Auth[Execution context and role checks]
  Auth --> Control[wework_control contracts and dispatch]
  Control --> Runtime[Existing Runtime handlers]
  Control --> Backend[Existing Backend APIs for cloud-bound operations]
  Backend --> Runtime
  Control --> Journal[Durable delivery receipts]
  Runtime --> Native[Original native session and workspace]
  Runtime --> Store[Runtime index and PR bindings]
  Runtime --> Scheduler[Existing AutomationStore and scheduler]
  Scheduler --> AI
```

This reuses the existing managed MCP host instead of adding a DSH resident service. HTTP sessions bind the instance bearer, MCP surface and context handle. Delegated runs cannot acquire personal control. A personal controller may continue an authorized target while retaining the target's original identity and execution scope. Project-space operations remain with `wework_space`; cloud-bound operations use existing backend entry points.

Continuation journals a stable request key and a fingerprint of the message and normalized queue policy before delivery, then persists its acceptance receipt. Identical requests return the original receipt, changed delivery arguments conflict, and uncertain pending/needs_attention states are never blindly replayed. This distinguishes delivery acceptance from execution completion and does not claim atomic exactly-once execution across crashes.

New schedules persist execution intent and a source conversation reference, not copied credentials. Runs compile the current profile, refresh cloud models through the existing authorized catalog/gateway and use native account configuration. Unrecoverable custom local model configuration after restart returns `model_configuration_required` explicitly.

Conversation queries default to the **current device, personal cloud history returned by existing APIs and other owned devices, including cloud and remote runtimes**. No HTTP endpoint or device RPC is added. Discovery reuses `GET /api/devices`; remote reads use the desktop's `/wework-runtime` namespace and `runtime:request`, calling existing `runtime.tasks.list/get/transcript/transcript.search` and `runtime.archived_conversations.list` methods. Existing authorization, device ownership, live routing and remote-control policies remain authoritative. Stored cloud history uses the existing `GET /api/tasks`, `GET /api/tasks/archived`, `GET /api/tasks/{id}` and `GET /api/subtasks` APIs, traversing every message page instead of treating the task detail's latest 100 messages as complete. No Backend handler, route or database read path is added.

Native continuation supports this device and other owned devices under the existing Backend policy. It reads the target workspace, model and Team binding through `runtime.tasks.get`, checks current transcript authorization and persisted origin through `/runtime-work/transcript`, and reuses `/runtime-work/send`. That existing send entry resolves original identity, workspace and Runtime through the same transcript read and uses the frontend materialization compiler. Continuations share existing project/Issue visibility and execute permission services. Delegated targets retain their original role; stand-in targets retain confirmation requirements. Neither receives personal-control tools. The owning Runtime preserves delegated origin and project/Issue binding against omitted, null or forged follow-up identity. No caller profile, API or RPC is added; remote-control, offline and permission failures remain in force.

```mermaid
flowchart LR
  UI[Frontend continuation] --> Compile[Existing execution compiler]
  AI[Personal AI] --> Send[Existing runtime-work/send]
  Send --> Read[Existing authorized transcript and original identity]
  Read --> Compile
  Compile --> Auth[Existing project and Issue visibility and execute checks]
  Auth --> Runtime[Existing runtime.tasks.send]
  Runtime --> Identity[Original session and target scope]
```

Receipts record the target `device_id` and keys are scoped to the target device and task. Pending or uncertain deliveries are never resent automatically. `get_operation` returns the persisted remote receipt without attaching a same-named local task; `read_conversation` reads the remote content. `cloudconv_` history references without a Runtime address remain read-only.

Delegated targets without a valid project/Issue execution scope remain denied. Denials identify the triggering `origin` field and a bounded classification without exposing arbitrary values or dispatch IDs. They are not login or system-approval requests. Empty-string and non-string delegation markers remain rejected, and delegated callers remain excluded from personal control.

The frontend's existing transcript read path also records bounded origin marker classifications through the existing diagnostic log. It adds no requests and logs no message content or arbitrary origin values, allowing comparison with the metadata read by AI. Missing diagnostic evidence does not establish personal origin or restored access.

Creation model profile publication belongs only to trusted local IPC. The shared model preparer's cloud adapter runs the existing catalog preparation without calling `runtime.models.sync_creation_profiles`, so desktop creation profiles and credentials are not published remotely and existing remote sends require no new method. Protocol tests use a remote stub that rejects this method to verify preparation and original-task sending, while retaining local refresh, deletion and failure-gating tests.

The existing `workbench-control` E2E also opens the original remote conversation after AI creation and continuation, sends another turn through the desktop composer, and asserts the response and unchanged device, task and workspace bindings. The existing CI runner schedules this checkpoint through dynamic shards.

Other mutations remain on the owning device. Creation accepts explicit remote targets permitted by existing Backend policy. Cloud Issue PR bindings remain authoritative in project-space services; branch guesses and historical URLs do not become confirmed bindings. Settings writes, plugin installation, window navigation and attachment upload management remain proposal items. Existing `gh` tools check CI; callers construct stable repo/PR/head SHA/run/attempt keys. Research sections 1–9 remain a proposal.

The desktop and AI share the complete native catalog collector and traverse every provider page beyond the former 500-item sidebar limit. Catalog errors and repeated cursors produce `native_catalog_unavailable`. Existing remote catalog responses remain readable without an AI-specific RPC. A failed history search contributes missing coverage while preserving other successful results.

Remote listing, search and history reads use the current `ConnectionConfig.socket_url` published by the desktop connection controller, sharing the frontend's configuration. They never derive a WebSocket address from the HTTP `backend_url`. Missing configuration returns `backend_connection_unavailable`; a backend change is checked against the source conversation, whose authorization remains authoritative. Regression fixtures expose HTTP and WebSocket on different ports and paths, with no Socket.IO route on the HTTP server.

Listing and search accept `device_id` to query one owned device without waiting for unrelated devices or stored cloud history. Resolve device IDs through existing creation options; unknown and offline devices remain explicit coverage failures. Use listing, search and history reads to inspect existing conversations rather than creating a remote conversation to discover them.

Local cloud-project conversations reuse the frontend's existing `GET /v1/runtime-tasks/cloud-context` with the actual device and task. It checks the current user, active binding and project/Issue visibility before reading the local catalog and history. This read does not loop through a cloud device RPC and therefore does not require enabling local remote control. Denied permissions, missing bindings and service errors still appear in coverage; authorization is never skipped or replaced with unauthorized data.

Timeouts share one decreasing deadline: the managed control MCP allows 180 seconds, the entire read allows 150 seconds, and individual remote ACKs allow up to 75 seconds for catalogs, 130 seconds for body search and 15 seconds per protocol 2 chunk, capped by the remaining read time. Codex start, resume and fork and Claude injection use this configuration. A slow source preserves successful results from other sources and reports `query_timeout` or `device_timeout` in coverage instead of implying absence. Diagnostics record source, operation, elapsed time and error code without credentials or message bodies.

History uses the desktop's existing protocol 2 transfer, gzip validation and long-string restoration, retaining messages, tool outputs, attachments, file changes and native history cursors. Legacy Runtime responses use their existing protocol. Cloud reads retain inherited messages and attachments already authorized by task detail, then traverse existing Subtask pages without separately querying fork parents. Reads have the same device availability requirements as the desktop and do not claim unavailable data was read. Updating the controlling executor enables this change; no new Backend endpoint deployment or remote-device upgrade is required to read content already available to the frontend.
Weekly reports list every conversation updated since the period start, include archives and follow all conversation/history cursors, then filter messages by their own timestamps. An upper conversation-update bound must not discard conversations with activity after the reporting period.

```mermaid
flowchart LR
  Config[Existing desktop connection configuration] --> UI[Frontend]
  Config --> MCP[wework_control]
  UI[Frontend] --> Local[Shared local Runtime catalog and history]
  MCP[wework_control] --> Local
  UI --> IPC[Existing Socket.IO Runtime channel]
  MCP -->|Use configured socket_url directly| IPC
  IPC --> Remote[Existing cloud and remote device read methods]
  UI --> Cloud[Existing Task and Subtask APIs]
  MCP --> Cloud[Existing Task and Subtask APIs]
  Local --> Page[Filters and cursors and source coverage]
  Remote --> Page
  Cloud --> Page
```

The existing CI checkpoint now covers real stored cloud history, cloud/remote-device creation, full-text discovery, unique results and addressed history reads; only the model is mocked. The desktop HTTP endpoint uses a real forwarding proxy that rejects WebSockets, while Socket.IO uses existing server metadata. The checkpoint verifies both configured URLs so incorrect address derivation fails the regression. Focused regressions cover equal-time pagination, deduplication, histories beyond 100 messages, invalid cursors and partial coverage. E2E and ai:verify have not been run.

Focused tests cover contracts, delegated authority, HTTP isolation, durable and ambiguous PR relationships, schedule versions, native-thread continuation, duplicate suppression and actual schedule startup. The new self-contained `workbench-control` desktop checkpoint is registered in the shared runner and selected by CI Core shard 5. It uses real Runtime/MCP/native sessions and simulates only the model; GitHub itself is not exercised. E2E and ai:verify have not been run, as requested, so full desktop verification is not claimed.

Focused verification results for this adjustment are recorded in the change handoff. The new Backend endpoint and its dedicated tests were removed. Regressions cover legacy device responses, actual Socket.IO encoding, chunked long messages, complete cloud message pagination and denied access. E2E and ai:verify were not run; local results do not establish remote CI success or deployment.

## Complete conversation creation options (2026-10-27)

`get_conversation_creation_options` returns the actual parameter schema, local projects, native/configured models, skills and plugins; `include_remote` adds authorized execution environments and cloud models. `create_conversation.options` derives its fields from the shared V2 producer contract, excluding credentials, execution identity, raw thread handles and dispatch origin.

Supported creation settings include Codex/Claude Code, model selection, reasoning/service tier, permissions and plan mode, device and code-project/workspace selection, local-path/Worktree execution, branch selection or local branch creation, attachments, skills/plugins, typed context, initial goal/supervisor and ephemeral sessions. The outer `project_space: {space_id, store, item_id?}` binds a project or Issue before dispatch; local spaces retain local executors. `reference_conversation_id` resolves an authorized native Codex side-conversation reference, with the existing same-device constraint and delegated-target rejection. Files must be accessible on the target device; remote attachments use existing uploaded `attachmentIds`.

Model options use `reasoning`, `summary` and `speed`; the existing `reasoningEffort` / `serviceTier` aliases normalize before merging explicit overrides. Permissions use `permissionMode`, plan mode uses `collaborationMode`, and Claude uses the outer `runtimePermissionMode`.

```mermaid
flowchart TD
  A[AI creation intent] --> B[Shared contract and source authority]
  B --> F[Prepare optional project or Issue binding]
  F --> T{Owning device}
  T -->|Local with cloud resources| M[Existing materialize and permission checks]
  T -->|Local without cloud resources| L[Device model and project compiler]
  M --> L
  L --> R[Existing local Runtime creation and queue]
  T -->|Other device| D[Existing Backend authorization and create API]
  D --> E[Target device compiler]
  E --> R
  R --> W[Environment and native session creation]
```

The UI publishes model profiles through authenticated device IPC into Executor memory, using the existing model compiler. Refreshes include removals and serialize per device to prevent stale credentials overwriting new profiles. MCP accepts model identities, never materialized `modelConfig` or `executionRequest`. Remote intent compilation requires an advertised capability and preserves Backend account proxy and APP device restrictions. Source attachments, Issue origin, forks and inherited history are cleared for new sessions. Local project bindings remain readable offline.

Definite rejection cleans up the binding; uncertain transport/server outcomes retain the address for reconciliation without automatic resending. Acceptance is distinct from completion. After Executor restart, model-catalog preparation republishes custom profiles; unavailable profiles fail explicitly instead of using another model's credentials.

Regression coverage includes all composer fields, exact model identities and refreshes, primary/supervisor proxy policy, actual native plan/permission parameters, real Git branches, project/Issue bindings and cleanup, delegated-reference denial and remote dispatch. Related frontend tests (127), Backend create/RPC tests (152), TypeScript and ESLint passed. The existing CI-covered desktop checkpoint now creates a configured conversation and checks its visible result. E2E and ai:verify were not run.

## Outcome

Every product operation available to a user in Wework should have an AI equivalent, including the same readable data, permissions, state transitions and persisted effects. Personal conversations and scheduled agents use the same capabilities. Business operations must work without the relevant page or conversation being mounted.

Coverage includes conversations, projects, workspaces, Git, PR/CI, schedules, project spaces, Issues, comments, deliveries, tables, members and resource bindings, models, skills, plugins, Hooks, notifications, applications and desktop settings. Navigation and window operations explicitly declare their desktop requirements. Plugins register their operations through the same contract.

## Existing foundations and gaps

| Area                   | Existing implementation                                                                                                          | Missing work                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Conversations          | Runtime list/get/search/transcript, native pagination and rich messages                                                          | Managed AI discovery, complete safe metadata, aggregation and availability reporting                                             |
| Execution              | Create/send, busy queues, guidance, interruption, cancellation, fork, rollback, compaction, goals, supervisors and input answers | AI entry points and a page-independent execution-intent compiler                                                                 |
| Personal HTTP API      | Device/conversation/model discovery and native Responses adapter                                                                 | Uses a separate personal API key; limited catalog metadata; continuation requires an idle Codex conversation and model selection |
| PR/CI                  | Device Git CLI queries and a UI change-request monitor                                                                           | Background queries, detailed failed run identities and global reverse lookup                                                     |
| PR relationships       | Persistent cloud Issue task bindings with uniqueness and resolution                                                              | Equivalent relationships for standalone/local conversations and an aggregate query                                               |
| Schedules              | Runtime cron/interval/one-time scheduling, independent/continued conversations and persistent runs                               | AI CRUD/control and dynamic cross-conversation handoff                                                                           |
| Deduplication          | Active schedule-run exclusion; project incoming event deduplication                                                              | CI failure deduplication across completed polls and durable target-side acceptance                                               |
| Project automation     | Incoming hooks/polling, normalized events, PR resolution and continue_binding                                                    | Personal-scope adapters and complete product-tool coverage                                                                       |
| Project MCP            | Many local/cloud Issue, comment, attachment, delivery and table operations                                                       | Remaining member/resource/execution/automation operations; current comment tool does not identify a reply session                |
| Workspace and settings | ExecutorClient, Runtime RPC, Host capabilities and existing APIs                                                                 | Complete product contracts with safe configuration projections                                                                   |
| Commands and UI        | DSH commands/context/menu/keybindings; desktop inspect/click/fill/press CLI                                                      | Command schemas and business authorization; existing DOM control still requires a window                                         |

`wework.session.current` provides identifiers, not authorization or a complete tool surface. Existing public APIs remain supported integrations. Internal managed tools use execution-bound authorization without requiring a new personal API key.

## Architecture

```mermaid
flowchart TD
    CONTRACT[Shared operation contracts] -.-> CONTROL
    UI[UI / DSH commands] --> CONTROL[Wework application operations]
    AI[Personal or scheduled AI] --> MCP[Managed wework_control MCP]
    MCP --> CONTROL
    CONTROL --> AUTH[Current permissions and delegated scope]
    AUTH --> ROUTE[Storage and execution routing]
    ROUTE --> LOCAL[Resident local DSH service]
    ROUTE --> BACKEND[Backend business APIs]
    ROUTE --> HOST[Electron Host / UI bridge]
    LOCAL --> DOMAIN[Existing domain services]
    BACKEND --> DOMAIN
    HOST --> DOMAIN
    DOMAIN --> RUNTIME[Runtime sessions / queues]
    DOMAIN --> STORE[Domain-owned storage]
    DOMAIN --> GIT[Device gh / existing connectors]
    RUNTIME --> EVENTS[Events and operation receipts]
    EVENTS --> UI
    EVENTS --> MCP
```

Use shared operation schemas, suggested under `wework/contracts/operations/`, for identifiers, inputs, outputs, resource types, effects, ownership, execution targets and availability. Existing DSH commands reference these identifiers; do not create a parallel frontend command system. Existing project-space, browser, computer and connector tools retain their domain handlers and authorization.

Add a resident DSH application service under `wework/dsh/workbench-control/`. Extract execution compilation, model/proxy resolution, attachments and project context from localServices into modules with injected ports and no DOM. UI, local schedules and AI invoke that service. Runtime retains authority over sessions, queues and histories. Refresh configuration through current references; redacted persisted execution profiles are not durable credentials.

Remote execution reuses current Backend materialization and routing. New Backend APIs belong in Rust with Application registration, active routes and focused tests. Existing Python-owned APIs retain ownership. Check each method/path rather than assigning an entire URL family to one implementation. Do not duplicate their business logic in a new Rust handler.

Bind the MCP and local service bridge to authenticated execution contexts and exact runtime instances. Expose explicit product operations, not arbitrary RPC names, URLs, execution requests or raw Host capabilities. General tools discover, describe and invoke schema-validated operations; common conversation and schedule tools are generated from the same definitions.

## Conversation data and continuation

Reuse RuntimeTaskSummary, RuntimeTranscriptResponse, existing conversation ID encoding and origin/task bindings. Keep device/task, native thread, response, project and Issue identities distinct. Link synchronized replicas through existing transcript identity when available.

Return safe complete product metadata, state, queue/input status, model, project/Issue/activity/execution, workspace/worktree, repository/branch, confirmed PRs, CI timestamps, plans/goals, outputs and allowed operations. Page native history and large resources. Never serialize raw runtimeHandle or executionRequest. Report unavailable devices and partial results; offline is not an empty catalog or permission to fabricate unsynchronized history.

Continuation resolves authoritative target metadata and preserves the session, model, team, plugins, context and workspace unless the user requests a change. Queue by default when busy; interruption is explicit. Return a durable operation receipt and follow existing Runtime events through completion. Accepted is distinct from completed.

Deduplicate requestKey at the receiving Runtime in the same persistence boundary as acceptance/queuing. Identical retries return the original receipt; changed parameters conflict. Query receipts after timeouts. Test crashes both before and after acceptance.

## PR identity and five-minute CI workflow

Use provider, canonical instance, full repository and PR number as identity; head SHA, workflow run and attempt identify failure evidence. Reuse repository identity and cloud ProjectChangeRequestBindingService. Store standalone/local relationships on the owning Runtime; aggregate indexes are derived. Message URLs and branch matches produce candidates until confirmed. Return ambiguity explicitly, including multiple conversations or synchronized replicas.

Reuse the existing five-minute interval schedule to start a monitoring agent. It reads failed CI using the execution device's existing gh authorization, resolves the PR to one authorized conversation and sends a continuation with failure evidence. Existing project incoming-event normalization/resolution is reusable; personal queries must retain personal scope.

```mermaid
sequenceDiagram
    participant S as Schedule
    participant A as Monitoring AI
    participant G as GitHub / device gh
    participant C as Application operations
    participant R as Target Runtime
    S->>A: Start five-minute poll
    A->>G: Read failures, PR and current head
    G-->>A: Run / attempt / SHA / failure evidence
    A->>C: Resolve PR to conversation
    C-->>A: Unique authorized target or unresolved reason
    A->>C: Continue with failure identities
    C->>C: Validate permissions, current head and duplicate events
    C->>R: Persist idempotent acceptance / queue
    R-->>A: Operation receipt
    R->>R: Continue original session
```

Deduplicate the same failure across polls, manual calls and restarts. A new commit or rerun attempt can trigger new work. Aggregate current failures into a repair message; already active repairs expose their existing status. Stale head failures are recorded as obsolete. Missing/ambiguous mappings, offline targets and expired authorization return actionable states. Delivery of a repair request and completion of the repair have separate records.

## Delivery sequence

1. Shared contracts, capability coverage inventory and resident application service; extract frontend compilation and routing.
2. Managed MCP, safe full conversation reads and lifecycle operations for Codex and Claude, with explicit support discovery for other harnesses.
3. Persistent PR relationships, reverse lookup, background Git queries and durable target receipts.
4. Complete schedule controls and the dynamic CI-to-conversation scenario.
5. Remaining product areas and plugin registration; every user operation must map to a handler, authorization rule and verification entry.
6. Remove obsolete frontend business compilation and PR monitoring logic; run focused checks and perform final review after the entire feature is complete.

These are dependencies within one complete delivery. The final scope remains all frontend product capabilities. UI-only navigation uses existing DSH command/Host bridges with explicit availability.

Plugin SDK interactions bind to registered operations, and installation/update validates declarations against handlers. Arbitrary third-party plugin or Smart App pages require explicit semantic adapters; installation alone does not provide them. Unadapted operations remain visible coverage gaps. Full coverage can be claimed only after the built-in and in-scope plugin inventory is complete.

Preserve CP01–CP20, including shared-session reads that never reveal a device owner's catalog, delegated manager/executor limits, Viewer restrictions, secret isolation and current permission checks at acceptance and dequeue. Native personal work remains available without cloud connectivity. Existing login/confirmation requirements become explicit waiting-for-user states; ordinary authorized operations proceed directly.

## Verification

Add focused contract, Runtime, persistence, permission and frontend adapter tests. Cover native pagination, rich data, redaction, multiple devices, offline partial reads, both runtimes, queues/input, PR collisions, forks/replicas, stale SHA, repeated attempts, concurrency, timeout recovery, restart and authorization revocation. Assert UI/AI operation parity and plugin lifecycle.

Reuse existing runtime send, MCP, automation, incoming-hook, public-API, DSH command and collaboration permission suites. Add desktop regressions to the shared scenario/checkpoint runner and actual GitHub CI classification. Each checkpoint establishes minimal prerequisites. E2E may mock only models; GitHub integration requires a real test repository and CI evidence.

Run focused unit/contract/type/format/lint checks during implementation. Run E2E and ai:verify only when explicitly requested. Compare every implementation batch against the architecture and workflow diagrams. Perform the review defined by `/Volumes/OuterHD/OuterIdeaProjects/review/WEGENT.md` after functional development is complete. This design-only change has no execution-validation claim.
