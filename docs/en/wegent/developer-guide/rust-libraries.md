---
sidebar_position: 45
---

# Rust libraries and build boundaries

Backend and Executor compile, test, and release independently, each with its own Cargo lockfile. They reuse source libraries through local path dependencies, without depending on the other application's binary or creating a repository-wide Cargo workspace.

## Library responsibilities

| Location                              | Crate                          | Responsibility                                                                                      |
| ------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `shared/rust/protocol`                | `wegent-protocol`              | Backend dispatch assembly, Executor request decoding, task status, and protocol values              |
| `shared/rust/crypto`                  | `wegent-crypto`                | Explicit-key/IV AES-CBC primitives and strict PKCS#7                                                |
| `backend-rs/crates/python-compat`     | `wegent-python-compat`         | Python JSON serialization, value conversion, and integer-set iteration compatibility                |
| `backend-rs/crates/http-compat`       | `wegent-http-compat`           | FastAPI-compatible errors for Breeze HTTP services                                                  |
| `backend-rs/crates/storage`           | `wegent-storage`               | S3 signing, object-path encoding, and the shared MinIO HTTP client                                  |
| `shared/rust/filesystem`              | `wegent-filesystem`            | File leases, directory links, platform paths, and permission-preserving atomic writes               |
| `backend-rs/crates/config`            | `wegent-backend-config`        | Backend environment and connection configuration                                                    |
| `backend-rs/crates/persistence`       | `wegent-backend-persistence`   | Request transactions, SQL values, routing keys, and connection policy                               |
| `backend-rs/crates/identity`          | `wegent-identity`              | Session authentication, JWT, user readers, and repository credential encoding                       |
| `backend-rs/crates/access`            | `wegent-access`                | Entity/group membership, role inheritance, and public-model allowlists                              |
| `backend-rs/crates/directory`         | `wegent-directory`             | Employee-directory provider interfaces and records                                                  |
| `backend-rs/crates/celery`            | `wegent-celery`                | Celery protocol and broker operations                                                               |
| `backend-rs/crates/job-runtime`       | `wegent-job-runtime`           | Background job registration, scheduling, leases, and cancellation                                   |
| `backend-rs/crates/socket-events`     | `wegent-socket-events`         | Socket.IO envelopes and RPC waiter lifetimes                                                        |
| `backend-rs/crates/network-policy`    | `wegent-network-policy`        | Outbound trust and destination policy                                                               |
| `backend-rs/crates/resource-store`    | `wegent-resource-store`        | CRD projections, resource references, Kind queries, and decision-model schema                       |
| `backend-rs/crates/task-store`        | `wegent-task-store`            | Task/subtask persistence, atomic pipeline advancement, and task documents                           |
| `backend-rs/crates/capabilities`      | `wegent-capabilities`          | Unified skill catalogue, task skill resolution, Kind caching, and authorization                     |
| `backend-rs/crates/models`            | `wegent-models`                | Model catalogue aggregation, authorization, and projections                                         |
| `backend-rs/crates/runtime-check`     | `wegent-runtime-check`         | Authorized task checkpoints and streaming state                                                     |
| `backend-rs/crates/git-repositories`  | `wegent-git-repositories`      | Repository catalogues, branches, cache, and credential providers                                    |
| `backend-rs/crates/sites`             | `wegent-sites`                 | Sites catalogue routes and upstream integration                                                     |
| `backend-rs/crates/test-support`      | `wegent-backend-test-support`  | SQL protocol fixtures and JSON baseline assertions for tests                                        |
| `executor/crates/config`              | `wegent-runtime-config`        | Device, Home, workspace, and native executable configuration                                        |
| `executor/crates/logging`             | `wegent-runtime-logging`       | Executor structured events and rolling logs                                                         |
| `executor/crates/execution-contracts` | `wegent-execution-contracts`   | Execution, command, IPC, and notification contracts                                                 |
| `executor/crates/subprocess`          | `wegent-subprocess`            | Process spawning, environment normalization, output collection, and platform process-tree lifetimes |
| `executor/crates/hooks`               | `wegent-hooks`                 | Hook discovery, restricted command execution, and rollout observation                               |
| `executor/crates/workspace`           | `wegent-workspace`             | Workspace files, native Git, environment preparation, build caches, and change tracking             |
| `executor/crates/automation`          | `wegent-automation`            | Automation definitions, run records, and recurrence policy                                          |
| `executor/crates/task-store`          | `wegent-local-task-store`      | Transactional local tasks, projects, and execution queues                                           |
| `executor/crates/model-proxy`         | `wegent-model-proxy`           | Local model routing, protocol translation, model catalogue, and capability contexts                 |
| `executor/crates/test-support`        | `wegent-executor-test-support` | Test environment isolation and a shared environment lock                                            |
| `backend-rs/crates/executor-manager`  | `wegent-executor-manager`      | Executor Manager client, timeouts, and response projections                                         |
| `backend-rs/crates/media`             | `wegent-media`                 | Media policy and video-result URL refresh contracts                                                 |
| `backend-rs/crates/remote-workspace`  | `wegent-remote-workspace`      | Remote workspace authorization, status, file transport, and task projections                        |
| `executor/crates/plugin-packages`     | `wegent-plugin-packages`       | Plugin package publication, capability configuration, recovery, and activation                      |
| `executor/crates/execution-stream`    | `wegent-execution-stream`      | Ordered event delivery, delta compaction, failure propagation, and flushing                         |
| `backend-rs/crates/users`             | `wegent-backend-users`         | User profiles, account settings, runtime configuration, and directory queries                       |
| `backend-rs/crates/authentication`    | `wegent-authentication`        | Password login, desktop device authorization, and token refresh                                     |
| `backend-rs/crates/oidc`              | `wegent-oidc`                  | Web/CLI OIDC login, provider caches, and user provisioning                                          |
| `backend-rs/crates/onboarding`        | `wegent-onboarding`            | Default resource validation and per-resource transactions                                           |
| `executor/crates/multimodal`          | `wegent-multimodal`            | Attachment decoding, vision preprocessing, and knowledge prompts                                    |
| `executor/crates/mcp-runtime`         | `wegent-mcp-runtime`           | MCP configuration, deferred interaction, and runtime environment binding                            |
| `executor/crates/native-home`         | `wegent-native-home`           | Native session homes, execution leases, archive, and restore                                        |
| `executor/crates/claude-harness`      | `wegent-claude-harness`        | Claude command planning, resume, retry, and stream translation                                      |

