//! Device-side local connector authentication.
//!
//! Executes plugin-declared relative CLI commands and manages immutable CLI
//! artifacts without sending credentials to the cloud or LLM.

use std::{
    collections::{hash_map::Entry, HashMap},
    env, fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use tokio::{
    process::Command,
    sync::{watch, Mutex},
    task::JoinHandle,
};
use uuid::Uuid;

use crate::local::app_ipc::AppIpcError;

use super::util::string_field;
use tools::{parse_tool_spec, resolve_auth_tool, LocalAuthToolSpec};

mod commands;
use commands::run_plugin_command;
mod resolution;
use resolution::resolve_request;
mod connection_tools;
mod diagnostics;
pub(crate) use connection_tools::{
    connection_auth_target, run_connection_tool, run_declared_plugin_tool,
};
mod github_cli;
pub(crate) mod gitlab_cli;
mod logout;
mod python;
mod tools;

#[derive(Debug, Clone)]
struct LocalAuthSpec {
    connector_slug: String,
    account_auth: bool,
    kind: String,
    health: Vec<String>,
    start: Vec<String>,
    poll: Vec<String>,
    logout: Vec<String>,
    qr_field: String,
    status_field: String,
    ok_values: Vec<String>,
    timeout_seconds: u64,
    tool: Option<LocalAuthToolSpec>,
}

struct BrowserAuthSession {
    plugin_key: String,
    connector_slug: String,
    marketplace_id: Option<String>,
    plugin_root: Option<PathBuf>,
    state: Arc<Mutex<Value>>,
    task: JoinHandle<()>,
}

static BROWSER_AUTH_SESSIONS: OnceLock<Mutex<HashMap<String, BrowserAuthSession>>> =
    OnceLock::new();
static MARKETPLACE_AUTH: OnceLock<std::sync::Mutex<MarketplaceAuth>> = OnceLock::new();

const DEFAULT_COMMAND_TIMEOUT_SECONDS: u64 = 45;

#[derive(Default)]
struct MarketplaceAuth {
    removals: HashMap<PathBuf, MarketplaceRemovalPhase>,
    qr_operations: HashMap<Uuid, (PathBuf, watch::Receiver<()>)>,
}

fn marketplace_auth() -> &'static std::sync::Mutex<MarketplaceAuth> {
    MARKETPLACE_AUTH.get_or_init(Default::default)
}

enum MarketplaceRemovalPhase {
    Draining,
    CleaningUp(PathBuf),
}

impl MarketplaceAuth {
    fn check_removal(&self, plugin_root: &Path) -> Result<(), AppIpcError> {
        if self
            .removals
            .keys()
            .any(|cache| plugin_root.starts_with(cache))
        {
            return Err(AppIpcError::new(
                "marketplace_removal_in_progress",
                "The plugin marketplace is being removed",
            ));
        }
        Ok(())
    }
}

pub(super) struct MarketplaceRemoval(PathBuf);

impl MarketplaceRemoval {
    pub(super) fn begin(cache: PathBuf) -> Result<Self, AppIpcError> {
        let mut auth = marketplace_auth().lock().unwrap();
        let Entry::Vacant(entry) = auth.removals.entry(cache.clone()) else {
            return Err(AppIpcError::new(
                "marketplace_management_failed",
                "This marketplace is already being removed",
            ));
        };
        entry.insert(MarketplaceRemovalPhase::Draining);
        Ok(Self(cache))
    }

    pub(super) fn begin_cleanup(&self, codex_home: &Path) {
        *marketplace_auth()
            .lock()
            .unwrap()
            .removals
            .get_mut(&self.0)
            .expect("marketplace removal guard is active") =
            MarketplaceRemovalPhase::CleaningUp(codex_home.to_path_buf());
    }

    pub(super) fn cleaning_marketplaces(codex_home: &Path) -> Vec<String> {
        marketplace_auth()
            .lock()
            .unwrap()
            .removals
            .iter()
            .filter(|(_, phase)| {
                matches!(phase, MarketplaceRemovalPhase::CleaningUp(home) if home == codex_home)
            })
            .filter_map(|(cache, _)| cache.file_name()?.to_str().map(str::to_owned))
            .collect()
    }

