# Local Device Python Migration Test Matrix

This document tracks the Rust executor coverage for the legacy Python local AI
device chain from commit `1d2fa53424951d55d43cef3b6f1b287001ebad0d`.

## Scope

The migration scope is executor-only:

- Backend Socket.IO local device events.
- Local session and terminal/code-server control.
- Capability sync and heartbeat reporting.
- Running task tracking, cancellation, and close-session handling.
- Runtime work RPC, local app IPC, upgrade, and extension execution.
- Stable local device identity.

## Status Legend

| Status | Meaning |
| --- | --- |
| Migrated | Implemented in Rust and covered by Rust tests. |
| Not Migrated | Still missing and must be tracked before removing Python parity risk. |
| Not Ported | Python-only behavior that does not apply to the Rust executor. |

## Backend Local Device Events

| Legacy Python behavior | Rust status | Rust coverage |
| --- | --- | --- |
| Register `task:execute` and `chat:message` task entrypoints | Migrated | `executor/tests/local_backend_contract.rs`, `executor/tests/local_backend_dispatch_contract.rs` |
| Register and process `task:cancel` | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/local_backend_dispatch_contract.rs` |
| Register and process `task:close-session` | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Register and process `device:execute_command` | Migrated | `executor/tests/local_backend_contract.rs` |
| Register and process `device:sync_capabilities` | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/local_capability_sync_contract.rs` |
| Register and process `device:start_terminal_session` | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/local_session_handler_contract.rs` |
| Register and process `device:start_code_server_session` | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/local_session_handler_contract.rs` |
| Register and process `terminal:input`, `terminal:resize`, `terminal:close` | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/unix_pty_manager_contract.rs` |
| Register and process `runtime:rpc` with a default runtime work handler | Migrated | `executor/tests/local_backend_contract.rs`, `executor/tests/app_runtime_work_*_contract.rs` |
| Register and process `device:upgrade` | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/updater_service_contract.rs`, `executor/tests/process_manager_contract.rs`, `executor/tests/app_startup_contract.rs` |
| Register and process `device:run_extension` | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |

## Device State And Heartbeat

| Legacy Python behavior | Rust status | Rust coverage |
| --- | --- | --- |
| Persist a stable device id instead of falling back to `local-device` | Migrated | `executor/tests/config_contract.rs`, `executor/tests/app_startup_contract.rs` |
| Build default device names safely for non-ASCII device ids | Migrated | `executor/tests/config_contract.rs` |
| Include running task ids in heartbeat | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/local_backend_contract.rs` |
| Include local capability report in heartbeat | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/local_backend_contract.rs` |
| Include runtime auth file report in heartbeat | Migrated | `executor/tests/local_backend_contract.rs` |
| Reconnect after repeated heartbeat failures | Migrated | `executor/tests/local_backend_resilience_contract.rs` |

## Task Runtime Controls

| Legacy Python behavior | Rust status | Rust coverage |
| --- | --- | --- |
| Track accepted local tasks as running | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Cancel a running local task by aborting the managed child process | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/claude_cancellation_contract.rs`, `executor/tests/codex_cancellation_contract.rs` |
| Preserve pre-registration cancel requests and apply them on task start | Migrated | `executor/tests/local_backend_dispatch_contract.rs` |
| Close a task session and refresh heartbeat | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |

## Capability Sync

| Legacy Python behavior | Rust status | Rust coverage |
| --- | --- | --- |
| Download managed skill packages from the backend with encoded namespace query parameters | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/local_capability_sync_contract.rs` |
| Restrict package bearer tokens to backend-origin downloads | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Extract skill packages through per-sync staging directories before atomic replacement | Migrated | `executor/src/local/backend/capability.rs`, `executor/tests/local_capability_sync_contract.rs` |
| Sync plugins from uploaded package downloads and marketplace metadata | Migrated | `executor/tests/local_capability_sync_contract.rs` |
| Serialize concurrent capability sync manifest transactions | Migrated | `executor/tests/local_capability_sync_contract.rs` |

## Sessions

| Legacy Python behavior | Rust status | Rust coverage |
| --- | --- | --- |
| Resolve relative terminal/code-server paths under the configured local workspace root | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/local_session_handler_contract.rs` |
| Route terminal input, resize, and close events to the active PTY session | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/unix_pty_manager_contract.rs` |
| Serve code-server sessions through the local gateway URL | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/local_session_handler_contract.rs` |

## Upgrade

| Legacy Python behavior | Rust status | Rust coverage |
| --- | --- | --- |
| Reject upgrade while tasks are running unless `force_stop_tasks` is set | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Force-stop running tasks before upgrade | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Abort backend-triggered upgrade when any forced task cancellation fails | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Bind injected upgrade services to the current task controller independent of builder call order | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Emit `device:upgrade_status` states: `busy`, `checking`, `skipped`, `success`, `restarting`, `error` | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Run updater service with registry overrides and `auto_confirm` | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/updater_service_contract.rs` |
| Restart executor after successful backend-triggered upgrade | Migrated | `executor/src/local/backend/upgrade.rs`, `executor/tests/process_manager_contract.rs` |
| `--upgrade` CLI update check | Migrated | `executor/tests/app_startup_contract.rs`, `executor/tests/updater_service_contract.rs` |

## Extensions

| Legacy Python behavior | Rust status | Rust coverage |
| --- | --- | --- |
| Run extension scripts from the task-scoped `.claude/skills/<extension>` directory | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Reject extension script path escapes and path meta extension names | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |

## Not Ported

| Legacy Python behavior | Reason |
| --- | --- |
| PyInstaller-specific subprocess environment cleanup | The Rust executor is a native binary and does not carry PyInstaller bootloader environment state. |
| Python development restart command using `python -m executor.main` | The Rust executor restarts the current executable path instead. |
| Python manual upgrade script under `executor/tests/manual/` | Manual Python script is replaced by Rust unit/contract coverage and the Rust `--upgrade` path. |

## Current Gaps

No known local AI device migration test gaps remain in executor after the Rust
coverage above. Any new local device event must be added to
`executor/tests/local_backend_device_migration_contract.rs` first, then marked
in this document.
