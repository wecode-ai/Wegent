// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::{collections::HashMap, future::Future, path::Path, pin::Pin, sync::Arc};
#[cfg(windows)]
use std::{env, path::PathBuf};

use serde_json::{json, Value};
#[cfg(windows)]
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::{
    io::{split, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{broadcast, mpsc, watch, Mutex},
    time::{Duration, Instant},
};

use super::backend::runtime_rpc_encoding::encode_app_ipc_response;
use super::event_stream::{event_sequence, ExecutorEventHub};
use crate::{
    agents::resolve_codex_binary,
    local::bundled_plugins::{initialize_bundled_plugin_marketplace, BundledPluginMarketplace},
    local::codex_home::{
        codex_home_migration_status, import_external_content, initialize_codex_home,
        read_codex_local_config, update_codex_local_config, CodexHomeInitializeRequest,
        CodexLocalConfigUpdateRequest, ExternalContentImportRequest,
    },
    local::command::{CommandHandler, CommandRequest, CommandResult, DeviceCommandHandler},
    local::git_commands::{
        branch_diff, branch_diff_shortstat, hosting_cli_status, push_current_branch,
        workspace_diff, worktree_add, worktree_remove,
    },
    local::git_commit_message::generate_commit_message,
    local::harnesses::{
        list_local_harnesses, prepare_local_harness_launch, ListLocalHarnessesRequest,
        PrepareLocalHarnessLaunchRequest,
    },
    local::local_skills::list_local_skills,
    local::plugin_catalog::{
        list_wegent_store_plugins, read_plugin_manifest, save_plugin_example,
        ReadPluginManifestRequest, SavePluginExampleRequest,
    },
    local::plugin_import::{
        cleanup_personal_plugin_package, delete_personal_plugin, ensure_personal_plugin,
        finalize_plugin_import, import_personal_plugin_copy, import_plugin_package,
        link_plugin_release, list_personal_plugins, package_personal_plugin, preview_plugin_import,
        read_plugin_cloud_links, rollback_personal_plugin_copy, rollback_plugin_import,
        unlink_plugin_release, CleanupPersonalPluginPackageRequest, DeletePersonalPluginRequest,
        EnsurePersonalPluginRequest, ImportPersonalPluginCopyRequest, ImportPluginPackageRequest,
        LinkPluginReleaseRequest, ListPersonalPluginsRequest, PackagePersonalPluginRequest,
        PluginImportMutationRequest, PreviewPluginImportRequest, ReadPluginCloudLinksRequest,
        RollbackPersonalPluginCopyRequest, UnlinkPluginReleaseRequest,
    },
    local::turn_file_changes_commands::turn_file_changes as turn_file_changes_command,
    local::workspace_files::{
        execute_workspace_file_command_with_input, is_workspace_file_command, WORKSPACE_ROOTS_ENV,
    },
    logging::{
        format_executor_log, reserve_executor_stdout_for_protocol, write_executor_error_line,
        write_executor_log_line,
    },
    runtime_work::RuntimeWorkRpcHandler,
    task_runtime::{
        BinaryInput, ChatAgentCreate, ChatAgentUpdate, DeliveryCreate, DeliveryFinalize,
        LocalCommentCreate, LocalExecutionClaim, ProjectCreate, ProjectDescriptor, ProjectUpdate,
        RuntimeTaskAddress, TaskCreate, TaskReorder, TaskRuntime, TaskUpdate,
    },
    version::get_version,
};

const DEFAULT_DEVICE_ID: &str = "local-device";
pub const APP_IPC_PROTOCOL_VERSION: u64 = 1;
const DEFAULT_TIMEOUT_SECONDS: f64 = 60.0;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const APP_IPC_REQUEST_TIMEOUT_SECONDS: u64 = 75;
const APP_IPC_AUTH_TIMEOUT_SECONDS: u64 = 5;
const APP_IPC_MAX_AUTH_FRAME_BYTES: usize = 4096;
const APP_IPC_BULK_WRITE_BUFFER_CAPACITY: usize = 65_535;
const APP_IPC_CAPABILITIES: &[&str] = &[
    "device.command",
    "executor.backend",
    "executor.codex_home",
    "executor.harnesses",
    "executor.health",
    "executor.plugins",
    "runtime.archives",
    "runtime.automations",
    "runtime.codex",
    "runtime.connectors",
    "runtime.harness",
    "runtime.hooks",
    "runtime.keybindings",
    "runtime.projects",
    "runtime.settings",
    "runtime.sidebar",
    "runtime.tasks",
    "runtime.workspaces",
    "runtime.worktrees",
];
const APP_IPC_RENDERER_METHODS: &[&str] = &[
    "aitable.*",
    "attachments.*",
    "chat_agents.*",
    "codex.app_server_request",
    "deliveries.*",
    "device.execute_command",
    "dws.*",
    "executions.*",
    "executor.backend.configure",
    "executor.backend.status",
    "executor.codex_home.config.read",
    "executor.codex_home.config.update",
    "executor.codex_home.import_external_content",
    "executor.codex_home.initialize",
    "executor.codex_home.status",
    "executor.harnesses.list",
    "executor.harnesses.prepare_launch",
    "executor.health",
    "executor.plugins.initialize_bundled_marketplace",
    "executor.plugins.import_package",
    "executor.plugins.import_package.finalize",
    "executor.plugins.import_package.preview",
    "executor.plugins.import_package.rollback",
    "executor.plugins.links.link",
    "executor.plugins.links.list",
    "executor.plugins.links.unlink",
    "executor.plugins.personal.delete",
    "executor.plugins.personal.ensure",
    "executor.plugins.personal.import_copy",
    "executor.plugins.personal.list",
    "executor.plugins.personal.package",
    "executor.plugins.personal.package.cleanup",
    "executor.plugins.personal.rollback_copy",
    "executor.plugins.store.list",
    "executor.plugins.manifest.read",
    "executor.plugins.example.save",
    "external_attachments.*",
    "external_projects.*",
    "external_todos.*",
    "files.*",
    "projects.*",
    "runtime.*",
    "runtime_tasks.*",
    "todos.*",
];
const APP_IPC_WRITE_BUFFER_CAPACITY: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalEndpointRole {
    Client,
    Owner,
}
const RUNTIME_AUTH_STATUS_SCRIPT: &str = r#"
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def iso_mtime(path_stat):
    return datetime.fromtimestamp(path_stat.st_mtime, timezone.utc).isoformat()


codex_home = Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex")).expanduser()
target = codex_home / "auth.json"
result = {
    "runtime": "codex",
    "target_path": str(target),
    "exists": target.exists(),
    "updated_at": None,
    "sha256": None,
    "size_bytes": None,
    "error": None,
}

if target.exists() and target.is_file():
    try:
        target_stat = target.stat()
        digest = hashlib.sha256()
        with target.open("rb") as auth_file:
            for chunk in iter(lambda: auth_file.read(1024 * 1024), b""):
                digest.update(chunk)
        result.update(
            {
                "updated_at": iso_mtime(target_stat),
                "sha256": digest.hexdigest(),
                "size_bytes": target_stat.st_size,
            }
        )
    except OSError as exc:
        result["error"] = str(exc)

print(json.dumps(result, ensure_ascii=False))
"#;

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait RuntimeWorkHandler: Send + Sync {
    fn handle_runtime_rpc<'a>(&'a self, data: Value) -> BoxFuture<'a, Result<Value, AppIpcError>>;

    fn reconcile_bound_task_statuses<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }

    fn handle_codex_app_server_rpc<'a>(
        &'a self,
        _data: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>> {
        Box::pin(async {
            Err(AppIpcError::new(
                "codex_app_server_unavailable",
                "Codex app-server handler is not available",
            ))
        })
    }
}

pub trait BackendConnectionHandler: Send + Sync {
    fn configure_backend<'a>(&'a self, params: Value) -> BoxFuture<'a, Result<Value, AppIpcError>>;
    fn backend_quota<'a>(&'a self) -> BoxFuture<'a, Result<Value, AppIpcError>>;
    fn backend_status<'a>(&'a self) -> BoxFuture<'a, Result<Value, AppIpcError>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIpcError {
    pub code: String,
    pub message: String,
}

impl AppIpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Clone)]
struct LocalAppCommandDefinition {
    command: &'static str,
    argv: &'static [&'static str],
    post_processor: Option<PostProcessor>,
}

#[derive(Clone, Copy)]
enum PostProcessor {
    DirectoryList,
    Json,
}

type BlockingInitializationResult<T> = Result<T, String>;

struct BlockingSingleFlightState<T> {
    next_generation: u64,
    current: Option<(
        u64,
        watch::Receiver<Option<BlockingInitializationResult<T>>>,
    )>,
}

impl<T> Default for BlockingSingleFlightState<T> {
    fn default() -> Self {
        Self {
            next_generation: 0,
            current: None,
        }
    }
}

struct BlockingSingleFlight<T> {
    state: Mutex<BlockingSingleFlightState<T>>,
}

impl<T> Default for BlockingSingleFlight<T> {
    fn default() -> Self {
        Self {
            state: Mutex::new(BlockingSingleFlightState::default()),
        }
    }
}

impl<T> BlockingSingleFlight<T>
where
    T: Clone + Send + Sync + 'static,
{
    async fn run<F>(&self, initialize: F) -> BlockingInitializationResult<T>
    where
        F: FnOnce() -> BlockingInitializationResult<T> + Send + 'static,
    {
        let (generation, mut result_rx) = {
            let mut state = self.state.lock().await;
            if let Some((generation, result_rx)) = state.current.as_ref() {
                (*generation, result_rx.clone())
            } else {
                state.next_generation += 1;
                let generation = state.next_generation;
                let (result_tx, result_rx) = watch::channel(None);
                state.current = Some((generation, result_rx.clone()));
                tokio::spawn(async move {
                    let result = tokio::task::spawn_blocking(initialize)
                        .await
                        .map_err(|error| error.to_string())
                        .and_then(|result| result);
                    let _ = result_tx.send(Some(result));
                });
                (generation, result_rx)
            }
        };

        loop {
            let completed_result = {
                let result = result_rx.borrow();
                result.clone()
            };
            if let Some(result) = completed_result {
                if result.is_err() {
                    let mut state = self.state.lock().await;
                    if state
                        .current
                        .as_ref()
                        .is_some_and(|(current_generation, _)| *current_generation == generation)
                    {
                        state.current = None;
                    }
                }
                return result;
            }
            result_rx.changed().await.map_err(|_| {
                "Blocking initialization stopped before producing a result".to_owned()
            })?;
        }
    }
}

#[derive(Clone)]
pub struct AppIpcServer {
    device_id: String,
    runtime_instance_id: Option<String>,
    runtime_work_handler: Option<Arc<dyn RuntimeWorkHandler>>,
    backend_connection_handler: Option<Arc<dyn BackendConnectionHandler>>,
    command_handler: Arc<dyn DeviceCommandHandler>,
    event_tx: broadcast::Sender<Value>,
    event_hub: ExecutorEventHub,
    bundled_plugin_marketplace: Arc<BlockingSingleFlight<BundledPluginMarketplace>>,
}

impl Default for AppIpcServer {
    fn default() -> Self {
        let (event_tx, _) = broadcast::channel(super::RUNTIME_EVENT_BUFFER_CAPACITY);
        let event_hub = ExecutorEventHub::new(event_tx.clone());
        Self {
            device_id: DEFAULT_DEVICE_ID.to_owned(),
            runtime_instance_id: None,
            runtime_work_handler: None,
            backend_connection_handler: None,
            command_handler: Arc::new(CommandHandler),
            event_tx,
            event_hub,
            bundled_plugin_marketplace: Arc::new(BlockingSingleFlight::default()),
        }
    }
}