    pub(super) async fn wait_for_qr_auth(
        &self,
        deadline: tokio::time::Instant,
    ) -> Result<(), AppIpcError> {
        let pending: Vec<_> = marketplace_auth()
            .lock()
            .unwrap()
            .qr_operations
            .values()
            .filter(|(root, _)| root.starts_with(&self.0))
            .map(|(_, done)| done.clone())
            .collect();
        tokio::time::timeout_at(
            deadline,
            futures_util::future::join_all(pending.into_iter().map(|mut done| async move {
                let _ = done.changed().await;
            })),
        )
        .await
        .map_err(|_| {
            AppIpcError::new(
                "marketplace_auth_busy",
                "Wait for plugin authorization to finish and retry marketplace removal",
            )
        })?;
        Ok(())
    }
}

impl Drop for MarketplaceRemoval {
    fn drop(&mut self) {
        marketplace_auth().lock().unwrap().removals.remove(&self.0);
    }
}

struct QrAuthOperation {
    id: Uuid,
    _done: watch::Sender<()>,
}

impl QrAuthOperation {
    fn begin(plugin_root: &Path) -> Result<Self, AppIpcError> {
        let mut auth = marketplace_auth().lock().unwrap();
        let root = canonical_plugin_root(plugin_root)?;
        auth.check_removal(&root)?;
        let id = Uuid::new_v4();
        let (done, receiver) = watch::channel(());
        auth.qr_operations.insert(id, (root, receiver));
        Ok(Self { id, _done: done })
    }
}

impl Drop for QrAuthOperation {
    fn drop(&mut self) {
        marketplace_auth()
            .lock()
            .unwrap()
            .qr_operations
            .remove(&self.id);
    }
}

pub async fn health(payload: Value) -> Result<Value, AppIpcError> {
    if gitlab_cli::is_target(&payload) {
        return gitlab_cli::health(&payload).await;
    }
    if github_cli::is_target(&payload) {
        return github_cli::health().await;
    }
    let (plugin_root, spec) = resolve_request(&payload).await?;
    // A source that still owns its credential remains usable without the cloud.
    let local = async {
        let tool = resolve_auth_tool(spec.tool.as_ref(), false).await?;
        if payload["prepareRuntime"] != true
            && crate::python_runtime::managed_python_bridge_configured()
            && python::command_uses_python(&plugin_root, &spec.health, tool.as_deref())?
            && !crate::python_runtime::managed_python_ready()
                .await
                .map_err(|message| AppIpcError::new("python_runtime_unavailable", message))?
        {
            return Err(AppIpcError::new(
                "python_runtime_unavailable",
                "Python will be prepared when this plugin is used",
            ));
        }
        let result = run_plugin_command(
            &plugin_root,
            &spec.health,
            tool.as_deref(),
            DEFAULT_COMMAND_TIMEOUT_SECONDS,
        )
        .await?;
        Ok::<_, AppIpcError>(normalize_status_response(&result, &spec, None))
    }
    .await;
    if local.as_ref().is_ok_and(|result| result["status"] == "ok") {
        return local;
    }
    if let Some(status) = account_lifecycle(&plugin_root, &spec, "status").await? {
        return Ok(status);
    }
    local
}

pub async fn start(payload: Value) -> Result<Value, AppIpcError> {
    if gitlab_cli::is_target(&payload) {
        return gitlab_cli::start(&payload).await;
    }
    if github_cli::is_target(&payload) {
        return github_cli::start().await;
    }
    let (plugin_root, spec) = resolve_request(&payload).await?;
    if spec.kind == "browser_oauth" {
        return start_browser_auth(payload, plugin_root, spec).await;
    }
    let _operation = QrAuthOperation::begin(&plugin_root)?;
    let tool = resolve_auth_tool(spec.tool.as_ref(), true).await?;
    let result = run_plugin_command(
        &plugin_root,
        &spec.start,
        tool.as_deref(),
        spec.timeout_seconds,
    )
    .await?;
    let qr_image = read_qr_image(&result, &spec.qr_field)?;
    let response = normalize_status_response(&result, &spec, qr_image);
    if response["status"] == "ok" {
        account_lifecycle(&plugin_root, &spec, "login").await?;
    }
    Ok(response)
}