Libraries under `shared/rust` do not read application environment variables, access databases, or decide permissions. Application-specific domain libraries use their explicitly declared configuration, persistence, and authorization interfaces. Applications resolve configuration and keys, send requests, and map algorithm errors to their existing business responses. The S3 timestamp helper only reads the clock.

`dispatch::ExecutionRequest` is the producer projection after Backend resolves resources; the root `ExecutionRequest` is the tolerant Executor consumer projection. Their fields and defaults differ and must not be mechanically unified. Contract tests verify that producer-assembled JSON decodes into the consumer projection. The consumer's `agent_home_runtime_task_id` is trusted local metadata and is not deserialized from requests.

`wegent-crypto::decrypt_cbc` strictly validates PKCS#7. Only the historical MCP provider path uses `decrypt_cbc_blocks` followed by its original padding removal; that primitive neither validates nor removes padding, and regression coverage pins the difference. Executor Git tokens and subscription encryption retain their original AES-256 restrictions. Applications retain their empty-value, configuration-error, and decryption-failure policies.

## Development and verification

Run from the repository root:

```bash
# Backend application and private libraries; backend-rs/Cargo.lock
cargo check --manifest-path backend-rs/Cargo.toml --locked --tests --examples
cargo test --manifest-path backend-rs/Cargo.toml --locked

# Executor; executor/Cargo.lock
cargo check --manifest-path executor/Cargo.toml --locked --all-targets --all-features
cargo test --manifest-path executor/Cargo.toml --locked --all-features

# Shared libraries and producer-to-consumer contracts; shared/rust/Cargo.lock
cargo test --manifest-path shared/rust/Cargo.toml --locked
```

Each application and its domain libraries inherit the existing version declaration through `workspace.package.rust-version`; CI uses the toolchain pinned in `.github/ci/rust-toolchain`. This refactor retains the source API baseline without certifying older toolchains against the complete locked dependency graph.

Each Backend and Executor workspace includes its application and private libraries as default members. The shared workspace has a separate lockfile for library tests; applications still resolve dependencies through their own lockfiles. Application `cargo test` does not run external dependency unit tests, so the existing Backend CI test job explicitly checks shared-library formatting, tests, and Clippy.

Shared-source changes must select Backend, Executor, and their existing integration checks. Docker dependency and application stages both need shared sources. Dependency-image, runtime-image, and macOS/Windows build fingerprints include shared and application-private libraries. Update these inputs when adding local crates so cached binaries cannot omit source changes.

## Criteria for further extraction

A library owns a complete state, transaction, or protocol lifetime rather than merely relocating files. It must not depend on application entrypoints, the complete AppState, or reverse calls into higher layers. Expose interfaces only for real cross-boundary consumers. Keep task, coordination, and queue updates on the same transactional connection in one library. Similar names do not justify merging protocols with different role rules, defaults, or error policies.

HTTP domain libraries register their own routes, which the application merges. `registered_routes()` derives paths and methods from the actual registry for active-route contract checks, without a second hand-written API inventory. Clients, caches, notification delivery claims, and workers retain their original shared process instances.

## State ownership and stopping boundaries

One retained OIDC service owns the metadata and JWKS caches. User, authentication, and OIDC routes receive existing connections, configuration, and extension interfaces after deployment injection. Onboarding preserves per-resource transactions, savepoints, refresh after commit, and partial success; it adds no batch-wide transaction.

Claude receives trusted identity and instructions through `ClaudeLaunchContext`; application composition determines eligibility for personal control instructions. Disabling tools suppresses runtime instructions. `ChildEnvironment` resolves current credentials at every actual spawn, resume, and retry. The merge order remains host environment, Git broker, command overrides, and plugin account broker, without retaining stale snapshots.

Directory, package activation, and native session leases stay with their lifecycle owners. Generic JSON publication, permission-preserving atomic publication, and runtime data replacement that supports open Windows readers have different contracts and cannot be substituted mechanically. Shared codecs, preparation policies, and object storage belong in foundation libraries. Active turns, cancellation state, credential composition, and cross-domain transaction coordination remain in the application library.

Dependency direction, actual cross-domain consumers, and single state ownership define the stopping point. The application root is itself a linkable library; individual handlers do not each need a crate. Libraries must not reach back into the application through a full context or a large callback facade. Algorithms private to one use case may remain internal modules. Large files are organized by responsibility, with original test assertions and ignore conditions moving with their implementation.