impl AppIpcServer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_device_id(mut self, device_id: impl Into<String>) -> Self {
        let device_id = device_id.into();
        self.device_id = if device_id.trim().is_empty() {
            DEFAULT_DEVICE_ID.to_owned()
        } else {
            device_id
        };
        self
    }

    pub fn with_runtime_instance_id(mut self, runtime_instance_id: impl Into<String>) -> Self {
        self.runtime_instance_id = Some(runtime_instance_id.into())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        self
    }

    pub fn with_runtime_work_handler<H>(mut self, handler: H) -> Self
    where
        H: RuntimeWorkHandler + 'static,
    {
        self.runtime_work_handler = Some(Arc::new(handler));
        self
    }

    pub(crate) fn with_shared_runtime_work_handler(
        mut self,
        handler: Arc<dyn RuntimeWorkHandler>,
        event_tx: broadcast::Sender<Value>,
        event_hub: ExecutorEventHub,
    ) -> Self {
        self.runtime_work_handler = Some(handler);
        self.event_tx = event_tx;
        self.event_hub = event_hub;
        self
    }

    pub fn with_local_runtime_work_handler(mut self, codex_binary: impl Into<String>) -> Self {
        self.runtime_work_handler = Some(Arc::new(RuntimeWorkRpcHandler::with_event_sender(
            self.device_id.clone(),
            codex_binary.into(),
            self.event_tx.clone(),
        )));
        self
    }

    pub fn with_backend_connection_handler<H>(mut self, handler: H) -> Self
    where
        H: BackendConnectionHandler + 'static,
    {
        self.backend_connection_handler = Some(Arc::new(handler));
        self
    }

    pub fn with_command_handler<H>(mut self, handler: H) -> Self
    where
        H: DeviceCommandHandler + 'static,
    {
        self.command_handler = Arc::new(handler);
        self
    }

    pub async fn handle_line(&self, line: &str) -> Option<Value> {
        if line.trim().is_empty() {
            return None;
        }

        let mut request_id = None;
        let response = match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(message)) => {
                request_id = match request_id_from(&message) {
                    Ok(request_id) => Some(request_id),
                    Err(error) => return Some(error_message(None, &error)),
                };

                match request_from_message(&message) {
                    Ok((method, params)) => match self.dispatch(&method, params).await {
                        Ok(result) => {
                            response_message(request_id.as_deref().unwrap_or_default(), result)
                        }
                        Err(error) => error_message(request_id.as_deref(), &error),
                    },
                    Err(error) => error_message(request_id.as_deref(), &error),
                }
            }
            Ok(_) => error_message(
                request_id.as_deref(),
                &AppIpcError::new("invalid_request", "Request must be a JSON object"),
            ),
            Err(error) => error_message(
                request_id.as_deref(),
                &AppIpcError::new("invalid_json", error.to_string()),
            ),
        };

        Some(response)
    }

    pub async fn dispatch(&self, method: &str, params: Value) -> Result<Value, AppIpcError> {
        if method == "executor.protocol.describe" {
            return Ok(self.protocol_description());
        }

        if method == "executor.health" {
            return Ok(json!({"status": "healthy"}));
        }

        if method == "executor.harnesses.list" {
            let request = serde_json::from_value::<ListLocalHarnessesRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            return serde_json::to_value(list_local_harnesses(request).await)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.codex_home.status" {
            return serde_json::to_value(
                codex_home_migration_status()
                    .map_err(|error| AppIpcError::new("codex_home_status_failed", error))?,
            )
            .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.codex_home.config.read" {
            return serde_json::to_value(
                read_codex_local_config()
                    .map_err(|error| AppIpcError::new("codex_home_config_read_failed", error))?,
            )
            .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.codex_home.config.update" {
            let request = serde_json::from_value::<CodexLocalConfigUpdateRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            return serde_json::to_value(
                update_codex_local_config(request)
                    .map_err(|error| AppIpcError::new("codex_home_config_update_failed", error))?,
            )
            .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.codex_home.initialize" {
            let request = serde_json::from_value::<CodexHomeInitializeRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            return serde_json::to_value(
                initialize_codex_home(request)
                    .map_err(|error| AppIpcError::new("codex_home_initialize_failed", error))?,
            )
            .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.codex_home.import_external_content" {
            let request = serde_json::from_value::<ExternalContentImportRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let imported = tokio::task::spawn_blocking(move || import_external_content(request))
                .await
                .map_err(|error| {
                    AppIpcError::new("external_content_import_task_failed", error.to_string())
                })?
                .map_err(|error| AppIpcError::new("external_content_import_failed", error))?;
            return serde_json::to_value(imported)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.harnesses.prepare_launch" {
            let request = serde_json::from_value::<PrepareLocalHarnessLaunchRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let prepared = prepare_local_harness_launch(request)
                .map_err(|error| AppIpcError::new("harness_launch_prepare_failed", error))?;
            return serde_json::to_value(prepared)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.plugins.initialize_bundled_marketplace" {
            let marketplace = self
                .bundled_plugin_marketplace
                .run(initialize_bundled_plugin_marketplace)
                .await
                .map_err(|error| AppIpcError::new("bundled_plugins_initialize_failed", error))?;
            return serde_json::to_value(marketplace)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.plugins.import_package.preview" {
            let request = serde_json::from_value::<PreviewPluginImportRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let preview = tokio::task::spawn_blocking(move || preview_plugin_import(request))
                .await
                .map_err(|error| AppIpcError::new("plugin_import_task_failed", error.to_string()))?
                .map_err(|error| AppIpcError::new("plugin_import_preview_failed", error))?;
            return serde_json::to_value(preview)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.plugins.import_package" {
            let request = serde_json::from_value::<ImportPluginPackageRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let imported = tokio::task::spawn_blocking(move || import_plugin_package(request))
                .await
                .map_err(|error| AppIpcError::new("plugin_import_task_failed", error.to_string()))?
                .map_err(|error| AppIpcError::new("plugin_import_failed", error))?;
            return serde_json::to_value(imported)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.plugins.import_package.finalize"
            || method == "executor.plugins.import_package.rollback"
        {
            let request = serde_json::from_value::<PluginImportMutationRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let rollback = method.ends_with(".rollback");
            tokio::task::spawn_blocking(move || {
                if rollback {
                    rollback_plugin_import(request)
                } else {
                    finalize_plugin_import(request)
                }
            })
            .await
            .map_err(|error| AppIpcError::new("plugin_import_task_failed", error.to_string()))?
            .map_err(|error| AppIpcError::new("plugin_import_mutation_failed", error))?;
            return Ok(Value::Null);
        }

        if method == "executor.plugins.links.list" {
            let request = serde_json::from_value::<ReadPluginCloudLinksRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let links = tokio::task::spawn_blocking(move || read_plugin_cloud_links(request))
                .await
                .map_err(|error| AppIpcError::new("plugin_links_task_failed", error.to_string()))?
                .map_err(|error| AppIpcError::new("plugin_links_read_failed", error))?;
            return serde_json::to_value(links)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.plugins.links.link" {
            let request = serde_json::from_value::<LinkPluginReleaseRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            tokio::task::spawn_blocking(move || link_plugin_release(request))
                .await
                .map_err(|error| AppIpcError::new("plugin_links_task_failed", error.to_string()))?
                .map_err(|error| AppIpcError::new("plugin_link_failed", error))?;
            return Ok(Value::Null);
        }

        if method == "executor.plugins.links.unlink" {
            let request = serde_json::from_value::<UnlinkPluginReleaseRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            tokio::task::spawn_blocking(move || unlink_plugin_release(request))
                .await
                .map_err(|error| AppIpcError::new("plugin_links_task_failed", error.to_string()))?
                .map_err(|error| AppIpcError::new("plugin_unlink_failed", error))?;
            return Ok(Value::Null);
        }

        if method == "executor.plugins.personal.import_copy" {
            let request = serde_json::from_value::<ImportPersonalPluginCopyRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let imported = import_personal_plugin_copy(request)
                .await
                .map_err(|error| AppIpcError::new("plugin_personal_copy_import_failed", error))?;
            return serde_json::to_value(imported)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.plugins.personal.rollback_copy" {
            let request = serde_json::from_value::<RollbackPersonalPluginCopyRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            tokio::task::spawn_blocking(move || rollback_personal_plugin_copy(request))
                .await
                .map_err(|error| {
                    AppIpcError::new(
                        "plugin_personal_copy_rollback_task_failed",
                        error.to_string(),
                    )
                })?
                .map_err(|error| AppIpcError::new("plugin_personal_copy_rollback_failed", error))?;
            return Ok(Value::Null);
        }

        if method == "executor.plugins.personal.list" {
            let request = serde_json::from_value::<ListPersonalPluginsRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let plugins = tokio::task::spawn_blocking(move || list_personal_plugins(request))
                .await
                .map_err(|error| {
                    AppIpcError::new("plugin_personal_list_task_failed", error.to_string())
                })?
                .map_err(|error| AppIpcError::new("plugin_personal_list_failed", error))?;
            return serde_json::to_value(plugins)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.plugins.personal.ensure" {
            let request = serde_json::from_value::<EnsurePersonalPluginRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let ensured = tokio::task::spawn_blocking(move || ensure_personal_plugin(request))
                .await
                .map_err(|error| {
                    AppIpcError::new("plugin_personal_ensure_task_failed", error.to_string())
                })?
                .map_err(|error| AppIpcError::new("plugin_personal_ensure_failed", error))?;
            return serde_json::to_value(ensured)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.plugins.personal.package" {
            let request = serde_json::from_value::<PackagePersonalPluginRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let package = tokio::task::spawn_blocking(move || package_personal_plugin(request))
                .await
                .map_err(|error| {
                    AppIpcError::new("plugin_personal_package_task_failed", error.to_string())
                })?
                .map_err(|error| AppIpcError::new("plugin_personal_package_failed", error))?;
            return serde_json::to_value(package)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.plugins.personal.package.cleanup" {
            let request = serde_json::from_value::<CleanupPersonalPluginPackageRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            tokio::task::spawn_blocking(move || cleanup_personal_plugin_package(request))
                .await
                .map_err(|error| {
                    AppIpcError::new(
                        "plugin_personal_package_cleanup_task_failed",
                        error.to_string(),
                    )
                })?
                .map_err(|error| {
                    AppIpcError::new("plugin_personal_package_cleanup_failed", error)
                })?;
            return Ok(Value::Null);
        }

        if method == "executor.plugins.personal.delete" {
            let request = serde_json::from_value::<DeletePersonalPluginRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            tokio::task::spawn_blocking(move || delete_personal_plugin(request))
                .await
                .map_err(|error| AppIpcError::new("plugin_delete_task_failed", error.to_string()))?
                .map_err(|error| AppIpcError::new("plugin_delete_failed", error))?;
            return Ok(Value::Null);
        }

        if method == "executor.plugins.store.list" {
            let listed = tokio::task::spawn_blocking(list_wegent_store_plugins)
                .await
                .map_err(|error| {
                    AppIpcError::new("plugin_store_list_task_failed", error.to_string())
                })?
                .map_err(|error| AppIpcError::new("plugin_store_list_failed", error))?;
            return serde_json::to_value(listed)
                .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()));
        }

        if method == "executor.plugins.manifest.read" {
            let request = serde_json::from_value::<ReadPluginManifestRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let manifest = tokio::task::spawn_blocking(move || read_plugin_manifest(request))
                .await
                .map_err(|error| {
                    AppIpcError::new("plugin_manifest_read_task_failed", error.to_string())
                })?
                .map_err(|error| AppIpcError::new("plugin_manifest_read_failed", error))?;
            return Ok(manifest);
        }

        if method == "executor.plugins.example.save" {
            let request = serde_json::from_value::<SavePluginExampleRequest>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            let saved = tokio::task::spawn_blocking(move || save_plugin_example(request))
                .await
                .map_err(|error| {
                    AppIpcError::new("plugin_example_save_task_failed", error.to_string())
                })?
                .map_err(|error| AppIpcError::new("plugin_example_save_failed", error))?;
            return Ok(Value::String(saved));
        }

        if method == "executor.backend.configure" {
            let Some(handler) = &self.backend_connection_handler else {
                return Err(AppIpcError::new(
                    "backend_connection_unavailable",
                    "Backend connection handler is not available",
                ));
            };
            return handler.configure_backend(params).await;
        }

        if method == "executor.backend.status" {
            let Some(handler) = &self.backend_connection_handler else {
                return Err(AppIpcError::new(
                    "backend_connection_unavailable",
                    "Backend connection handler is not available",
                ));
            };
            return handler.backend_status().await;
        }

        if method == "executor.backend.quota" {
            let Some(handler) = &self.backend_connection_handler else {
                return Err(AppIpcError::new(
                    "backend_connection_unavailable",
                    "Backend connection handler is not available",
                ));
            };
            return handler.backend_quota().await;
        }

        if method == "device.execute_command" {
            return self.handle_device_command(params).await;
        }

        if method == "executions.claim_next" {
            let Some(handler) = &self.runtime_work_handler else {
                return Err(AppIpcError::new(
                    "runtime_unavailable",
                    "Runtime work handler is not available",
                ));
            };
            let runtime_instance_id = self.runtime_instance_id.as_ref().ok_or_else(|| {
                AppIpcError::new(
                    "runtime_identity_unavailable",
                    "Runtime instance identity is not available",
                )
            })?;
            let capacity = handler
                .handle_runtime_rpc(json!({
                    "method": "runtime.capacity.get",
                    "payload": {},
                }))
                .await?;
            let limit = capacity
                .get("limit")
                .and_then(Value::as_u64)
                .filter(|value| (1..=20).contains(value))
                .ok_or_else(|| {
                    AppIpcError::new(
                        "runtime_capacity_unavailable",
                        "Runtime capacity is not available",
                    )
                })?;
            let mut params = params.as_object().cloned().ok_or_else(|| {
                AppIpcError::new("invalid_request", "Claim params must be an object")
            })?;
            let claim = params
                .get_mut("claim")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| AppIpcError::new("invalid_request", "Claim must be an object"))?;
            claim.insert(
                "execution_device_id".to_owned(),
                Value::String(self.device_id.clone()),
            );
            claim.insert(
                "runtime_instance_id".to_owned(),
                Value::String(runtime_instance_id.clone()),
            );
            claim.insert("device_capacity".to_owned(), Value::from(limit));
            claim.insert(
                "runtime_active".to_owned(),
                capacity.get("active").cloned().ok_or_else(|| {
                    AppIpcError::new(
                        "runtime_capacity_unavailable",
                        "Runtime active capacity is not available",
                    )
                })?,
            );
            claim.insert(
                "runtime_active_task_ids".to_owned(),
                capacity.get("active_task_ids").cloned().ok_or_else(|| {
                    AppIpcError::new(
                        "runtime_capacity_unavailable",
                        "Runtime active task identities are not available",
                    )
                })?,
            );
            return handle_task_runtime_request(method, Value::Object(params)).await;
        }

        if method.starts_with("projects.")
            || method.starts_with("external_projects.")
            || method.starts_with("dws.")
            || method.starts_with("aitable.")
            || method.starts_with("todos.")
            || method.starts_with("external_todos.")
            || method.starts_with("external_attachments.")
            || method.starts_with("runtime_tasks.")
            || method.starts_with("files.")
            || method.starts_with("attachments.")
            || method.starts_with("deliveries.")
            || method.starts_with("chat_agents.")
            || method.starts_with("executions.")
        {
            let should_reconcile_before = method == "todos.list";
            let should_reconcile_after = matches!(method, "todos.bind" | "projects.bind_task");
            if should_reconcile_before {
                if let Some(handler) = &self.runtime_work_handler {
                    handler.reconcile_bound_task_statuses().await;
                }
            }
            let result = handle_task_runtime_request(method, params).await?;
            if should_reconcile_after {
                if let Some(handler) = &self.runtime_work_handler {
                    handler.reconcile_bound_task_statuses().await;
                }
            }
            return Ok(result);
        }

        if method.starts_with("runtime.") {
            let Some(handler) = &self.runtime_work_handler else {
                return Err(AppIpcError::new(
                    "runtime_unavailable",
                    "Runtime work handler is not available",
                ));
            };
            return handler
                .handle_runtime_rpc(json!({"method": method, "payload": params}))
                .await;
        }

        if method == "codex.app_server_request" {
            let Some(handler) = &self.runtime_work_handler else {
                return Err(AppIpcError::new(
                    "codex_app_server_unavailable",
                    "Codex app-server handler is not available",
                ));
            };
            return handler.handle_codex_app_server_rpc(params).await;
        }

        Err({
            eprintln!("[app-ipc] unsupported method: {method}");
            AppIpcError::new(
                "unsupported_method",
                format!("Unsupported app IPC method: {method}"),
            )
        })
    }

    pub fn event_message(&self, event: &str, payload: Value) -> Value {
        let mut normalized_payload = payload.as_object().cloned().unwrap_or_default();
        normalized_payload
            .entry("device_id".to_owned())
            .or_insert_with(|| Value::String(self.device_id.clone()));

        json!({
            "type": "event",
            "event": event,
            "payload": normalized_payload,
        })
    }

    pub fn emit_event(&self, event: &str, payload: Value) -> Result<usize, String> {
        self.event_tx
            .send(self.event_message(event, payload))
            .map_err(|error| error.to_string())
    }

    pub fn ready_event(&self) -> Value {
        let mut payload = json!({
            "device_id": self.device_id,
            "ready": true,
            "version": get_version(),
            "protocol_version": APP_IPC_PROTOCOL_VERSION,
            "capabilities": APP_IPC_CAPABILITIES,
        });
        if let Some(runtime_instance_id) = &self.runtime_instance_id {
            payload["runtime_instance_id"] = Value::String(runtime_instance_id.clone());
        }
        self.event_message("executor.ready", payload)
    }

    fn protocol_description(&self) -> Value {
        json!({
            "protocol_version": APP_IPC_PROTOCOL_VERSION,
            "device_id": self.device_id,
            "runtime_instance_id": self.runtime_instance_id,
            "capabilities": APP_IPC_CAPABILITIES,
            "renderer_methods": APP_IPC_RENDERER_METHODS,
            "transports": [
                "stdio-ndjson",
                "local-endpoint-ndjson",
                "local-endpoint-event-stream",
                "socketio-runtime-relay"
            ],
            "features": {
                "request_response": true,
                "events": true,
                "structured_errors": true,
                "compressed_responses": true,
                "event_resume": true,
            },
        })
    }

    pub async fn serve_stdio(&self) -> Result<(), String> {
        reserve_executor_stdout_for_protocol();
        write_executor_log_line(&app_ipc_stdio_ready_log_line(&self.device_id));
        self.serve_io(tokio::io::stdin(), tokio::io::stdout()).await
    }

    pub async fn serve_local_endpoint(
        &self,
        endpoint: &str,
        token: &str,
        owner_token: &str,
    ) -> Result<(), String> {
        validate_local_endpoint_credentials(endpoint, token)?;
        validate_local_endpoint_credentials(endpoint, owner_token)?;
        self.serve_platform_endpoint(endpoint, token, owner_token)
            .await
    }

    #[cfg(unix)]
    async fn serve_platform_endpoint(
        &self,
        endpoint: &str,
        token: &str,
        owner_token: &str,
    ) -> Result<(), String> {
        let path = Path::new(endpoint);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create app IPC socket directory: {error}"))?;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("failed to secure app IPC socket directory: {error}"))?;
        }
        remove_stale_unix_socket(path).await?;
        let listener = UnixListener::bind(path)
            .map_err(|error| format!("failed to bind app IPC Unix socket: {error}"))?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to secure app IPC Unix socket: {error}"))?;
        let (owner_closed_tx, mut owner_closed_rx) = mpsc::channel::<()>(1);
        loop {
            let (stream, _) = tokio::select! {
                _ = owner_closed_rx.recv() => return Ok(()),
                accepted = listener.accept() => accepted
                    .map_err(|error| format!("failed to accept app IPC Unix socket: {error}"))?,
            };
            let server = self.clone();
            let token = token.to_owned();
            let owner_token = owner_token.to_owned();
            let owner_closed_tx = owner_closed_tx.clone();
            tokio::spawn(async move {
                match server
                    .serve_authenticated_stream(stream, &token, &owner_token)
                    .await
                {
                    Ok(Some(LocalEndpointRole::Owner)) => {
                        let _ = owner_closed_tx.send(()).await;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        write_executor_log_line(&format_executor_log(
                            "app IPC local endpoint connection closed",
                            &[("error", error)],
                        ));
                    }
                }
            });
        }
    }

    #[cfg(windows)]
    async fn serve_platform_endpoint(
        &self,
        endpoint: &str,
        token: &str,
        owner_token: &str,
    ) -> Result<(), String> {
        if !endpoint.starts_with(r"\\.\pipe\") {
            return Err("app IPC named pipe must use the \\\\.\\pipe\\ prefix".to_owned());
        }
        let mut first_instance = true;
        let mut pipe = create_named_pipe_server(endpoint, first_instance)?;
        let (owner_closed_tx, mut owner_closed_rx) = mpsc::channel::<()>(1);
        loop {
            tokio::select! {
                _ = owner_closed_rx.recv() => return Ok(()),
                connected = pipe.connect() => connected
                    .map_err(|error| format!("failed to accept app IPC named pipe: {error}"))?,
            }
            let connected = pipe;
            first_instance = false;
            pipe = create_named_pipe_server(endpoint, first_instance)?;
            let server = self.clone();
            let token = token.to_owned();
            let owner_token = owner_token.to_owned();
            let owner_closed_tx = owner_closed_tx.clone();
            tokio::spawn(async move {
                match server
                    .serve_authenticated_stream(connected, &token, &owner_token)
                    .await
                {
                    Ok(Some(LocalEndpointRole::Owner)) => {
                        let _ = owner_closed_tx.send(()).await;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        write_executor_log_line(&format_executor_log(
                            "app IPC local endpoint connection closed",
                            &[("error", error)],
                        ));
                    }
                }
            });
        }
    }

    async fn serve_authenticated_stream<S>(
        &self,
        mut stream: S,
        token: &str,
        owner_token: &str,
    ) -> Result<Option<LocalEndpointRole>, String>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let Some(authentication) =
            authenticate_local_endpoint(&mut stream, token, owner_token).await?
        else {
            return Ok(None);
        };
        let role = authentication.role;
        let (reader, writer) = split(stream);
        let result = if authentication.event_stream {
            self.serve_event_stream(
                writer,
                authentication.after_sequence,
                authentication.replay_existing,
            )
            .await
        } else {
            self.serve_io_inner(
                reader,
                writer,
                APP_IPC_BULK_WRITE_BUFFER_CAPACITY,
                authentication.receive_events,
            )
            .await
        };
        if let Err(error) = result {
            if role != LocalEndpointRole::Owner {
                return Err(error);
            }
            write_executor_log_line(&format_executor_log(
                "app IPC owner connection closed",
                &[("error", error)],
            ));
        }
        Ok(Some(role))
    }

    pub async fn serve_io<R, W>(&self, reader: R, writer: W) -> Result<(), String>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        self.serve_io_with_bulk_write_buffer_capacity(
            reader,
            writer,
            APP_IPC_BULK_WRITE_BUFFER_CAPACITY,
        )
        .await
    }

    async fn serve_io_with_bulk_write_buffer_capacity<R, W>(
        &self,
        reader: R,
        writer: W,
        bulk_write_buffer_capacity: usize,
    ) -> Result<(), String>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        self.serve_io_inner(reader, writer, bulk_write_buffer_capacity, true)
            .await
    }

    async fn serve_io_inner<R, W>(
        &self,
        reader: R,
        writer: W,
        bulk_write_buffer_capacity: usize,
        receive_events: bool,
    ) -> Result<(), String>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        self.event_hub.ensure_started();
        let (priority_write_tx, mut priority_write_rx) =
            mpsc::channel::<Value>(APP_IPC_WRITE_BUFFER_CAPACITY);
        let (event_write_tx, mut event_write_rx) =
            mpsc::channel::<Value>(bulk_write_buffer_capacity);
        let mut writer_task = tokio::spawn(async move {
            let mut writer = writer;
            loop {
                let message = tokio::select! {
                    biased;
                    Some(message) = priority_write_rx.recv() => message,
                    Some(message) = event_write_rx.recv() => message,
                    else => break,
                };
                write_message(&mut writer, &message)
                    .await
                    .map_err(|error| format!("failed to write app IPC message: {error}"))?;
            }
            Ok::<(), String>(())
        });

        priority_write_tx
            .send(self.ready_event())
            .await
            .map_err(|error| format!("failed to queue app IPC ready event: {error}"))?;

        let mut reader = BufReader::new(reader);
        let mut events = self.event_hub.subscribe_live();
        let mut frame = Vec::new();
        let mut bulk_backpressure_reported = false;
        loop {
            frame.clear();
            tokio::select! {
                writer = &mut writer_task => {
                    return match writer {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(error)) => Err(error),
                        Err(error) => Err(format!("app IPC writer task failed: {error}")),
                    };
                }
                read = reader.read_until(b'\n', &mut frame) => {
                    let bytes_read = read
                        .map_err(|error| format!("failed to read app IPC request: {error}"))?;
                    if bytes_read == 0 {
                        writer_task.abort();
                        return Ok(());
                    }
                    let request_line = match std::str::from_utf8(&frame) {
                        Ok(line) => line.to_owned(),
                        Err(error) => {
                            log_invalid_app_ipc_frame(&frame, error);
                            continue;
                        }
                    };
                    let server = self.clone();
                    let response_tx = priority_write_tx.clone();
                    let (request_id, method, command_key) =
                        app_ipc_request_metadata(&request_line);
                    tokio::spawn(async move {
                        let started_at = Instant::now();
                        log_app_ipc_request(
                            "app IPC request started",
                            request_id.as_deref(),
                            method.as_deref(),
                            command_key.as_deref(),
                            None,
                            None,
                        );
                        let response = match tokio::time::timeout(
                            Duration::from_secs(APP_IPC_REQUEST_TIMEOUT_SECONDS),
                            server.handle_line(&request_line),
                        )
                        .await
                        {
                            Ok(response) => response,
                            Err(_) => {
                                log_app_ipc_request(
                                    "app IPC request timed out",
                                    request_id.as_deref(),
                                    method.as_deref(),
                                    command_key.as_deref(),
                                    Some(started_at.elapsed().as_millis()),
                                    None,
                                );
                                Some(error_message(
                                    request_id.as_deref(),
                                    &AppIpcError::new(
                                        "request_timeout",
                                        format!(
                                            "app IPC request timed out after {APP_IPC_REQUEST_TIMEOUT_SECONDS}s"
                                        ),
                                    ),
                                ))
                            }
                        };

                        if let Some(response) = response {
                            let ok = response.get("ok").and_then(Value::as_bool);
                            let elapsed_ms = started_at.elapsed().as_millis();
                            let response_bytes =
                                serde_json::to_vec(&response).map_or(0, |bytes| bytes.len());
                            log_app_ipc_request(
                                "app IPC request finished",
                                request_id.as_deref(),
                                method.as_deref(),
                                command_key.as_deref(),
                                Some(elapsed_ms),
                                ok,
                            );
                            if ok == Some(false) {
                                log_app_ipc_response_error(
                                    request_id.as_deref(),
                                    method.as_deref(),
                                    elapsed_ms,
                                    &response,
                                );
                            }
                            let queue_started_at = Instant::now();
                            if response_tx.send(response).await.is_err() {
                                log_app_ipc_request(
                                    "app IPC response dropped",
                                    request_id.as_deref(),
                                    method.as_deref(),
                                    command_key.as_deref(),
                                    Some(elapsed_ms),
                                    ok,
                                );
                            } else {
                                let queue_wait_ms = queue_started_at.elapsed().as_millis();
                                let mut fields = Vec::new();
                                if let Some(request_id) = request_id.as_deref() {
                                    fields.push(("request_id", request_id.to_owned()));
                                }
                                if let Some(method) = method.as_deref() {
                                    fields.push(("method", method.to_owned()));
                                }
                                if let Some(command_key) = command_key.as_deref() {
                                    fields.push(("command_key", command_key.to_owned()));
                                }
                                fields.push(("response_bytes", response_bytes.to_string()));
                                fields.push(("queue_wait_ms", queue_wait_ms.to_string()));
                                write_executor_log_line(&format_executor_log(
                                    "app IPC response queued",
                                    &fields,
                                ));
                            }
                        } else {
                            log_app_ipc_request(
                                "app IPC request ignored",
                                request_id.as_deref(),
                                method.as_deref(),
                                command_key.as_deref(),
                                Some(started_at.elapsed().as_millis()),
                                None,
                            );
                        }
                    });
                }
                event = events.recv(), if receive_events => {
                    match event {
                        Ok(message) => {
                            if is_bulk_app_ipc_event(&message) {
                                match event_write_tx.try_send(message) {
                                    Ok(()) => bulk_backpressure_reported = false,
                                    Err(mpsc::error::TrySendError::Full(_)) => {
                                        if !bulk_backpressure_reported {
                                            bulk_backpressure_reported = true;
                                            write_executor_error_line(&format_executor_log(
                                                "app IPC bulk event backpressure; transcript recovery requested",
                                                &[(
                                                    "capacity",
                                                    bulk_write_buffer_capacity.to_string(),
                                                )],
                                            ));
                                            let lagged = self.event_message(
                                                "executor.event_lagged",
                                                json!({
                                                    "skipped": 1,
                                                    "reason": "ipc_backpressure",
                                                }),
                                            );
                                            event_write_tx.send(lagged)
                                                .await
                                                .map_err(|error| format!(
                                                    "failed to queue app IPC backpressure event: {error}"
                                                ))?;
                                        }
                                    }
                                    Err(mpsc::error::TrySendError::Closed(_)) => {
                                        return Err("app IPC event writer queue closed".to_owned());
                                    }
                                }
                            } else {
                                if event_write_tx.capacity() == 0 {
                                    write_executor_error_line(&format_executor_log(
                                        "app IPC ordered event backpressure",
                                        &[(
                                            "capacity",
                                            bulk_write_buffer_capacity.to_string(),
                                        )],
                                    ));
                                }
                                event_write_tx.send(message)
                                    .await
                                    .map_err(|error| format!(
                                        "failed to queue ordered app IPC event: {error}"
                                    ))?;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            let message = self.event_message(
                                "executor.event_lagged",
                                json!({
                                    "skipped": skipped,
                                    "reason": "app_ipc_backpressure",
                                }),
                            );
                            event_write_tx.send(message)
                                .await
                                .map_err(|error| format!("failed to queue app IPC lag event: {error}"))?;
                        }
                        Err(broadcast::error::RecvError::Closed) => return Ok(()),
                    }
                }
            }
        }
    }

    async fn serve_event_stream<W>(
        &self,
        mut writer: W,
        after: u64,
        replay_existing: bool,
    ) -> Result<(), String>
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        self.event_hub.ensure_started();
        let mut subscription = if replay_existing {
            self.event_hub.subscribe_after(after)
        } else {
            self.event_hub.subscribe_from_now()
        };
        let mut delivered_sequence = after.max(subscription.resume_after);
        if !replay_existing {
            write_message(
                &mut writer,
                &json!({
                    "type": "event",
                    "protocolVersion": 1,
                    "sequence": delivered_sequence,
                    "emittedAt": chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    "event": "executor.stream.cursor",
                    "payload": {},
                }),
            )
            .await
            .map_err(|error| format!("failed to write executor event stream cursor: {error}"))?;
        }
        loop {
            for event in subscription.replay.drain(..) {
                write_message(&mut writer, &event)
                    .await
                    .map_err(|error| format!("failed to write executor event stream: {error}"))?;
                delivered_sequence = event_sequence(&event).unwrap_or(delivered_sequence);
            }
            delivered_sequence = delivered_sequence.max(subscription.resume_after);
            match subscription.receiver.recv().await {
                Ok(event) => {
                    let sequence = event_sequence(&event).unwrap_or(delivered_sequence);
                    if sequence <= delivered_sequence {
                        continue;
                    }
                    write_message(&mut writer, &event).await.map_err(|error| {
                        format!("failed to write live executor event stream: {error}")
                    })?;
                    delivered_sequence = sequence;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    subscription = self.event_hub.subscribe_after(delivered_sequence);
                }
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            }
        }
    }

    async fn handle_device_command(&self, params: Value) -> Result<Value, AppIpcError> {
        let command_key = string_field(&params, "command_key")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppIpcError::new("bad_request", "command_key is required"))?;
        let command_key = command_key.trim();

        if command_key == "git_generate_commit_message" {
            let cwd = string_field(&params, "path").or_else(|| string_field(&params, "cwd"));
            let env = string_env(params.get("env"))?;
            let result = generate_commit_message(cwd, env).await;
            return serde_json::to_value(result)
                .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }

        if command_key == "ls_skills" {
            let result = list_local_skills().await;
            return serde_json::to_value(result)
                .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }

        // Git queries that used to run through `bash` or `python3` run natively
        // so they work on Windows machines where those interpreters are not on
        // PATH (Git for Windows only adds `cmd\`, which has git but no bash).
        let native_path = string_field(&params, "path").or_else(|| string_field(&params, "cwd"));
        let native_env = string_env(params.get("env"))?;
        let native_timeout =
            positive_number(params.get("timeout_seconds"), DEFAULT_TIMEOUT_SECONDS);
        let native_max_output = positive_number(
            params.get("max_output_bytes"),
            DEFAULT_MAX_OUTPUT_BYTES as f64,
        )
        .round() as usize;
        let native_args = string_list(params.get("args")).unwrap_or_default();
        let native_result = match command_key {
            "git_diff" => Some(
                workspace_diff(
                    native_path.clone(),
                    &native_env,
                    native_timeout,
                    native_max_output,
                )
                .await,
            ),
            "git_branch_diff" => Some(
                branch_diff(
                    native_path.clone(),
                    &native_env,
                    native_timeout,
                    native_max_output,
                )
                .await,
            ),
            "git_branch_diff_shortstat" => Some(
                branch_diff_shortstat(
                    native_path.clone(),
                    &native_env,
                    native_timeout,
                    native_max_output,
                )
                .await,
            ),
            "git_github_cli_status" => {
                Some(hosting_cli_status("gh", &native_env, native_timeout).await)
            }
            "git_gitlab_cli_status" => {
                Some(hosting_cli_status("glab", &native_env, native_timeout).await)
            }
            "git_push" => Some(
                push_current_branch(
                    native_path.clone(),
                    &native_env,
                    native_timeout,
                    native_max_output,
                )
                .await,
            ),
            "git_worktree_add" => Some(
                worktree_add(&native_args, &native_env, native_timeout, native_max_output).await,
            ),
            "git_worktree_remove" => Some(
                worktree_remove(&native_args, &native_env, native_timeout, native_max_output).await,
            ),
            "turn_file_changes_review" | "turn_file_changes_revert" => {
                let artifact_id = native_args.first().map(String::as_str).unwrap_or_default();
                let mode = if command_key == "turn_file_changes_review" {
                    "review"
                } else {
                    "revert"
                };
                Some(
                    turn_file_changes_command(
                        mode,
                        artifact_id,
                        native_path.as_deref(),
                        &native_env,
                        native_max_output,
                    )
                    .await,
                )
            }
            _ => None,
        };
        if let Some(result) = native_result {
            return serde_json::to_value(result)
                .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }

        let args = string_list(params.get("args"))?;
        let path = string_field(&params, "path").or_else(|| string_field(&params, "cwd"));
        let mut env = string_env(params.get("env"))?;
        if is_workspace_file_command(command_key) {
            if !env.contains_key(WORKSPACE_ROOTS_ENV) {
                if let Some(path) = path.as_ref() {
                    env.insert(WORKSPACE_ROOTS_ENV.to_owned(), path.clone());
                }
            }
            return serde_json::to_value(
                execute_workspace_file_command_with_input(
                    command_key,
                    path,
                    args,
                    env,
                    string_field(&params, "stdin"),
                )
                .await,
            )
            .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }

        if is_git_workspace_inspection_command(command_key)
            && path
                .as_deref()
                .is_some_and(|workspace| !git_is_worktree(workspace))
        {
            return serde_json::to_value(CommandResult::error(
                "Workspace is not a Git repository".to_owned(),
                0.0,
                false,
            ))
            .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }

        if let Some((result, post_processor)) =
            handle_builtin_device_command(command_key, &params).await
        {
            return serde_json::to_value(apply_post_processor(result, post_processor))
                .map_err(|error| AppIpcError::new("internal_error", error.to_string()));
        }

        let command = local_app_command(command_key).ok_or_else(|| {
            AppIpcError::new(
                "unknown_command",
                format!("Device command key '{command_key}' is not configured"),
            )
        })?;

        let request = CommandRequest {
            command: command.command.to_owned(),
            argv: command
                .argv
                .iter()
                .map(|item| (*item).to_owned())
                .chain(args)
                .collect(),
            cwd: string_field(&params, "path").or_else(|| string_field(&params, "cwd")),
            env,
            timeout_seconds: positive_number(
                params.get("timeout_seconds"),
                DEFAULT_TIMEOUT_SECONDS,
            ),
            max_output_bytes: positive_number(
                params.get("max_output_bytes"),
                DEFAULT_MAX_OUTPUT_BYTES as f64,
            )
            .round() as usize,
        };

        let result = self.command_handler.handle_execute_command(request).await;
        serde_json::to_value(apply_post_processor(result, command.post_processor))
            .map_err(|error| AppIpcError::new("internal_error", error.to_string()))
    }
}