pub async fn poll(payload: Value) -> Result<Value, AppIpcError> {
    if gitlab_cli::is_target(&payload) {
        return poll_browser_auth(&payload).await;
    }
    if github_cli::is_target(&payload) {
        return poll_browser_auth(&payload).await;
    }
    let (plugin_root, spec) = resolve_request(&payload).await?;
    if spec.kind == "browser_oauth" {
        return poll_browser_auth(&payload).await;
    }
    let _operation = QrAuthOperation::begin(&plugin_root)?;
    // Force non-blocking poll regardless of manifest args.
    let mut command = spec.poll.clone();
    ensure_wait_seconds_zero(&mut command);
    let tool = resolve_auth_tool(spec.tool.as_ref(), false).await?;
    let result = run_plugin_command(
        &plugin_root,
        &command,
        tool.as_deref(),
        DEFAULT_COMMAND_TIMEOUT_SECONDS,
    )
    .await?;
    let qr_image = read_qr_image(&result, &spec.qr_field).ok().flatten();
    let response = normalize_status_response(&result, &spec, qr_image);
    if response["status"] == "ok" {
        account_lifecycle(&plugin_root, &spec, "login").await?;
    }
    Ok(response)
}

pub async fn logout(payload: Value) -> Result<Value, AppIpcError> {
    if github_cli::is_target(&payload) {
        cancel_browser_auth_sessions(|session| {
            session.plugin_root.is_none()
                && session.plugin_key == "github"
                && session.connector_slug == "wework-github-cli"
        })
        .await;
        return github_cli::logout().await;
    }
    let (plugin_root, spec) = resolve_request(&payload).await?;
    let plugin_key = string_field(&payload, "pluginKey")
        .or_else(|| string_field(&payload, "plugin_key"))
        .unwrap_or_default();
    let root = canonical_plugin_root(&plugin_root)?;
    let marketplace_id = string_field(&payload, "marketplaceId");
    cancel_browser_auth_sessions(|session| {
        session.plugin_key == plugin_key
            && session.connector_slug == spec.connector_slug
            && (session.plugin_root.as_deref() == Some(&root)
                || (marketplace_id.is_some()
                    && session.plugin_root.is_some()
                    && session.marketplace_id == marketplace_id))
    })
    .await;
    logout_with_spec(&plugin_root, &spec).await
}

pub(super) async fn logout_before_plugin_uninstall(root: &Path, manifest: &Value) {
    let specs = manifest["connectors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|connector| {
            let auth = connector["localAuth"].as_object()?;
            let kind = auth
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("local_qr");
            let opted_in = auth
                .get("logoutOnUninstall")
                .and_then(Value::as_bool)
                .unwrap_or(kind == "local_qr");
            connector["slug"].as_str().filter(|slug| !slug.is_empty())?;
            opted_in
                .then(|| parse_local_auth_connector(connector).ok())
                .flatten()
        });
    futures_util::future::join_all(specs.map(|spec| async move {
        if let Err(error) = logout_with_spec(root, &spec).await {
            crate::logging::log_executor_event(
                "plugin uninstall connector logout failed",
                &[("error_code", error.code)],
            );
        }
    }))
    .await;
}

async fn logout_with_spec(root: &Path, spec: &LocalAuthSpec) -> Result<Value, AppIpcError> {
    logout::complete(
        account_lifecycle(root, spec, "logout"),
        logout_local(root, spec),
    )
    .await
}

pub(super) async fn cancel_marketplace_plugin_sessions(plugin_dir: &Path) {
    cancel_browser_auth_sessions(|session| {
        session
            .plugin_root
            .as_deref()
            .is_some_and(|root| root.starts_with(plugin_dir))
    })
    .await;
}

async fn cancel_browser_auth_sessions(matches: impl Fn(&BrowserAuthSession) -> bool) {
    let mut sessions = browser_auth_sessions().lock().await;
    let ids: Vec<_> = sessions
        .iter()
        .filter(|(_, session)| matches(session))
        .map(|(id, _)| id.clone())
        .collect();
    let tasks: Vec<_> = ids
        .into_iter()
        .filter_map(|id| sessions.remove(&id))
        .map(|session| {
            session.task.abort();
            session.task
        })
        .collect();
    drop(sessions);
    for task in tasks {
        let _ = task.await;
    }
}

