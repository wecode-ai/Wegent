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

## Upgrade

| Legacy Python behavior | Rust status | Rust coverage |
| --- | --- | --- |
| Reject upgrade while tasks are running unless `force_stop_tasks` is set | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Force-stop running tasks before upgrade | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Emit `device:upgrade_status` states: `busy`, `checking`, `skipped`, `success`, `restarting`, `error` | Migrated | `executor/tests/local_backend_device_migration_contract.rs` |
| Run updater service with registry overrides and `auto_confirm` | Migrated | `executor/tests/local_backend_device_migration_contract.rs`, `executor/tests/updater_service_contract.rs` |
| Restart executor after successful backend-triggered upgrade | Migrated | `executor/src/local/backend/upgrade.rs`, `executor/tests/process_manager_contract.rs` |
| `--upgrade` CLI update check | Migrated | `executor/tests/app_startup_contract.rs`, `executor/tests/updater_service_contract.rs` |

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