fn validate_local_endpoint_credentials(endpoint: &str, token: &str) -> Result<(), String> {
    if endpoint.trim().is_empty() {
        return Err("app IPC local endpoint is required".to_owned());
    }
    if token.len() < 32 || token.len() > 1024 {
        return Err("app IPC local endpoint token must contain 32-1024 bytes".to_owned());
    }
    Ok(())
}

struct LocalEndpointAuthentication {
    role: LocalEndpointRole,
    event_stream: bool,
    after_sequence: u64,
    replay_existing: bool,
    receive_events: bool,
}

async fn authenticate_local_endpoint<S>(
    stream: &mut S,
    expected_token: &str,
    expected_owner_token: &str,
) -> Result<Option<LocalEndpointAuthentication>, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let frame = tokio::time::timeout(
        Duration::from_secs(APP_IPC_AUTH_TIMEOUT_SECONDS),
        read_auth_frame(stream),
    )
    .await
    .map_err(|_| "app IPC local endpoint authentication timed out".to_owned())??;
    let request = parse_auth_request(&frame);
    let role = request.as_ref().and_then(|request| {
        if constant_time_equal(request.token.as_bytes(), expected_owner_token.as_bytes()) {
            Some(LocalEndpointRole::Owner)
        } else if constant_time_equal(request.token.as_bytes(), expected_token.as_bytes()) {
            Some(LocalEndpointRole::Client)
        } else {
            None
        }
    });
    let response = if role.is_some() {
        json!({
            "type": "authenticated",
            "ok": true,
            "protocol_version": APP_IPC_PROTOCOL_VERSION,
        })
    } else {
        json!({
            "type": "authenticated",
            "ok": false,
            "error": {
                "code": "authentication_failed",
                "message": "Local executor authentication failed",
            },
        })
    };
    write_message(stream, &response)
        .await
        .map_err(|error| format!("failed to write app IPC authentication response: {error}"))?;
    Ok(role.map(|role| LocalEndpointAuthentication {
        role,
        event_stream: request.as_ref().is_some_and(|request| request.event_stream),
        after_sequence: request.as_ref().map_or(0, |request| request.after_sequence),
        replay_existing: request
            .as_ref()
            .map_or(true, |request| request.replay_existing),
        receive_events: request
            .as_ref()
            .map_or(true, |request| request.receive_events),
    }))
}