async fn logout_local(plugin_root: &Path, spec: &LocalAuthSpec) -> Result<Value, AppIpcError> {
    if spec.logout.is_empty() {
        return Ok(json!({ "status": "ok", "deleted": false }));
    }
    let tool = resolve_auth_tool(spec.tool.as_ref(), false).await?;
    let result = run_plugin_command(
        plugin_root,
        &spec.logout,
        tool.as_deref(),
        DEFAULT_COMMAND_TIMEOUT_SECONDS,
    )
    .await?;
    Ok(normalize_status_response(&result, spec, None))
}

pub async fn cancel(payload: Value) -> Result<Value, AppIpcError> {
    let session_id = request_session_id(&payload)?;
    let mut sessions = browser_auth_sessions().lock().await;
    let session = sessions.get(&session_id).ok_or_else(|| {
        AppIpcError::new(
            "local_auth_session_missing",
            "Authorization session was not found",
        )
    })?;
    validate_session_identity(&payload, session)?;
    let session = sessions
        .remove(&session_id)
        .expect("validated authorization session must still exist");
    session.task.abort();
    Ok(json!({
        "status": "cancelled",
        "sessionId": session_id,
        "hint": "Authorization was cancelled",
    }))
}

fn canonical_plugin_root(plugin_root: &Path) -> Result<PathBuf, AppIpcError> {
    plugin_root.canonicalize().map_err(|_| {
        AppIpcError::new(
            "plugin_root_missing",
            "The installed plugin package is unavailable",
        )
    })
}

#[cfg(test)]
fn load_local_auth_spec(
    plugin_root: &Path,
    connector_slug: Option<&str>,
) -> Result<LocalAuthSpec, AppIpcError> {
    parse_local_auth_spec(&read_plugin_manifest(plugin_root)?, connector_slug)
}

fn read_plugin_manifest(plugin_root: &Path) -> Result<Value, AppIpcError> {
    let manifest_path = [
        plugin_root.join(".codex-plugin/plugin.json"),
        plugin_root.join(".claude-plugin/plugin.json"),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .ok_or_else(|| AppIpcError::new("plugin_manifest_missing", "Plugin manifest is missing"))?;
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|error| AppIpcError::new("plugin_manifest_read_failed", error.to_string()))?;
    let manifest: Value = serde_json::from_str(&raw)
        .map_err(|error| AppIpcError::new("plugin_manifest_invalid", error.to_string()))?;
    Ok(manifest)
}

fn parse_local_auth_spec(
    manifest: &Value,
    connector_slug: Option<&str>,
) -> Result<LocalAuthSpec, AppIpcError> {
    let connector = manifest["connectors"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| {
            let slug = item.get("slug").and_then(Value::as_str).unwrap_or_default();
            match connector_slug {
                Some(expected) => slug == expected,
                None => item.get("localAuth").is_some(),
            }
        });
    let connector = connector.ok_or_else(|| {
        AppIpcError::new(
            "local_auth_missing",
            "Plugin does not declare a localAuth connector",
        )
    })?;
    parse_local_auth_connector(connector)
}

fn parse_local_auth_connector(connector: &Value) -> Result<LocalAuthSpec, AppIpcError> {
    let local_auth = connector
        .get("localAuth")
        .ok_or_else(|| AppIpcError::new("local_auth_missing", "localAuth is required"))?;
    let kind = local_auth
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("local_qr")
        .to_owned();
    if kind != "local_qr" && kind != "browser_oauth" {
        return Err(AppIpcError::new(
            "local_auth_invalid",
            format!("Unsupported localAuth kind: {kind}"),
        ));
    }
    let poll = if kind == "local_qr" {
        command_list(local_auth.get("poll"))?
    } else {
        optional_command_list(local_auth.get("poll"))?
    };
    let default_timeout = if kind == "browser_oauth" { 300 } else { 45 };
    Ok(LocalAuthSpec {
        connector_slug: connector["slug"].as_str().unwrap_or_default().to_owned(),
        account_auth: connector["accountAuth"].is_object(),
        kind,
        health: command_list(local_auth.get("health"))?,
        start: command_list(local_auth.get("start"))?,
        poll,
        logout: optional_command_list(local_auth.get("logout"))?,
        qr_field: local_auth
            .get("qrField")
            .and_then(Value::as_str)
            .unwrap_or("qr_path")
            .to_owned(),
        status_field: local_auth
            .get("statusField")
            .and_then(Value::as_str)
            .unwrap_or("status")
            .to_owned(),
        ok_values: local_auth
            .get("okValues")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|items| !items.is_empty())
            .unwrap_or_else(|| vec!["ok".to_owned()]),
        timeout_seconds: local_auth
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(default_timeout)
            .clamp(15, 600),
        tool: parse_tool_spec(local_auth.get("tool"))?,
    })
}

fn command_list(value: Option<&Value>) -> Result<Vec<String>, AppIpcError> {
    let Some(Value::Array(items)) = value else {
        return Err(AppIpcError::new(
            "local_auth_invalid",
            "localAuth command list is required",
        ));
    };
    let mut commands = Vec::new();
    for item in items {
        let Some(text) = item.as_str().map(str::trim).filter(|text| !text.is_empty()) else {
            continue;
        };
        validate_relative_arg(text)?;
        commands.push(text.to_owned());
    }
    if commands.is_empty() {
        return Err(AppIpcError::new(
            "local_auth_invalid",
            "localAuth command list is empty",
        ));
    }
    Ok(commands)
}

fn optional_command_list(value: Option<&Value>) -> Result<Vec<String>, AppIpcError> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) if items.is_empty() => Ok(Vec::new()),
        _ => command_list(value),
    }
}

pub(super) fn validate_relative_arg(arg: &str) -> Result<(), AppIpcError> {
    let path = Path::new(arg);
    if path.is_absolute()
        || arg.starts_with('~')
        || arg.contains('\\')
        || (arg.len() >= 3
            && arg.as_bytes()[0].is_ascii_alphabetic()
            && arg.as_bytes()[1] == b':'
            && matches!(arg.as_bytes()[2], b'/' | b'\\'))
    {
        return Err(AppIpcError::new(
            "local_auth_invalid",
            "Absolute paths are not allowed in localAuth commands",
        ));
    }
    for component in path.components() {
        if matches!(component, Component::RootDir | Component::Prefix(_)) {
            return Err(AppIpcError::new(
                "local_auth_invalid",
                "Absolute paths are not allowed in localAuth commands",
            ));
        }
        if matches!(component, Component::ParentDir) {
            return Err(AppIpcError::new(
                "local_auth_invalid",
                "Parent-directory traversal is not allowed in localAuth commands",
            ));
        }
    }
    Ok(())
}

fn ensure_wait_seconds_zero(command: &mut Vec<String>) {
    if let Some(index) = command.iter().position(|item| item == "--wait-seconds") {
        if let Some(value) = command.get_mut(index + 1) {
            *value = "0".to_owned();
            return;
        }
    }
    command.push("--wait-seconds".to_owned());
    command.push("0".to_owned());
}

fn browser_auth_sessions() -> &'static Mutex<HashMap<String, BrowserAuthSession>> {
    BROWSER_AUTH_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_browser_auth_state(
    sessions: &HashMap<String, BrowserAuthSession>,
    plugin_key: &str,
    connector_slug: &str,
    root: Option<&Path>,
    marketplace_id: Option<&str>,
) -> Option<Arc<Mutex<Value>>> {
    sessions
        .values()
        .find(|session| {
            session.plugin_key == plugin_key
                && session.connector_slug == connector_slug
                && session.plugin_root.as_deref() == root
                && session.marketplace_id.as_deref() == marketplace_id
                && !session.task.is_finished()
        })
        .map(|session| Arc::clone(&session.state))
}