async fn read_auth_frame<S>(stream: &mut S) -> Result<Vec<u8>, String>
where
    S: AsyncRead + Unpin,
{
    let mut frame = Vec::with_capacity(256);
    let mut byte = [0_u8; 1];
    while frame.len() < APP_IPC_MAX_AUTH_FRAME_BYTES {
        let count = stream
            .read(&mut byte)
            .await
            .map_err(|error| format!("failed to read app IPC authentication frame: {error}"))?;
        if count == 0 {
            return Err("app IPC local endpoint closed before authentication".to_owned());
        }
        if byte[0] == b'\n' {
            return Ok(frame);
        }
        frame.push(byte[0]);
    }
    Err("app IPC authentication frame exceeds size limit".to_owned())
}

struct LocalEndpointAuthRequest {
    token: String,
    event_stream: bool,
    after_sequence: u64,
    replay_existing: bool,
    receive_events: bool,
}

fn parse_auth_request(frame: &[u8]) -> Option<LocalEndpointAuthRequest> {
    let value: Value = serde_json::from_slice(frame).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("authenticate")
        || value.get("protocol_version").and_then(Value::as_u64) != Some(APP_IPC_PROTOCOL_VERSION)
    {
        return None;
    }
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .map(str::to_owned)?;
    Some(LocalEndpointAuthRequest {
        token,
        event_stream: value
            .get("event_stream")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        after_sequence: value
            .get("after_sequence")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        replay_existing: value
            .get("replay_existing")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        receive_events: value
            .get("receive_events")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    })
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let length = left.len().max(right.len());
    for index in 0..length {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

#[cfg(unix)]
async fn remove_stale_unix_socket(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to inspect app IPC Unix socket: {error}")),
    };
    if !metadata.file_type().is_socket() {
        return Err("refusing to replace a non-socket app IPC endpoint".to_owned());
    }
    std::fs::remove_file(path)
        .map_err(|error| format!("failed to remove stale app IPC Unix socket: {error}"))
}

#[cfg(windows)]
fn create_named_pipe_server(endpoint: &str, first: bool) -> Result<NamedPipeServer, String> {
    ServerOptions::new()
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .create(endpoint)
        .map_err(|error| format!("failed to create app IPC named pipe: {error}"))
}

fn is_bulk_app_ipc_event(message: &Value) -> bool {
    match message.get("event").and_then(Value::as_str) {
        Some("runtime.plan.updated") => true,
        Some("response.block.created") => {
            app_ipc_event_data(message)
                .and_then(|data| data.get("block"))
                .and_then(|block| block.get("type"))
                .and_then(Value::as_str)
                == Some("file_changes")
        }
        Some("response.block.updated") => app_ipc_event_data(message)
            .and_then(|data| data.get("updates"))
            .is_some_and(|updates| {
                updates.get("tool_output_delta").is_some()
                    || updates.get("file_changes").is_some()
                    || ((updates.get("content").and_then(Value::as_str).is_some()
                        || updates
                            .get("content_delta")
                            .and_then(Value::as_str)
                            .is_some())
                        && updates.get("status").and_then(Value::as_str) == Some("streaming"))
            }),
        _ => false,
    }
}

fn app_ipc_event_data(message: &Value) -> Option<&Value> {
    message
        .get("payload")
        .and_then(|payload| payload.get("data"))
}

async fn handle_task_runtime_request(method: &str, params: Value) -> Result<Value, AppIpcError> {
    let runtime = TaskRuntime::from_env().map_err(task_runtime_error)?;
    match method {
        "dws.auth_status" => serialize_task_value(
            runtime
                .dws_auth_status()
                .await
                .map_err(task_runtime_error)?,
        ),
        "dws.auth_login" => {
            serialize_task_value(runtime.dws_auth_login().await.map_err(task_runtime_error)?)
        }
        "dws.auth_logout" => {
            runtime
                .dws_auth_logout()
                .await
                .map_err(task_runtime_error)?;
            Ok(json!({}))
        }
        "projects.list" => {
            serialize_task_value(runtime.list_projects().map_err(task_runtime_error)?)
        }
        "projects.create" => {
            let input = serde_json::from_value::<ProjectCreate>(params)
                .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            serialize_task_value(runtime.create_project(input).map_err(task_runtime_error)?)
        }
        "projects.update" => {
            let project_id = required_task_string(&params, "project_id")?;
            let input = task_input::<ProjectUpdate>(&params, "project")?;
            serialize_task_value(
                runtime
                    .update_project(project_id, input)
                    .map_err(task_runtime_error)?,
            )
        }
        "projects.archive" => {
            let project_id = required_task_string(&params, "project_id")?;
            let version = params
                .get("version")
                .and_then(Value::as_i64)
                .ok_or_else(|| AppIpcError::new("bad_request", "version is required"))?;
            runtime
                .archive_project(project_id, version)
                .map_err(task_runtime_error)?;
            Ok(json!({}))
        }
        "external_projects.configure" => {
            let project = task_input::<ProjectDescriptor>(&params, "project")?;
            serialize_task_value(
                runtime
                    .configure_external_project(project)
                    .map_err(task_runtime_error)?,
            )
        }
        "external_projects.remove" => {
            let project_id = required_task_string(&params, "project_id")?;
            runtime
                .remove_external_project(project_id)
                .map_err(task_runtime_error)?;
            Ok(json!({}))
        }
        "external_projects.retain" => {
            let project_ids = params
                .get("project_ids")
                .and_then(Value::as_array)
                .ok_or_else(|| AppIpcError::new("bad_request", "project_ids must be an array"))?
                .iter()
                .map(|value| {
                    value.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                        AppIpcError::new("bad_request", "project_ids must contain strings")
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            runtime
                .retain_external_projects(&project_ids)
                .map_err(task_runtime_error)?;
            Ok(json!({}))
        }
        "aitable.describe" => {
            let project_id = required_task_string(&params, "project_id")?;
            serialize_task_value(
                runtime
                    .aitable_describe(project_id)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "aitable.list_records" => {
            let project_id = required_task_string(&params, "project_id")?;
            let query = params.get("query").and_then(Value::as_str);
            let cursor = params.get("cursor").and_then(Value::as_str);
            let view_id = params.get("view_id").and_then(Value::as_str);
            let limit = params.get("limit").and_then(Value::as_i64).unwrap_or(100);
            serialize_task_value(
                runtime
                    .aitable_list_records(project_id, query, limit, cursor, view_id)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "aitable.get_record" => {
            let project_id = required_task_string(&params, "project_id")?;
            let record_id = required_task_string(&params, "record_id")?;
            serialize_task_value(
                runtime
                    .aitable_get_record(project_id, record_id)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "aitable.create_record" => {
            let project_id = required_task_string(&params, "project_id")?;
            let cells = params
                .get("cells")
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| AppIpcError::new("bad_request", "cells must be an object"))?;
            serialize_task_value(
                runtime
                    .aitable_create_record(project_id, cells)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "aitable.update_record" => {
            let project_id = required_task_string(&params, "project_id")?;
            let record_id = required_task_string(&params, "record_id")?;
            let cells = params
                .get("cells")
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| AppIpcError::new("bad_request", "cells must be an object"))?;
            serialize_task_value(
                runtime
                    .aitable_update_record(project_id, record_id, cells)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "aitable.delete_record" => {
            let project_id = required_task_string(&params, "project_id")?;
            let record_id = required_task_string(&params, "record_id")?;
            runtime
                .aitable_delete_record(project_id, record_id)
                .await
                .map_err(task_runtime_error)?;
            Ok(json!({}))
        }
        "aitable.create_field" => {
            let project_id = required_task_string(&params, "project_id")?;
            let name = required_task_string(&params, "name")?;
            let field_type = required_task_string(&params, "field_type")?;
            let property = params
                .get("config")
                .or_else(|| params.get("property"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            serialize_task_value(
                runtime
                    .aitable_create_field(project_id, name, field_type, property)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "aitable.update_field" => {
            let project_id = required_task_string(&params, "project_id")?;
            let field_id = required_task_string(&params, "field_id")?;
            let payload = params
                .get("field")
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| AppIpcError::new("bad_request", "field must be an object"))?;
            serialize_task_value(
                runtime
                    .aitable_update_field(project_id, field_id, payload)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "aitable.delete_field" => {
            let project_id = required_task_string(&params, "project_id")?;
            let field_id = required_task_string(&params, "field_id")?;
            runtime
                .aitable_delete_field(project_id, field_id)
                .await
                .map_err(task_runtime_error)?;
            Ok(json!({}))
        }
        "aitable.create_view" => {
            let project_id = required_task_string(&params, "project_id")?;
            let name = required_task_string(&params, "name")?;
            let view_type = required_task_string(&params, "view_type")?;
            serialize_task_value(
                runtime
                    .aitable_create_view(project_id, name, view_type)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "external_todos.list" => {
            let project = task_input::<ProjectDescriptor>(&params, "project")?;
            serialize_task_value(
                runtime
                    .list_external_tasks(project)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "external_todos.get" => {
            let project = task_input::<ProjectDescriptor>(&params, "project")?;
            let task_id = required_task_string(&params, "task_id")?;
            serialize_task_value(
                runtime
                    .get_external_task(project, task_id)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "external_todos.create" => {
            let project = task_input::<ProjectDescriptor>(&params, "project")?;
            let input = task_input::<TaskCreate>(&params, "todo")?;
            serialize_task_value(
                runtime
                    .create_external_task(project, input)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "external_todos.update" => {
            let project = task_input::<ProjectDescriptor>(&params, "project")?;
            let task_id = required_task_string(&params, "task_id")?;
            let input = task_input::<TaskUpdate>(&params, "todo")?;
            serialize_task_value(
                runtime
                    .update_external_task(project, task_id, input)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "external_attachments.list" => {
            let project = task_input::<ProjectDescriptor>(&params, "project")?;
            let task_id = required_task_string(&params, "task_id")?;
            serialize_task_value(
                runtime
                    .list_external_task_attachments(project, task_id)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "external_attachments.add" => {
            let project = task_input::<ProjectDescriptor>(&params, "project")?;
            let task_id = required_task_string(&params, "task_id")?;
            let input = task_input::<BinaryInput>(&params, "file")?;
            serialize_task_value(
                runtime
                    .upload_external_task_attachment(project, task_id, input)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "external_attachments.access" => {
            let project = task_input::<ProjectDescriptor>(&params, "project")?;
            let task_id = required_task_string(&params, "task_id")?;
            let attachment_id = required_task_string(&params, "attachment_id")?;
            Ok(json!({
                "path": runtime
                    .download_external_task_attachment(project, task_id, attachment_id)
                    .await
                    .map_err(task_runtime_error)?
            }))
        }
        "external_attachments.delete" => {
            let project = task_input::<ProjectDescriptor>(&params, "project")?;
            let task_id = required_task_string(&params, "task_id")?;
            let attachment_id = required_task_string(&params, "attachment_id")?;
            runtime
                .delete_external_task_attachment(project, task_id, attachment_id)
                .await
                .map_err(task_runtime_error)?;
            Ok(json!({"deleted": true}))
        }
        "todos.list" => {
            let project_id = required_task_string(&params, "project_id")?;
            serialize_task_value(
                runtime
                    .list_tasks(project_id)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "todos.get" => {
            let project_id = required_task_string(&params, "project_id")?;
            let task_id = required_task_string(&params, "task_id")?;
            serialize_task_value(
                runtime
                    .get_task(project_id, task_id)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "todos.create" => {
            let project_id = required_task_string(&params, "project_id")?;
            let input = serde_json::from_value::<TaskCreate>(
                params
                    .get("todo")
                    .cloned()
                    .unwrap_or_else(|| params.clone()),
            )
            .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            serialize_task_value(
                runtime
                    .create_task(project_id, input)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "todos.update" => {
            let project_id = required_task_string(&params, "project_id")?;
            let task_id = required_task_string(&params, "task_id")?;
            let input = serde_json::from_value::<TaskUpdate>(
                params
                    .get("todo")
                    .cloned()
                    .unwrap_or_else(|| params.clone()),
            )
            .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            serialize_task_value(
                runtime
                    .update_task(project_id, task_id, input)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "todos.archive" => {
            let project_id = required_task_string(&params, "project_id")?;
            let task_id = required_task_string(&params, "task_id")?;
            runtime
                .archive_task(project_id, task_id)
                .await
                .map_err(task_runtime_error)?;
            Ok(json!({}))
        }
        "todos.comment" => {
            let project_id = required_task_string(&params, "project_id")?;
            let task_id = required_task_string(&params, "task_id")?;
            let body = required_task_string(&params, "body")?;
            serialize_task_value(
                runtime
                    .add_comment(project_id, task_id, body)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "todos.comment.list" => {
            let project_id = required_task_string(&params, "project_id")?;
            let task_id = required_task_string(&params, "task_id")?;
            let after_sequence = params
                .get("after_sequence")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            serialize_task_value(
                runtime
                    .list_comments(project_id, task_id, after_sequence)
                    .map_err(task_runtime_error)?,
            )
        }
        "todos.comment.create" => {
            let create = task_input::<LocalCommentCreate>(&params, "comment")?;
            serialize_task_value(runtime.create_comment(create).map_err(task_runtime_error)?)
        }
        "executions.enqueue" => {
            let project_id = required_task_string(&params, "project_id")?;
            let task_id = required_task_string(&params, "task_id")?;
            let agent_id = required_task_string(&params, "agent_id")?;
            let trigger_message_id = params.get("trigger_message_id").and_then(Value::as_str);
            let payload = params.get("payload").cloned().unwrap_or(Value::Null);
            serialize_task_value(
                runtime
                    .enqueue_execution(project_id, task_id, agent_id, payload, trigger_message_id)
                    .map_err(task_runtime_error)?,
            )
        }
        "todos.reorder" => {
            let project_id = required_task_string(&params, "project_id")?;
            let input = serde_json::from_value::<TaskReorder>(
                params
                    .get("reorder")
                    .cloned()
                    .unwrap_or_else(|| params.clone()),
            )
            .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            serialize_task_value(
                runtime
                    .reorder_tasks(project_id, input)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "todos.bindings" => {
            let task_id = required_task_string(&params, "task_id")?;
            serialize_task_value(
                runtime
                    .list_task_bindings(task_id)
                    .map_err(task_runtime_error)?,
            )
        }
        "todos.bindings.batch" => {
            let task_ids = string_list_field(params.get("task_ids"), "task_ids")?;
            serialize_task_value(
                runtime
                    .list_task_bindings_batch(&task_ids)
                    .map_err(task_runtime_error)?,
            )
        }
        "todos.bind" | "projects.bind_task" => {
            let project_id = required_task_string(&params, "project_id")?;
            let item_id = params.get("item_id").and_then(Value::as_str);
            let input = serde_json::from_value::<RuntimeTaskAddress>(
                params
                    .get("task")
                    .cloned()
                    .unwrap_or_else(|| params.clone()),
            )
            .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
            serialize_task_value(
                runtime
                    .bind_task(project_id, item_id, input)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "runtime_tasks.context" => {
            let device_id = required_task_string(&params, "device_id")?;
            let runtime_task_id = required_task_string(&params, "task_id")?;
            serialize_task_value(
                runtime
                    .find_task_binding(device_id, runtime_task_id)
                    .map_err(task_runtime_error)?,
            )
        }
        "runtime_tasks.system_context" => {
            let device_id = required_task_string(&params, "device_id")?;
            let runtime_task_id = required_task_string(&params, "task_id")?;
            serialize_task_value(
                runtime
                    .find_system_task_binding(device_id, runtime_task_id)
                    .map_err(task_runtime_error)?,
            )
        }
        "runtime_tasks.user_context" => {
            let device_id = required_task_string(&params, "device_id")?;
            let runtime_task_id = required_task_string(&params, "task_id")?;
            serialize_task_value(
                runtime
                    .find_user_task_binding(device_id, runtime_task_id)
                    .map_err(task_runtime_error)?,
            )
        }
        "runtime_tasks.unbind" => {
            let device_id = required_task_string(&params, "device_id")?;
            let runtime_task_id = required_task_string(&params, "task_id")?;
            let item_id = params.get("item_id").and_then(Value::as_str);
            runtime
                .unbind_task(device_id, runtime_task_id, item_id)
                .map_err(task_runtime_error)?;
            Ok(json!({"unbound": true}))
        }
        "chat_agents.list" => {
            let project_id = required_task_string(&params, "project_id")?;
            serialize_task_value(
                runtime
                    .list_chat_agents(project_id)
                    .map_err(task_runtime_error)?,
            )
        }
        "chat_agents.create" => {
            let project_id = required_task_string(&params, "project_id")?;
            let input = task_input::<ChatAgentCreate>(&params, "agent")?;
            serialize_task_value(
                runtime
                    .create_chat_agent(project_id, input)
                    .map_err(task_runtime_error)?,
            )
        }
        "chat_agents.update" => {
            let project_id = required_task_string(&params, "project_id")?;
            let agent_id = required_task_string(&params, "agent_id")?;
            let input = task_input::<ChatAgentUpdate>(&params, "agent")?;
            serialize_task_value(
                runtime
                    .update_chat_agent(project_id, agent_id, input)
                    .map_err(task_runtime_error)?,
            )
        }
        "chat_agents.archive" => {
            let project_id = required_task_string(&params, "project_id")?;
            let agent_id = required_task_string(&params, "agent_id")?;
            let version = params
                .get("version")
                .and_then(Value::as_i64)
                .ok_or_else(|| AppIpcError::new("bad_request", "version is required"))?;
            runtime
                .archive_chat_agent(project_id, agent_id, version)
                .map_err(task_runtime_error)?;
            Ok(json!({}))
        }
        "executions.list" => {
            let project_id = required_task_string(&params, "project_id")?;
            let agent_id = params.get("agent_id").and_then(Value::as_str);
            let status = params.get("status").and_then(Value::as_str);
            let include_terminal = params
                .get("include_terminal")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            serialize_task_value(
                runtime
                    .list_executions(project_id, agent_id, status, include_terminal)
                    .map_err(task_runtime_error)?,
            )
        }
        "executions.approve" | "executions.reject" => {
            let execution_id = required_task_i64(&params, "execution_id")?;
            let reason = params
                .get("reason")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            serialize_task_value(if method == "executions.approve" {
                runtime
                    .approve_execution(execution_id)
                    .map_err(task_runtime_error)?
            } else {
                runtime
                    .reject_execution(execution_id, reason)
                    .map_err(task_runtime_error)?
            })
        }
        "executions.cancel" => {
            let execution_id = required_task_i64(&params, "execution_id")?;
            let note = params.get("note").and_then(Value::as_str);
            serialize_task_value(
                runtime
                    .cancel_execution(execution_id, note)
                    .map_err(task_runtime_error)?,
            )
        }
        "executions.claim_next" => {
            let input = task_input::<LocalExecutionClaim>(&params, "claim")?;
            serialize_task_value(
                runtime
                    .claim_next_local_execution(input)
                    .map_err(task_runtime_error)?,
            )
        }
        "executions.heartbeat" => {
            let execution_id = required_task_i64(&params, "execution_id")?;
            let runtime_device_id = params.get("runtime_device_id").and_then(Value::as_str);
            let runtime_task_id = params.get("runtime_task_id").and_then(Value::as_str);
            let lease_seconds = params
                .get("lease_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(300);
            serialize_task_value(
                runtime
                    .heartbeat_execution(
                        execution_id,
                        runtime_device_id,
                        runtime_task_id,
                        lease_seconds,
                    )
                    .map_err(task_runtime_error)?,
            )
        }
        "executions.start_requested"
        | "executions.runtime_start"
        | "executions.dispatch_unknown" => {
            let execution_id = required_task_i64(&params, "execution_id")?;
            let runtime_device_id = required_task_string(&params, "runtime_device_id")?;
            let runtime_task_id = required_task_string(&params, "runtime_task_id")?;
            let lease_seconds = params
                .get("lease_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(300);
            let execution = match method {
                "executions.start_requested" => runtime.request_runtime_start(
                    execution_id,
                    runtime_device_id,
                    runtime_task_id,
                    lease_seconds,
                ),
                "executions.runtime_start" => runtime.confirm_runtime_accepted(
                    execution_id,
                    runtime_device_id,
                    runtime_task_id,
                    lease_seconds,
                ),
                _ => runtime.mark_runtime_dispatch_unknown(
                    execution_id,
                    runtime_device_id,
                    runtime_task_id,
                    params
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Runtime dispatch outcome is unknown"),
                ),
            }
            .map_err(task_runtime_error)?;
            serialize_task_value(execution)
        }
        "executions.dispatch_failed" => {
            let execution_id = required_task_i64(&params, "execution_id")?;
            let error = params
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Local runtime preflight failed");
            serialize_task_value(
                runtime
                    .fail_runtime_preflight(execution_id, error)
                    .map_err(task_runtime_error)?,
            )
        }
        "executions.recover_stale" => {
            let (requeued, unknown) = runtime
                .recover_stale_local_executions()
                .map_err(task_runtime_error)?;
            Ok(json!({
                "requeued": requeued,
                "unknown": unknown,
            }))
        }
        "executions.list_stale" => serialize_task_value(
            runtime
                .stale_local_executions()
                .map_err(task_runtime_error)?,
        ),
        "executions.reconcile" => {
            let execution_id = required_task_i64(&params, "execution_id")?;
            let runtime_status = params
                .get("runtime_status")
                .and_then(Value::as_str)
                .unwrap_or("missing");
            let running = params
                .get("running")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let turn_status = params.get("turn_status").and_then(Value::as_str);
            serialize_task_value(
                runtime
                    .reconcile_execution_snapshot(
                        execution_id,
                        runtime_status,
                        running,
                        turn_status,
                    )
                    .map_err(task_runtime_error)?,
            )
        }
        "files.list" => {
            let project_id = required_task_string(&params, "project_id")?;
            serialize_task_value(
                runtime
                    .list_project_files(project_id)
                    .map_err(task_runtime_error)?,
            )
        }
        "files.create_folder" => {
            let project_id = required_task_string(&params, "project_id")?;
            let path = required_task_string(&params, "path")?;
            serialize_task_value(
                runtime
                    .create_project_folder(project_id, path)
                    .map_err(task_runtime_error)?,
            )
        }
        "files.upload" => {
            let project_id = required_task_string(&params, "project_id")?;
            let path = params.get("path").and_then(Value::as_str);
            let input = task_input::<BinaryInput>(&params, "file")?;
            serialize_task_value(
                runtime
                    .upload_project_file(project_id, path, input)
                    .map_err(task_runtime_error)?,
            )
        }
        "files.access" => {
            let file_id = required_task_string(&params, "file_id")?;
            Ok(json!({
                "path": runtime
                    .project_file_path(file_id)
                    .map_err(task_runtime_error)?
            }))
        }
        "files.move" => {
            let file_id = required_task_string(&params, "file_id")?;
            let path = required_task_string(&params, "path")?;
            let version = required_task_i64(&params, "version")?;
            serialize_task_value(
                runtime
                    .move_project_file(file_id, path, version)
                    .map_err(task_runtime_error)?,
            )
        }
        "files.delete" => {
            let file_id = required_task_string(&params, "file_id")?;
            let recursive = params
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            runtime
                .delete_project_file(file_id, recursive)
                .map_err(task_runtime_error)?;
            Ok(json!({"deleted": true}))
        }
        "attachments.list" => {
            let project_id = required_task_string(&params, "project_id")?;
            let item_id = required_task_string(&params, "item_id")?;
            serialize_task_value(
                runtime
                    .list_task_attachments(project_id, item_id)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "attachments.add" => {
            let project_id = required_task_string(&params, "project_id")?;
            let item_id = required_task_string(&params, "item_id")?;
            let input = task_input::<BinaryInput>(&params, "file")?;
            serialize_task_value(
                runtime
                    .add_task_attachment(project_id, item_id, input)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "attachments.access" => {
            let project_id = required_task_string(&params, "project_id")?;
            let item_id = required_task_string(&params, "item_id")?;
            let attachment_id = required_task_string(&params, "attachment_id")?;
            Ok(json!({
                "path": runtime
                    .task_attachment_path(project_id, item_id, attachment_id)
                    .await
                    .map_err(task_runtime_error)?
            }))
        }
        "attachments.delete" => {
            let project_id = required_task_string(&params, "project_id")?;
            let item_id = required_task_string(&params, "item_id")?;
            let attachment_id = required_task_string(&params, "attachment_id")?;
            runtime
                .delete_task_attachment(project_id, item_id, attachment_id)
                .await
                .map_err(task_runtime_error)?;
            Ok(json!({"deleted": true}))
        }
        "deliveries.create" => {
            let project_id = required_task_string(&params, "project_id")?;
            let item_id = required_task_string(&params, "item_id")?;
            let input = task_input::<DeliveryCreate>(&params, "delivery")?;
            serialize_task_value(
                runtime
                    .create_delivery(project_id, item_id, input)
                    .await
                    .map_err(task_runtime_error)?,
            )
        }
        "deliveries.add_asset" => {
            let delivery_id = required_task_string(&params, "delivery_id")?;
            let relative_path = required_task_string(&params, "relative_path")?;
            let input = task_input::<BinaryInput>(&params, "file")?;
            serialize_task_value(
                runtime
                    .add_delivery_asset(delivery_id, relative_path, input)
                    .map_err(task_runtime_error)?,
            )
        }
        "deliveries.finalize" => {
            let item_id = required_task_string(&params, "item_id")?;
            let delivery_id = required_task_string(&params, "delivery_id")?;
            let input = params
                .get("finalize")
                .cloned()
                .map(serde_json::from_value::<DeliveryFinalize>)
                .transpose()
                .map_err(|error| {
                    AppIpcError::new(
                        "invalid_request",
                        format!("invalid finalize input: {error}"),
                    )
                })?
                .unwrap_or_default();
            serialize_task_value(
                runtime
                    .finalize_delivery(item_id, delivery_id, input)
                    .map_err(task_runtime_error)?,
            )
        }
        "deliveries.discard" => {
            let delivery_id = required_task_string(&params, "delivery_id")?;
            runtime
                .discard_delivery(delivery_id)
                .map_err(task_runtime_error)?;
            Ok(json!({"discarded": true}))
        }
        "deliveries.list" => {
            let item_id = required_task_string(&params, "item_id")?;
            serialize_task_value(
                runtime
                    .list_deliveries(item_id)
                    .map_err(task_runtime_error)?,
            )
        }
        "deliveries.get" => {
            let delivery_id = required_task_string(&params, "delivery_id")?;
            serialize_task_value(
                runtime
                    .delivery_detail(delivery_id)
                    .map_err(task_runtime_error)?,
            )
        }
        "deliveries.access_asset" => {
            let asset_id = required_task_string(&params, "asset_id")?;
            Ok(json!({
                "path": runtime
                    .delivery_asset_path(asset_id)
                    .map_err(task_runtime_error)?
            }))
        }
        _ => Err(AppIpcError::new(
            "unsupported_method",
            format!("Unsupported task runtime method: {method}"),
        )),
    }
}

fn task_input<T: serde::de::DeserializeOwned>(
    params: &Value,
    nested_key: &str,
) -> Result<T, AppIpcError> {
    serde_json::from_value(
        params
            .get(nested_key)
            .cloned()
            .unwrap_or_else(|| params.clone()),
    )
    .map_err(|error| AppIpcError::new("bad_request", error.to_string()))
}

fn required_task_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, AppIpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppIpcError::new("bad_request", format!("{key} is required")))
}

fn required_task_i64(params: &Value, key: &str) -> Result<i64, AppIpcError> {
    params
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| AppIpcError::new("bad_request", format!("{key} is required")))
}

fn serialize_task_value(value: impl serde::Serialize) -> Result<Value, AppIpcError> {
    serde_json::to_value(value)
        .map_err(|error| AppIpcError::new("serialization_failed", error.to_string()))
}

fn task_runtime_error(error: crate::task_runtime::TaskRuntimeError) -> AppIpcError {
    let code = match error {
        crate::task_runtime::TaskRuntimeError::ProjectNotFound
        | crate::task_runtime::TaskRuntimeError::TaskNotFound => "not_found",
        crate::task_runtime::TaskRuntimeError::VersionConflict => "version_conflict",
        crate::task_runtime::TaskRuntimeError::UnsupportedProvider(_) => "provider_unavailable",
        crate::task_runtime::TaskRuntimeError::ProviderRequest(_) => "provider_request_failed",
        crate::task_runtime::TaskRuntimeError::Invalid(_) => "bad_request",
        _ => "task_runtime_failed",
    };
    AppIpcError::new(code, error.to_string())
}

#[cfg(windows)]
async fn handle_builtin_device_command(
    command_key: &str,
    params: &Value,
) -> Option<(CommandResult, Option<PostProcessor>)> {
    match command_key {
        "home_dir" => Some((
            CommandResult::ok(
                dirs::home_dir()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| ".".to_string()),
            ),
            None,
        )),
        "pwd" => Some((
            CommandResult::ok(
                std::env::current_dir()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|_| ".".to_string()),
            ),
            None,
        )),
        "project_workspace_root" => match project_workspace_root_path() {
            Ok(path) => Some((CommandResult::ok(path), None)),
            Err(error) => Some((CommandResult::error(error, 0.0, false), None)),
        },
        "mkdir_p" => {
            let args = string_list(params.get("args")).ok()?;
            let path = args.first()?;
            Some((
                match std::fs::create_dir_all(path) {
                    Ok(()) => CommandResult::ok(""),
                    Err(error) => CommandResult::error(
                        format!("Failed to create directory {path}: {error}"),
                        0.0,
                        false,
                    ),
                },
                None,
            ))
        }
        "path_exists" => {
            let args = string_list(params.get("args")).ok()?;
            let path = args.first()?;
            Some((
                CommandResult::ok(if Path::new(path).exists() { "true" } else { "" }),
                None,
            ))
        }
        "ls_dirs" => {
            let path = string_field(params, "path").or_else(|| string_field(params, "cwd"))?;
            Some((
                match std::fs::read_dir(&path) {
                    Ok(entries) => {
                        let mut output = String::new();
                        for entry in entries.flatten() {
                            if let Ok(metadata) = entry.metadata() {
                                let name = entry.file_name().to_string_lossy().to_string();
                                if metadata.is_dir() {
                                    output.push_str(&name);
                                    output.push('/');
                                } else {
                                    output.push_str(&name);
                                }
                                output.push('\n');
                            }
                        }
                        CommandResult::ok(output)
                    }
                    Err(error) => CommandResult::error(
                        format!("Failed to list directory {path}: {error}"),
                        0.0,
                        false,
                    ),
                },
                Some(PostProcessor::DirectoryList),
            ))
        }
        "runtime_auth_status" => {
            let codex_home = env::var("CODEX_HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    dirs::home_dir()
                        .unwrap_or_else(|| PathBuf::from("."))
                        .join(".codex")
                });
            let target = codex_home.join("auth.json");
            let mut result = json!({
                "runtime": "codex",
                "target_path": target.display().to_string(),
                "exists": target.exists() && target.is_file(),
                "updated_at": Value::Null,
                "sha256": Value::Null,
                "size_bytes": Value::Null,
                "error": Value::Null,
            });
            if target.exists() && target.is_file() {
                match std::fs::metadata(&target) {
                    Ok(metadata) => {
                        if let Ok(updated_at) = metadata.modified() {
                            let datetime = chrono::DateTime::<chrono::Utc>::from(updated_at);
                            result["updated_at"] = Value::String(datetime.to_rfc3339());
                        }
                        result["size_bytes"] = Value::Number(metadata.len().into());
                        match std::fs::read(&target) {
                            Ok(content) => {
                                use sha2::{Digest, Sha256};
                                let hash = Sha256::digest(&content);
                                result["sha256"] = Value::String(format!("{hash:x}"));
                            }
                            Err(error) => {
                                result["error"] = Value::String(error.to_string());
                            }
                        }
                    }
                    Err(error) => {
                        result["error"] = Value::String(error.to_string());
                    }
                }
            }
            Some((
                CommandResult::ok(result.to_string()),
                Some(PostProcessor::Json),
            ))
        }
        "git_is_worktree" => {
            let args = string_list(params.get("args")).ok()?;
            let path = args.first()?;
            Some((git_worktree_probe_result(path), None))
        }
        _ => None,
    }
}

#[cfg(not(windows))]
async fn handle_builtin_device_command(
    command_key: &str,
    params: &Value,
) -> Option<(CommandResult, Option<PostProcessor>)> {
    match command_key {
        "git_is_worktree" => {
            let args = string_list(params.get("args")).ok()?;
            let path = args.first()?;
            Some((git_worktree_probe_result(path), None))
        }
        _ => None,
    }
}

fn git_worktree_probe_result(path: &str) -> CommandResult {
    if git_is_worktree(path) {
        CommandResult::ok("true\n")
    } else {
        CommandResult::error("Workspace is not a Git repository".to_owned(), 0.0, false)
    }
}

fn git_is_worktree(path: &str) -> bool {
    let path = Path::new(path);
    if !path.is_dir() {
        return false;
    }
    if looks_like_git_dir(path) {
        return true;
    }

    path.ancestors().any(|directory| {
        let marker = directory.join(".git");
        if marker.is_dir() {
            return looks_like_git_dir(&marker);
        }
        if !marker.is_file() {
            return false;
        }
        resolve_gitdir_file(&marker, directory)
            .as_deref()
            .is_some_and(looks_like_git_dir)
    })
}

fn looks_like_git_dir(path: &Path) -> bool {
    path.join("HEAD").is_file()
        && (path.join("objects").is_dir()
            || path.join("refs").is_dir()
            || path.join("commondir").is_file())
}

fn resolve_gitdir_file(marker: &Path, worktree_root: &Path) -> Option<std::path::PathBuf> {
    let content = std::fs::read_to_string(marker).ok()?;
    let git_dir = Path::new(content.trim().strip_prefix("gitdir:")?.trim());
    Some(if git_dir.is_absolute() {
        git_dir.to_path_buf()
    } else {
        worktree_root.join(git_dir)
    })
}

fn is_git_workspace_inspection_command(command_key: &str) -> bool {
    matches!(
        command_key,
        "git_branch"
            | "git_branch_list"
            | "git_diff_shortstat"
            | "git_diff"
            | "git_branch_diff"
            | "git_branch_diff_shortstat"
            | "git_diff_unstaged"
            | "git_diff_staged"
            | "git_diff_last_commit"
            | "git_status_porcelain"
            | "git_remote_url"
    )
}

#[cfg(windows)]
fn project_workspace_root_path() -> Result<String, String> {
    if let Ok(value) = env::var("WEGENT_EXECUTOR_PROJECTS_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_owned());
        }
    }
    if let Ok(value) = env::var("WECODE_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed)
                .join("wegent-executor")
                .join("workspace")
                .join("projects")
                .display()
                .to_string());
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    Ok(home
        .join(".wecode")
        .join("wegent-executor")
        .join("workspace")
        .join("projects")
        .display()
        .to_string())
}

pub fn app_ipc_stdio_ready_log_line(device_id: &str) -> String {
    format_executor_log(
        "app IPC stdio ready",
        &[
            ("device_id", device_id.to_owned()),
            ("transport", "stdio".to_owned()),
            ("process_id", std::process::id().to_string()),
        ],
    )
}

fn app_ipc_request_metadata(line: &str) -> (Option<String>, Option<String>, Option<String>) {
    match serde_json::from_str::<Value>(line) {
        Ok(Value::Object(message)) => {
            let request_id = message
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned);
            let method = message
                .get("method")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned);
            let command_key = message
                .get("params")
                .and_then(Value::as_object)
                .and_then(|params| params.get("command_key"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned);
            (request_id, method, command_key)
        }
        _ => (None, None, None),
    }
}

fn log_app_ipc_request(
    event: &str,
    request_id: Option<&str>,
    method: Option<&str>,
    command_key: Option<&str>,
    elapsed_ms: Option<u128>,
    ok: Option<bool>,
) {
    let mut fields = Vec::new();
    if let Some(request_id) = request_id {
        fields.push(("request_id", request_id.to_owned()));
    }
    if let Some(method) = method {
        fields.push(("method", method.to_owned()));
    }
    if let Some(command_key) = command_key {
        fields.push(("command_key", command_key.to_owned()));
    }
    if let Some(elapsed_ms) = elapsed_ms {
        fields.push(("elapsed_ms", elapsed_ms.to_string()));
    }
    if let Some(ok) = ok {
        fields.push(("ok", ok.to_string()));
    }
    write_executor_log_line(&format_executor_log(event, &fields));
}

fn log_invalid_app_ipc_frame(frame: &[u8], error: std::str::Utf8Error) {
    let mut fields = vec![
        ("bytes", frame.len().to_string()),
        ("valid_up_to", error.valid_up_to().to_string()),
    ];
    if let Some(error_len) = error.error_len() {
        fields.push(("invalid_sequence_bytes", error_len.to_string()));
    }
    write_executor_log_line(&format_executor_log(
        "invalid app IPC frame discarded",
        &fields,
    ));
}

fn log_app_ipc_response_error(
    request_id: Option<&str>,
    method: Option<&str>,
    elapsed_ms: u128,
    response: &Value,
) {
    let error = response.get("error").and_then(Value::as_object);
    let code = error
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let message = error
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    let mut fields = Vec::new();
    if let Some(request_id) = request_id {
        fields.push(("request_id", request_id.to_owned()));
    }
    if let Some(method) = method {
        fields.push(("method", method.to_owned()));
    }
    fields.push(("elapsed_ms", elapsed_ms.to_string()));
    fields.push(("code", code.to_owned()));
    fields.push(("error", message.to_owned()));
    write_executor_log_line(&format_executor_log("app IPC request failed", &fields));
}

pub async fn serve_app_ipc_sidecar(
    device_id: String,
    runtime_instance_id: String,
) -> Result<(), String> {
    crate::browser_mcp::http::ensure_browser_mcp_http_endpoint().await?;
    crate::task_runtime::mcp_http::ensure_space_mcp_http_endpoint().await?;
    let server = AppIpcServer::new()
        .with_device_id(normalize_device_id(device_id))
        .with_runtime_instance_id(runtime_instance_id)
        .with_local_runtime_work_handler(resolve_codex_binary());
    server.serve_stdio().await
}

pub fn normalize_device_id(device_id: impl Into<String>) -> String {
    let device_id = device_id.into();
    if device_id.trim().is_empty() {
        DEFAULT_DEVICE_ID.to_owned()
    } else {
        device_id
    }
}

fn local_app_command(command_key: &str) -> Option<LocalAppCommandDefinition> {
    match command_key {
        "pwd" => Some(command_definition("pwd", &["pwd"], None)),
        "home_dir" => Some(command_definition("printenv HOME", &["printenv", "HOME"], None)),
        "project_workspace_root" => Some(command_definition(
            "sh -c 'printf %s \"${WEGENT_EXECUTOR_PROJECTS_DIR:-${WECODE_HOME:-$HOME/.wecode}/wegent-executor/workspace/projects}\"'",
            &[
                "sh",
                "-c",
                "printf %s \"${WEGENT_EXECUTOR_PROJECTS_DIR:-${WECODE_HOME:-$HOME/.wecode}/wegent-executor/workspace/projects}\"",
            ],
            None,
        )),
        "ls_dirs" => Some(command_definition(
            "ls -a -p",
            &["ls", "-a", "-p"],
            Some(PostProcessor::DirectoryList),
        )),
        "runtime_auth_status" => Some(command_definition(
            "python3 -c <runtime_auth_status>",
            &["python3", "-c", RUNTIME_AUTH_STATUS_SCRIPT],
            Some(PostProcessor::Json),
        )),
        "mkdir_p" => Some(command_definition("mkdir -p", &["mkdir", "-p"], None)),
        "path_exists" => Some(command_definition("test -e", &["test", "-e"], None)),
        "git_branch" => Some(command_definition(
            "git branch --show-current",
            &["git", "branch", "--show-current"],
            None,
        )),
        "git_branch_list" => Some(command_definition(
            "git branch --format=%(refname:short)",
            &["git", "branch", "--format=%(refname:short)"],
            None,
        )),
        "git_checkout" => Some(command_definition("git checkout", &["git", "checkout"], None)),
        "git_checkout_new" => Some(command_definition(
            "git checkout -b",
            &["git", "checkout", "-b"],
            None,
        )),
        "git_diff_shortstat" => Some(command_definition(
            "git diff --shortstat",
            &["git", "diff", "--shortstat"],
            None,
        )),
        "git_diff_unstaged" => Some(command_definition(
            "git diff --binary --",
            &["git", "diff", "--binary", "--"],
            None,
        )),
        "git_diff_staged" => Some(command_definition(
            "git diff --binary --cached --",
            &["git", "diff", "--binary", "--cached", "--"],
            None,
        )),
        "git_diff_last_commit" => Some(command_definition(
            "git diff --binary HEAD~1..HEAD --",
            &["git", "diff", "--binary", "HEAD~1..HEAD", "--"],
            None,
        )),
        "git_status_porcelain" => Some(command_definition(
            "git status --porcelain",
            &["git", "status", "--porcelain"],
            None,
        )),
        "git_remote_url" => Some(command_definition(
            "git remote get-url origin",
            &["git", "remote", "get-url", "origin"],
            None,
        )),
        "git_github_pull_requests" => Some(command_definition(
            "gh pr list --state all --head <branch>",
            &[
                "gh",
                "pr",
                "list",
                "--state",
                "all",
                "--limit",
                "20",
                "--json",
                "number,url,title,state,isDraft,statusCheckRollup,mergeable,mergeStateStatus",
                "--head",
            ],
            Some(PostProcessor::Json),
        )),
        "git_github_pull_requests_batch" => Some(command_definition(
            "gh api --method GET repos/{owner}/{repo}/pulls?state=all&per_page=100",
            &[
                "gh",
                "api",
                "--method",
                "GET",
                "repos/{owner}/{repo}/pulls?state=all&per_page=100",
                "--jq",
                concat!(
                    "[.[] | {number, html_url, title, state, draft, ",
                    "head: {ref: .head.ref}, updated_at, merged_at}]"
                ),
            ],
            Some(PostProcessor::Json),
        )),
        "git_github_pull_request_merge_queue" => Some(command_definition(
            "gh api graphql <pull-request-merge-queue-query>",
            &[
                "gh",
                "api",
                "graphql",
                "-f",
                "query=query($url:URI!){resource(url:$url){... on PullRequest{mergeQueueEntry{id}}}}",
            ],
            Some(PostProcessor::Json),
        )),
        "git_github_pull_request_merge_queue_batch" => Some(command_definition(
            "gh api graphql",
            &["gh", "api", "graphql"],
            Some(PostProcessor::Json),
        )),
        "git_gitlab_merge_requests" => Some(command_definition(
            "glab mr list --all --source-branch <branch>",
            &[
                "glab",
                "mr",
                "list",
                "--all",
                "--per-page",
                "20",
                "--order",
                "updated_at",
                "--sort",
                "desc",
                "--output",
                "json",
                "--source-branch",
            ],
            Some(PostProcessor::Json),
        )),
        "git_gitlab_merge_requests_batch" => Some(command_definition(
            "glab mr list --all",
            &[
                "glab",
                "mr",
                "list",
                "--all",
                "--per-page",
                "100",
                "--order",
                "updated_at",
                "--sort",
                "desc",
                "--output",
                "json",
            ],
            Some(PostProcessor::Json),
        )),
        "git_is_worktree" => Some(command_definition(
            "sh -c <git_is_worktree>",
            &[
                "sh",
                "-c",
                concat!(
                    "if [ \"$(git -C \"$1\" rev-parse --is-inside-work-tree 2>/dev/null)\" ",
                    "= \"true\" ] || git -C \"$1\" rev-parse --git-dir >/dev/null 2>&1; then ",
                    "printf 'true\\n'; else printf 'false\\n'; exit 1; fi"
                ),
                "--",
            ],
            None,
        )),
        "git_add_all" => Some(command_definition("git add --all", &["git", "add", "--all"], None)),
        "git_commit" => Some(command_definition("git commit", &["git", "commit"], None)),
        "browser_relay_restart" => Some(command_definition(
            "sh -lc <browser_relay_restart>",
            &[
                "sh",
                "-lc",
                "exec \"$HOME/.wegent-executor/bin/cdp-relay-server\" --restart",
            ],
            None,
        )),
        "browser_tool" => Some(command_definition(
            "sh -lc <browser_tool>",
            &[
                "sh",
                "-lc",
                "payload=${1:?browser tool payload is required}; exec \"$HOME/.wegent-executor/bin/browser-tool\" \"$payload\"",
                "--",
            ],
            Some(PostProcessor::Json),
        )),
        _ => None,
    }
}

fn command_definition(
    command: &'static str,
    argv: &'static [&'static str],
    post_processor: Option<PostProcessor>,
) -> LocalAppCommandDefinition {
    LocalAppCommandDefinition {
        command,
        argv,
        post_processor,
    }
}

fn request_from_message(
    message: &serde_json::Map<String, Value>,
) -> Result<(String, Value), AppIpcError> {
    if message.get("type").and_then(Value::as_str) != Some("request") {
        return Err(AppIpcError::new(
            "invalid_request",
            "Request type must be 'request'",
        ));
    }

    let method = message
        .get("method")
        .and_then(Value::as_str)
        .filter(|method| !method.trim().is_empty())
        .ok_or_else(|| AppIpcError::new("invalid_request", "Request method is required"))?
        .trim()
        .to_owned();

    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Err(AppIpcError::new(
            "invalid_request",
            "Request params must be an object",
        ));
    }

    Ok((method, params))
}

fn request_id_from(message: &serde_json::Map<String, Value>) -> Result<String, AppIpcError> {
    message
        .get("id")
        .and_then(Value::as_str)
        .filter(|request_id| !request_id.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppIpcError::new("invalid_request", "Request id is required"))
}

fn response_message(request_id: &str, result: Value) -> Value {
    json!({
        "type": "response",
        "id": request_id,
        "ok": true,
        "result": encode_app_ipc_response("app_ipc_request", result),
    })
}

fn error_message(request_id: Option<&str>, error: &AppIpcError) -> Value {
    json!({
        "type": "response",
        "id": request_id,
        "ok": false,
        "error": {
            "code": error.code,
            "message": error.message,
        },
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_list(value: Option<&Value>) -> Result<Vec<String>, AppIpcError> {
    string_list_field(value, "args")
}

fn string_list_field(value: Option<&Value>, field: &str) -> Result<Vec<String>, AppIpcError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err(AppIpcError::new(
            "bad_request",
            format!("{field} must be a list"),
        ));
    };

    items
        .iter()
        .map(|item| {
            item.as_str().map(str::to_owned).ok_or_else(|| {
                AppIpcError::new("bad_request", format!("{field} must contain only strings"))
            })
        })
        .collect()
}

fn string_env(value: Option<&Value>) -> Result<HashMap<String, String>, AppIpcError> {
    let Some(value) = value else {
        return Ok(HashMap::new());
    };
    let Some(items) = value.as_object() else {
        return Err(AppIpcError::new("bad_request", "env must be an object"));
    };

    Ok(items
        .iter()
        .filter(|(key, _)| !key.is_empty())
        .map(|(key, value)| {
            (
                key.clone(),
                match value {
                    Value::Null => String::new(),
                    Value::String(value) => value.clone(),
                    other => other.to_string(),
                },
            )
        })
        .collect())
}

fn positive_number(value: Option<&Value>, default: f64) -> f64 {
    let parsed = value
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(default);
    if parsed > 0.0 {
        parsed
    } else {
        default
    }
}

fn apply_post_processor(
    mut result: CommandResult,
    post_processor: Option<PostProcessor>,
) -> CommandResult {
    match post_processor {
        None => result,
        Some(PostProcessor::DirectoryList) => {
            if result.success {
                result.stdout = Value::Array(
                    stdout_string(&result)
                        .lines()
                        .map(str::trim)
                        .filter(|entry| entry.ends_with('/'))
                        .map(|entry| entry.trim_end_matches('/'))
                        .filter(|entry| !entry.is_empty() && *entry != "." && *entry != "..")
                        .map(|entry| Value::String(entry.to_owned()))
                        .collect(),
                );
            }
            result
        }
        Some(PostProcessor::Json) => {
            if result.stdout_truncated {
                result.success = false;
                result.error = Some(
                    "Command output exceeded max_output_bytes and was truncated; JSON is incomplete and cannot be parsed"
                        .to_owned(),
                );
                return result;
            }

            match serde_json::from_str::<Value>(&stdout_string(&result)) {
                Ok(stdout) => {
                    if !result.success && result.error.is_none() {
                        result.error = stdout
                            .get("error")
                            .and_then(Value::as_str)
                            .filter(|error| !error.trim().is_empty())
                            .map(str::to_owned);
                    }
                    result.stdout = stdout;
                    result
                }
                Err(error) if result.success => {
                    result.success = false;
                    result.error = Some(format!("Failed to parse command JSON output: {error}"));
                    result
                }
                Err(_) => result,
            }
        }
    }
}

fn stdout_string(result: &CommandResult) -> String {
    result
        .stdout
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| result.stdout.to_string())
}

async fn write_message<W>(writer: &mut W, message: &Value) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc as std_mpsc, Arc,
    };

    use serde_json::{json, Value};
    use tokio::io::{duplex, split, AsyncBufReadExt, AsyncWriteExt, BufReader};
    #[cfg(unix)]
    use tokio::net::UnixStream;
    use tokio::time::Duration;

    use super::{
        app_ipc_request_metadata, is_bulk_app_ipc_event, local_app_command, AppIpcServer,
        BlockingSingleFlight,
    };

    #[test]
    fn app_ipc_request_metadata_includes_device_command_key() {
        let line = json!({
            "id": "request-1",
            "method": "device.execute_command",
            "params": {
                "command_key": "workspace_read_file_chunk",
                "path": "/workspace"
            }
        })
        .to_string();

        assert_eq!(
            app_ipc_request_metadata(&line),
            (
                Some("request-1".to_owned()),
                Some("device.execute_command".to_owned()),
                Some("workspace_read_file_chunk".to_owned())
            )
        );
    }

    #[tokio::test]
    async fn blocking_single_flight_survives_a_timed_out_waiter() {
        let single_flight = Arc::new(BlockingSingleFlight::<String>::default());
        let starts = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let first_single_flight = single_flight.clone();
        let first_starts = starts.clone();
        let first_waiter = tokio::spawn(async move {
            tokio::time::timeout(
                Duration::from_millis(250),
                first_single_flight.run(move || {
                    first_starts.fetch_add(1, Ordering::SeqCst);
                    let _ = started_tx.send(());
                    release_rx
                        .recv()
                        .map_err(|error| format!("release signal failed: {error}"))?;
                    Ok("initialized".to_owned())
                }),
            )
            .await
        });

        started_rx
            .await
            .expect("blocking initialization should start");
        assert!(
            first_waiter
                .await
                .expect("timed-out waiter should join")
                .is_err(),
            "the first waiter should time out"
        );

        let retry_single_flight = single_flight.clone();
        let retry_starts = starts.clone();
        let retry = tokio::spawn(async move {
            retry_single_flight
                .run(move || {
                    retry_starts.fetch_add(1, Ordering::SeqCst);
                    Ok("duplicate".to_owned())
                })
                .await
        });
        tokio::task::yield_now().await;
        assert_eq!(starts.load(Ordering::SeqCst), 1);

        release_tx
            .send(())
            .expect("blocking initialization should still be running");
        assert_eq!(
            retry
                .await
                .expect("retry waiter should join")
                .expect("retry should receive the original result"),
            "initialized"
        );
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn prioritizes_chat_events_over_diagnostic_blocks() {
        assert!(is_bulk_app_ipc_event(&json!({
            "type": "event",
            "event": "response.block.updated",
            "payload": {
                "data": {
                    "updates": {
                        "tool_output_delta": "diagnostic output"
                    }
                }
            }
        })));
        assert!(is_bulk_app_ipc_event(&json!({
            "type": "event",
            "event": "response.block.updated",
            "payload": {
                "data": {
                    "updates": {
                        "content_delta": "partial response",
                        "status": "streaming"
                    }
                }
            }
        })));
        assert!(is_bulk_app_ipc_event(&json!({
            "type": "event",
            "event": "response.block.created",
            "payload": {
                "data": {
                    "block": {
                        "type": "file_changes"
                    }
                }
            }
        })));
        assert!(is_bulk_app_ipc_event(&json!({
            "type": "event",
            "event": "runtime.plan.updated",
        })));
        assert!(!is_bulk_app_ipc_event(&json!({
            "type": "event",
            "event": "response.block.created",
            "payload": {
                "data": {
                    "block": {
                        "type": "text"
                    }
                }
            }
        })));
        assert!(!is_bulk_app_ipc_event(&json!({
            "type": "event",
            "event": "response.block.updated",
            "payload": {
                "data": {
                    "updates": {
                        "status": "done"
                    }
                }
            }
        })));
        assert!(is_bulk_app_ipc_event(&json!({
            "type": "event",
            "event": "response.block.updated",
            "payload": {
                "data": {
                    "updates": {
                        "content": "partial response",
                        "status": "streaming"
                    }
                }
            }
        })));
        assert!(!is_bulk_app_ipc_event(&json!({
            "type": "event",
            "event": "response.block.updated",
            "payload": {
                "data": {
                    "updates": {
                        "content": "final response",
                        "status": "done"
                    }
                }
            }
        })));
        assert!(!is_bulk_app_ipc_event(&json!({
            "type": "event",
            "event": "response.output_text.delta",
        })));
        assert!(!is_bulk_app_ipc_event(&json!({
            "type": "event",
            "event": "response.completed",
        })));
    }

    #[tokio::test]
    async fn preserves_bulk_event_order_before_terminal_events() {
        let server = AppIpcServer::new();
        let event_tx = server.event_tx.clone();
        let (client, executor) = duplex(128);
        let (client_reader, mut client_writer) = split(client);
        let (executor_reader, executor_writer) = split(executor);
        let serving = tokio::spawn(async move {
            server
                .serve_io(executor_reader, executor_writer)
                .await
                .expect("app IPC should preserve runtime event ordering");
        });
        let mut client_reader = BufReader::new(client_reader);
        let mut ready = String::new();
        client_reader
            .read_line(&mut ready)
            .await
            .expect("executor.ready should be readable");

        for index in 1..=3 {
            event_tx
                .send(json!({
                    "type": "event",
                    "event": "response.block.updated",
                    "payload": {
                        "data": {
                            "block_id": format!("block-{index}"),
                            "updates": {
                                "content_delta": "x".repeat(1_024),
                                "status": "streaming",
                            }
                        }
                    }
                }))
                .expect("bulk event should have an app IPC receiver");
        }
        event_tx
            .send(json!({
                "type": "event",
                "event": "response.completed",
                "payload": {"data": {"value": "done"}}
            }))
            .expect("terminal event should have an app IPC receiver");

        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut messages = Vec::new();
        for _ in 0..4 {
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(1), client_reader.read_line(&mut line))
                .await
                .expect("runtime event should arrive before the timeout")
                .expect("runtime event should be readable");
            messages.push(serde_json::from_str::<Value>(&line).expect("valid app IPC JSON"));
        }
        assert_eq!(messages[0]["payload"]["data"]["block_id"], "block-1");
        assert_eq!(messages[1]["payload"]["data"]["block_id"], "block-2");
        assert_eq!(messages[2]["payload"]["data"]["block_id"], "block-3");
        assert_eq!(messages[3]["event"], "response.completed");

        client_writer
            .shutdown()
            .await
            .expect("client input should close");
        serving.await.expect("app IPC task should finish");
    }

    #[tokio::test]
    async fn queues_backpressure_recovery_after_buffered_runtime_events() {
        let server = AppIpcServer::new();
        let event_tx = server.event_tx.clone();
        let (client, executor) = duplex(128);
        let (client_reader, mut client_writer) = split(client);
        let (executor_reader, executor_writer) = split(executor);
        let serving = tokio::spawn(async move {
            server
                .serve_io_with_bulk_write_buffer_capacity(executor_reader, executor_writer, 2)
                .await
                .expect("app IPC should recover from bulk event backpressure");
        });
        let mut client_reader = BufReader::new(client_reader);
        let mut ready = String::new();
        client_reader
            .read_line(&mut ready)
            .await
            .expect("executor.ready should be readable");

        event_tx
            .send(json!({
                "type": "event",
                "event": "runtime.plan.updated",
                "payload": {
                    "sequence": 1,
                    "delta": "x".repeat(1_024),
                }
            }))
            .expect("bulk event should have an app IPC receiver");
        tokio::time::sleep(Duration::from_millis(50)).await;

        for sequence in 2..=4 {
            event_tx
                .send(json!({
                    "type": "event",
                    "event": "runtime.plan.updated",
                    "payload": {
                        "sequence": sequence,
                        "delta": "x".repeat(1_024),
                    }
                }))
                .expect("bulk event should have an app IPC receiver");
        }

        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut messages = Vec::new();
        for _ in 0..4 {
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(1), client_reader.read_line(&mut line))
                .await
                .expect("runtime event should arrive before the timeout")
                .expect("runtime event should be readable");
            messages.push(serde_json::from_str::<Value>(&line).expect("valid app IPC JSON"));
        }
        assert_eq!(messages[0]["payload"]["sequence"], 1);
        assert_eq!(messages[1]["payload"]["sequence"], 2);
        assert_eq!(messages[2]["payload"]["sequence"], 3);
        assert_eq!(messages[3]["event"], "executor.event_lagged");
        assert_eq!(messages[3]["payload"]["reason"], "ipc_backpressure");

        client_writer
            .shutdown()
            .await
            .expect("client input should close");
        serving.await.expect("app IPC task should finish");
    }

    #[test]
    fn git_native_commands_are_not_registered_as_shell_commands() {
        for command_key in [
            "git_diff",
            "git_branch_diff",
            "git_branch_diff_shortstat",
            "git_github_cli_status",
            "git_gitlab_cli_status",
            "git_push",
            "git_worktree_add",
            "git_worktree_remove",
            "turn_file_changes_review",
            "turn_file_changes_revert",
        ] {
            assert!(
                local_app_command(command_key).is_none(),
                "{command_key} must run through the native handler, not the shell registry"
            );
        }
    }

    #[tokio::test]
    async fn invalid_utf8_frame_does_not_stop_app_ipc() {
        let server = AppIpcServer::new();
        let (client, executor) = duplex(4096);
        let (client_reader, mut client_writer) = split(client);
        let (executor_reader, executor_writer) = split(executor);
        let serving = tokio::spawn(async move {
            server
                .serve_io(executor_reader, executor_writer)
                .await
                .expect("app IPC should stay available after a malformed frame");
        });

        client_writer
            .write_all(b"\xff\n")
            .await
            .expect("invalid frame should be written");
        client_writer
            .write_all(
                br#"{"type":"request","id":"health-after-invalid","method":"executor.health","params":{}}
"#,
            )
            .await
            .expect("health request should be written");
        let mut client_reader = BufReader::new(client_reader);
        let mut output = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            client_reader
                .read_line(&mut line)
                .await
                .expect("app IPC output should remain valid UTF-8");
            output.push(line);
        }
        client_writer
            .shutdown()
            .await
            .expect("client input should close");
        serving.await.expect("app IPC task should finish");

        let messages = output
            .iter()
            .map(|line| serde_json::from_str::<Value>(line).expect("valid app IPC JSON"))
            .collect::<Vec<_>>();
        assert!(messages.iter().any(|message| {
            message.get("event") == Some(&Value::String("executor.ready".to_owned()))
        }));
        assert!(messages.iter().any(|message| {
            message.get("id") == Some(&Value::String("health-after-invalid".to_owned()))
                && message.get("ok") == Some(&Value::Bool(true))
        }));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_endpoint_authenticates_before_serving_requests() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let endpoint = directory.path().join("executor.sock");
        let token = "0123456789abcdef0123456789abcdef";
        let owner_token = "abcdef0123456789abcdef0123456789";
        let server = AppIpcServer::new();
        let endpoint_for_server = endpoint.clone();
        let serving = tokio::spawn(async move {
            server
                .serve_local_endpoint(endpoint_for_server.to_str().unwrap(), token, owner_token)
                .await
        });
        for _ in 0..100 {
            if endpoint.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(endpoint.exists(), "executor socket should be created");
        assert_eq!(
            std::fs::metadata(&endpoint)
                .expect("socket metadata should be readable")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        let invalid = UnixStream::connect(&endpoint)
            .await
            .expect("invalid client should connect");
        let (invalid_reader, mut invalid_writer) = split(invalid);
        invalid_writer
            .write_all(
                br#"{"type":"authenticate","protocol_version":1,"token":"invalid-invalid-invalid-invalid"}
"#,
            )
            .await
            .expect("invalid authentication should be written");
        let mut invalid_reader = BufReader::new(invalid_reader);
        let mut invalid_line = String::new();
        invalid_reader
            .read_line(&mut invalid_line)
            .await
            .expect("authentication rejection should be read");
        let invalid_message: Value =
            serde_json::from_str(&invalid_line).expect("authentication rejection should be JSON");
        assert_eq!(invalid_message["ok"], false);
        assert_eq!(
            invalid_message["error"]["code"],
            Value::String("authentication_failed".to_owned())
        );

        let valid = UnixStream::connect(&endpoint)
            .await
            .expect("valid client should connect");
        let (valid_reader, mut valid_writer) = split(valid);
        valid_writer
            .write_all(
                format!(
                    "{{\"type\":\"authenticate\",\"protocol_version\":1,\"token\":\"{token}\"}}\n"
                )
                .as_bytes(),
            )
            .await
            .expect("authentication should be written");
        let mut valid_reader = BufReader::new(valid_reader);
        let mut authentication = String::new();
        valid_reader
            .read_line(&mut authentication)
            .await
            .expect("authentication response should be read");
        let authentication: Value =
            serde_json::from_str(&authentication).expect("authentication response should be JSON");
        assert_eq!(authentication["ok"], true);
        valid_writer
            .write_all(
                br#"{"type":"request","id":"health","method":"executor.health","params":{}}
"#,
            )
            .await
            .expect("health request should be written");
        let mut messages = Vec::new();
        for _ in 0..2 {
            let mut line = String::new();
            valid_reader
                .read_line(&mut line)
                .await
                .expect("executor message should be read");
            messages.push(
                serde_json::from_str::<Value>(&line).expect("executor message should be JSON"),
            );
        }
        assert!(messages
            .iter()
            .any(|message| { message["event"] == Value::String("executor.ready".to_owned()) }));
        assert!(messages.iter().any(|message| {
            message["id"] == Value::String("health".to_owned()) && message["ok"] == true
        }));

        let owner = UnixStream::connect(&endpoint)
            .await
            .expect("owner should connect");
        let (owner_reader, mut owner_writer) = split(owner);
        owner_writer
            .write_all(
                format!(
                    "{{\"type\":\"authenticate\",\"protocol_version\":1,\"token\":\"{owner_token}\"}}\n"
                )
                .as_bytes(),
            )
            .await
            .expect("owner authentication should be written");
        let mut owner_reader = BufReader::new(owner_reader);
        let mut owner_authentication = String::new();
        owner_reader
            .read_line(&mut owner_authentication)
            .await
            .expect("owner authentication response should be read");
        let owner_authentication: Value = serde_json::from_str(&owner_authentication)
            .expect("owner authentication response should be JSON");
        assert_eq!(owner_authentication["ok"], true);
        owner_writer
            .shutdown()
            .await
            .expect("owner connection should close");

        assert!(tokio::time::timeout(Duration::from_secs(1), serving)
            .await
            .expect("owner disconnect should stop the local endpoint")
            .expect("local endpoint task should join")
            .is_ok());
    }

    #[tokio::test]
    async fn executor_event_stream_replays_events_after_the_requested_sequence() {
        let server = AppIpcServer::new();
        let event_tx = server.event_tx.clone();
        let (first_client, first_executor) = duplex(16 * 1024);
        let (first_reader, _) = split(first_client);
        let (_, first_writer) = split(first_executor);
        let first_server = server.clone();
        let first_stream =
            tokio::spawn(
                async move { first_server.serve_event_stream(first_writer, 0, true).await },
            );
        for _ in 0..100 {
            if event_tx.receiver_count() > 0 {
                break;
            }
            tokio::task::yield_now().await;
        }

        event_tx
            .send(json!({
                "type": "event",
                "event": "response.output_text.delta",
                "payload": {"data": {"delta": "first"}},
            }))
            .expect("event stream should subscribe to executor events");
        let mut first_reader = BufReader::new(first_reader);
        let mut first_line = String::new();
        tokio::time::timeout(
            Duration::from_secs(1),
            first_reader.read_line(&mut first_line),
        )
        .await
        .expect("first executor event should arrive")
        .expect("first executor event should be readable");
        let first_event: Value =
            serde_json::from_str(&first_line).expect("first executor event should be JSON");
        let first_sequence = first_event["sequence"]
            .as_u64()
            .expect("first executor event should be sequenced");
        first_stream.abort();

        event_tx
            .send(json!({
                "type": "event",
                "event": "response.output_text.delta",
                "payload": {"data": {"delta": "second"}},
            }))
            .expect("executor event journal should remain subscribed");
        tokio::time::sleep(Duration::from_millis(10)).await;

        let (second_client, second_executor) = duplex(16 * 1024);
        let (second_reader, _) = split(second_client);
        let (_, second_writer) = split(second_executor);
        let second_server = server.clone();
        let second_stream = tokio::spawn(async move {
            second_server
                .serve_event_stream(second_writer, first_sequence, true)
                .await
        });
        let mut second_reader = BufReader::new(second_reader);
        let mut second_line = String::new();
        tokio::time::timeout(
            Duration::from_secs(1),
            second_reader.read_line(&mut second_line),
        )
        .await
        .expect("replayed executor event should arrive")
        .expect("replayed executor event should be readable");
        let second_event: Value =
            serde_json::from_str(&second_line).expect("replayed executor event should be JSON");

        assert_eq!(second_event["payload"]["data"]["delta"], "second");
        assert!(second_event["sequence"].as_u64().unwrap() > first_sequence);
        second_stream.abort();
    }

    #[tokio::test]
    async fn fresh_executor_event_stream_skips_journal_backlog() {
        let server = AppIpcServer::new();
        let event_tx = server.event_tx.clone();
        server.event_hub.ensure_started();
        event_tx
            .send(json!({
                "type": "event",
                "event": "response.output_text.delta",
                "payload": {"data": {"delta": "stale"}},
            }))
            .expect("executor event journal should accept backlog");
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if server
                    .event_hub
                    .subscribe_after(0)
                    .replay
                    .iter()
                    .any(|event| event["payload"]["data"]["delta"] == "stale")
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stale executor event should reach the journal");

        let (client, executor) = duplex(16 * 1024);
        let (reader, _) = split(client);
        let (_, writer) = split(executor);
        let fresh_server = server.clone();
        let fresh_stream =
            tokio::spawn(async move { fresh_server.serve_event_stream(writer, 0, false).await });
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut line))
            .await
            .expect("fresh event stream cursor should arrive")
            .expect("fresh event stream cursor should be readable");
        let cursor: Value =
            serde_json::from_str(&line).expect("fresh event stream cursor should be JSON");
        assert_eq!(cursor["event"], "executor.stream.cursor");
        assert!(cursor["sequence"].as_u64().unwrap() > 0);
        line.clear();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), reader.read_line(&mut line))
                .await
                .is_err(),
            "fresh event streams must not replay journal backlog"
        );

        event_tx
            .send(json!({
                "type": "event",
                "event": "response.output_text.delta",
                "payload": {"data": {"delta": "live"}},
            }))
            .expect("fresh event stream should receive live events");
        tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut line))
            .await
            .expect("live executor event should arrive")
            .expect("live executor event should be readable");
        let event: Value = serde_json::from_str(&line).expect("live executor event should be JSON");
        assert_eq!(event["payload"]["data"]["delta"], "live");
        fresh_stream.abort();
    }
}