async fn start_browser_auth(
    payload: Value,
    plugin_root: PathBuf,
    spec: LocalAuthSpec,
) -> Result<Value, AppIpcError> {
    let plugin_key = string_field(&payload, "pluginKey")
        .or_else(|| string_field(&payload, "plugin_key"))
        .ok_or_else(|| AppIpcError::new("bad_request", "pluginKey is required"))?;
    let connector_slug = string_field(&payload, "connectorSlug")
        .or_else(|| string_field(&payload, "connector_slug"))
        .or_else(|| string_field(&payload, "slug"))
        .ok_or_else(|| AppIpcError::new("bad_request", "connectorSlug is required"))?;
    let marketplace_id = string_field(&payload, "marketplaceId");
    // Check removal and register the task under the same lock used to cancel sessions.
    let mut sessions = browser_auth_sessions().lock().await;
    let session_root = canonical_plugin_root(&plugin_root)?;
    marketplace_auth()
        .lock()
        .unwrap()
        .check_removal(&session_root)?;
    if let Some(state) = active_browser_auth_state(
        &sessions,
        &plugin_key,
        &connector_slug,
        Some(&session_root),
        marketplace_id.as_deref(),
    ) {
        drop(sessions);
        return Ok(state.lock().await.clone());
    }
    let session_id = Uuid::new_v4().to_string();
    let state = Arc::new(Mutex::new(browser_session_state(
        "preparing",
        "Preparing the local authorization tool",
        &session_id,
    )));
    let task_state = Arc::clone(&state);
    let task_session_id = session_id.clone();
    let task = tokio::spawn(async move {
        let tool = match resolve_auth_tool(spec.tool.as_ref(), true).await {
            Ok(tool) => tool,
            Err(error) => {
                *task_state.lock().await = browser_session_state(
                    "error",
                    &redact_secrets(&error.message),
                    &task_session_id,
                );
                return;
            }
        };
        *task_state.lock().await = browser_session_state(
            "waiting_browser",
            "Complete authorization in the browser",
            &task_session_id,
        );
        let started = run_plugin_command(
            &plugin_root,
            &spec.start,
            tool.as_deref(),
            spec.timeout_seconds,
        )
        .await;
        let started = match started {
            Ok(result) => normalize_status_response(&result, &spec, None),
            Err(error) => {
                *task_state.lock().await = browser_session_state(
                    "error",
                    &redact_secrets(&error.message),
                    &task_session_id,
                );
                return;
            }
        };
        if started.get("status").and_then(Value::as_str) != Some("ok") {
            let hint = started
                .get("hint")
                .and_then(Value::as_str)
                .unwrap_or("Browser authorization did not complete");
            *task_state.lock().await = browser_session_state("error", hint, &task_session_id);
            return;
        }
        *task_state.lock().await = browser_session_state(
            "verifying",
            "Verifying the local authorization",
            &task_session_id,
        );
        let verified = run_plugin_command(
            &plugin_root,
            &spec.health,
            tool.as_deref(),
            DEFAULT_COMMAND_TIMEOUT_SECONDS,
        )
        .await;
        let mut final_state = match verified {
            Ok(result) => normalize_status_response(&result, &spec, None),
            Err(error) => {
                browser_session_state("error", &redact_secrets(&error.message), &task_session_id)
            }
        };
        if final_state["status"] == "ok" {
            if let Err(error) = account_lifecycle(&plugin_root, &spec, "login").await {
                final_state = browser_session_state("error", &error.code, &task_session_id);
            }
        }
        final_state["sessionId"] = Value::String(task_session_id);
        *task_state.lock().await = final_state;
    });

    let stale_ids = sessions
        .iter()
        .filter(|(_, session)| {
            session.plugin_key == plugin_key
                && session.connector_slug == connector_slug
                && session.plugin_root.as_deref() == Some(&session_root)
                && session.marketplace_id == marketplace_id
        })
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for stale_id in stale_ids {
        if let Some(stale) = sessions.remove(&stale_id) {
            stale.task.abort();
        }
    }
    sessions.insert(
        session_id.clone(),
        BrowserAuthSession {
            plugin_key,
            connector_slug,
            marketplace_id,
            plugin_root: Some(session_root),
            state,
            task,
        },
    );
    Ok(browser_session_state(
        "preparing",
        "Preparing the local authorization tool",
        &session_id,
    ))
}

async fn poll_browser_auth(payload: &Value) -> Result<Value, AppIpcError> {
    let session_id = request_session_id(payload)?;
    let sessions = browser_auth_sessions().lock().await;
    let session = sessions.get(&session_id).ok_or_else(|| {
        AppIpcError::new(
            "local_auth_session_missing",
            "Authorization session was not found",
        )
    })?;
    validate_session_identity(payload, session)?;
    let state = Arc::clone(&session.state);
    drop(sessions);
    let response = state.lock().await.clone();
    if matches!(
        response.get("status").and_then(Value::as_str),
        Some("ok" | "error" | "expired" | "cancelled")
    ) {
        browser_auth_sessions().lock().await.remove(&session_id);
    }
    Ok(response)
}

fn request_session_id(payload: &Value) -> Result<String, AppIpcError> {
    string_field(payload, "sessionId")
        .or_else(|| string_field(payload, "session_id"))
        .ok_or_else(|| AppIpcError::new("bad_request", "sessionId is required"))
}

fn validate_session_identity(
    payload: &Value,
    session: &BrowserAuthSession,
) -> Result<(), AppIpcError> {
    let plugin_key = string_field(payload, "pluginKey")
        .or_else(|| string_field(payload, "plugin_key"))
        .unwrap_or_default();
    let connector_slug = string_field(payload, "connectorSlug")
        .or_else(|| string_field(payload, "connector_slug"))
        .or_else(|| string_field(payload, "slug"))
        .unwrap_or_default();
    if plugin_key != session.plugin_key
        || connector_slug != session.connector_slug
        || string_field(payload, "marketplaceId") != session.marketplace_id
    {
        return Err(AppIpcError::new(
            "local_auth_session_mismatch",
            "Authorization session does not belong to this connector",
        ));
    }
    Ok(())
}

fn browser_session_state(status: &str, hint: &str, session_id: &str) -> Value {
    json!({
        "status": status,
        "rawStatus": status,
        "hint": hint,
        "sessionId": session_id,
    })
}

async fn account_lifecycle(
    root: &Path,
    spec: &LocalAuthSpec,
    action: &str,
) -> Result<Option<Value>, AppIpcError> {
    if !spec.account_auth {
        return Ok(None);
    }
    crate::plugin_account_auth::local_lifecycle::exchange(root, &spec.connector_slug, action)
        .await
        .map_err(|error| AppIpcError::new(error.0, error.0))
}

fn read_qr_image(result: &Value, qr_field: &str) -> Result<Option<Value>, AppIpcError> {
    let Some(path) = result.get(qr_field).and_then(Value::as_str) else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err(AppIpcError::new(
            "qr_image_missing",
            "QR image path from localAuth start does not exist",
        ));
    }
    let bytes = fs::read(&path)
        .map_err(|error| AppIpcError::new("qr_image_read_failed", error.to_string()))?;
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(AppIpcError::new(
            "qr_image_invalid",
            "QR image is not a PNG file",
        ));
    }
    Ok(Some(json!({
        "mimeType": "image/png",
        "dataUrl": format!("data:image/png;base64,{}", BASE64.encode(bytes)),
        "path": path.display().to_string(),
    })))
}

fn normalize_status_response(
    result: &Value,
    spec: &LocalAuthSpec,
    qr_image: Option<Value>,
) -> Value {
    let status = result
        .get(&spec.status_field)
        .and_then(Value::as_str)
        .unwrap_or("error")
        .to_owned();
    let normalized = if spec.ok_values.iter().any(|value| value == &status) {
        "ok".to_owned()
    } else {
        match status.as_str() {
            "preparing" | "waiting_browser" | "verifying" | "need_login" | "need_scan"
            | "waiting_scan" | "scanned" | "expired" | "cancelled" | "ok" => status.clone(),
            _ => "error".to_owned(),
        }
    };
    let mut output = json!({
        "status": normalized,
        "rawStatus": status,
        "hint": result.get("hint").cloned().unwrap_or(Value::Null),
        "sid": result.get("sid").cloned().unwrap_or(Value::Null),
        "qrPath": result.get(&spec.qr_field).cloned().unwrap_or(Value::Null),
    });
    if let Some(image) = qr_image {
        output["qrImage"] = image;
    }
    if let Some(title) = result.get("title") {
        output["title"] = title.clone();
    }
    if let Some(final_url) = result.get("final_url") {
        output["finalUrl"] = final_url.clone();
    }
    output
}

fn redact_secrets(value: &str) -> String {
    let mut text = value.to_owned();
    for pattern in [
        r"(?i)(cookie\s*[:=]\s*)([^\s;]+)",
        r"(?i)((?:access[_-]?token|refresh[_-]?token|private[_-]?token|authorization)\s*[:=]\s*)([^\s;,]+)",
        r"(?i)((?:qrc_key|qrc_sign|sid|lt)=)([^&\s]+)",
        r"(opentwiki_ow__session=)[^;\s]+",
        r"(JSESSIONID=)[^;\s]+",
    ] {
        if let Ok(regex) = regex::Regex::new(pattern) {
            text = regex.replace_all(&text, "$1***").into_owned();
        }
    }
    text.chars().take(500).collect()
}

#[cfg(test)]
#[path = "local_connector_auth/declared_connector_tests.rs"]
mod declared_connector_tests;

#[cfg(test)]
#[path = "local_connector_auth/tests.rs"]
mod tests;
