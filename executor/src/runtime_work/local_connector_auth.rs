//! Device-side local connector authentication.
//!
//! Executes plugin-declared relative CLI commands and manages immutable CLI
//! artifacts without sending credentials to the cloud or LLM.

use std::{
    collections::HashMap,
    env, fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use tokio::{process::Command, sync::Mutex, task::JoinHandle};
use uuid::Uuid;

use crate::local::app_ipc::AppIpcError;

use super::util::string_field;
use tools::{parse_tool_spec, resolve_auth_tool, LocalAuthToolSpec};

mod tools;

#[derive(Debug, Clone)]
struct LocalAuthSpec {
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
    state: Arc<Mutex<Value>>,
    task: JoinHandle<()>,
}

static BROWSER_AUTH_SESSIONS: OnceLock<Mutex<HashMap<String, BrowserAuthSession>>> =
    OnceLock::new();

const DEFAULT_COMMAND_TIMEOUT_SECONDS: u64 = 45;

pub async fn health(payload: Value) -> Result<Value, AppIpcError> {
    let (plugin_root, spec) = resolve_request(&payload)?;
    let tool = resolve_auth_tool(spec.tool.as_ref(), false).await?;
    let result = run_plugin_command(
        &plugin_root,
        &spec.health,
        tool.as_deref(),
        DEFAULT_COMMAND_TIMEOUT_SECONDS,
    )
    .await?;
    Ok(normalize_status_response(&result, &spec, None))
}

pub async fn start(payload: Value) -> Result<Value, AppIpcError> {
    let (plugin_root, spec) = resolve_request(&payload)?;
    if spec.kind == "browser_oauth" {
        return start_browser_auth(payload, plugin_root, spec).await;
    }
    let tool = resolve_auth_tool(spec.tool.as_ref(), true).await?;
    let result = run_plugin_command(
        &plugin_root,
        &spec.start,
        tool.as_deref(),
        spec.timeout_seconds,
    )
    .await?;
    let qr_image = read_qr_image(&result, &spec.qr_field)?;
    Ok(normalize_status_response(&result, &spec, qr_image))
}

pub async fn poll(payload: Value) -> Result<Value, AppIpcError> {
    let (plugin_root, spec) = resolve_request(&payload)?;
    if spec.kind == "browser_oauth" {
        return poll_browser_auth(&payload).await;
    }
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
    Ok(normalize_status_response(&result, &spec, qr_image))
}

pub async fn logout(payload: Value) -> Result<Value, AppIpcError> {
    let (plugin_root, spec) = resolve_request(&payload)?;
    if spec.logout.is_empty() {
        return Ok(json!({ "status": "ok", "deleted": false }));
    }
    let tool = resolve_auth_tool(spec.tool.as_ref(), false).await?;
    let result = run_plugin_command(
        &plugin_root,
        &spec.logout,
        tool.as_deref(),
        DEFAULT_COMMAND_TIMEOUT_SECONDS,
    )
    .await?;
    Ok(normalize_status_response(&result, &spec, None))
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

fn resolve_request(payload: &Value) -> Result<(PathBuf, LocalAuthSpec), AppIpcError> {
    let plugin_key = string_field(payload, "pluginKey")
        .or_else(|| string_field(payload, "plugin_key"))
        .ok_or_else(|| AppIpcError::new("bad_request", "pluginKey is required"))?;
    let connector_slug = string_field(payload, "connectorSlug")
        .or_else(|| string_field(payload, "connector_slug"))
        .or_else(|| string_field(payload, "slug"));
    let candidates = resolve_plugin_root_candidates(&plugin_key, payload)?;
    let mut last_error: Option<AppIpcError> = None;
    for plugin_root in candidates {
        match load_local_auth_spec(&plugin_root, connector_slug.as_deref()) {
            Ok(spec) => return Ok((plugin_root, spec)),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        AppIpcError::new(
            "plugin_not_installed",
            format!("Installed plugin '{plugin_key}' was not found on this device"),
        )
    }))
}

fn store_dir_matches_plugin_key(dir_name: &str, plugin_key: &str) -> bool {
    // Prefer exact plugin-key segments so "weibo" does not steal "gitlab-weibo"
    // or an older "weibo-api-wiki" package without connectors.
    let needle = format!("-{plugin_key}-");
    dir_name.contains(&needle)
        || dir_name.ends_with(&format!("-{plugin_key}"))
        || dir_name == plugin_key
}

fn resolve_plugin_root_candidates(
    plugin_key: &str,
    payload: &Value,
) -> Result<Vec<PathBuf>, AppIpcError> {
    if let Some(explicit) =
        string_field(payload, "pluginRoot").or_else(|| string_field(payload, "plugin_root"))
    {
        let path = PathBuf::from(explicit);
        if path.is_dir() {
            return Ok(vec![path]);
        }
        return Err(AppIpcError::new(
            "plugin_root_missing",
            format!("pluginRoot does not exist: {}", path.display()),
        ));
    }

    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| AppIpcError::new("internal_error", "HOME is not set"))?;
    let executor_home = env::var_os("WEGENT_EXECUTOR_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".wegent-executor"));

    let mut candidates: Vec<PathBuf> = Vec::new();
    let store_plugins = executor_home.join("capabilities/store/plugins");
    if store_plugins.is_dir() {
        if let Ok(entries) = fs::read_dir(&store_plugins) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if store_dir_matches_plugin_key(&name, plugin_key) {
                    candidates.push(entry.path());
                }
            }
        }
    }

    let cache_root = executor_home
        .join("codex/plugins/cache")
        .join("wegent")
        .join(plugin_key);
    if cache_root.is_dir() {
        if let Ok(entries) = fs::read_dir(&cache_root) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    candidates.push(entry.path());
                }
            }
        } else {
            candidates.push(cache_root);
        }
    }

    // Prefer the newest version directory by name, then skip packages whose
    // manifest lacks the requested localAuth connector.
    candidates.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    candidates.retain(|candidate| has_plugin_manifest(candidate));
    if candidates.is_empty() {
        return Err(AppIpcError::new(
            "plugin_not_installed",
            format!("Installed plugin '{plugin_key}' was not found on this device"),
        ));
    }
    Ok(candidates)
}

fn has_plugin_manifest(path: &Path) -> bool {
    path.join(".codex-plugin/plugin.json").is_file()
        || path.join(".claude-plugin/plugin.json").is_file()
}

fn load_local_auth_spec(
    plugin_root: &Path,
    connector_slug: Option<&str>,
) -> Result<LocalAuthSpec, AppIpcError> {
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
    let connectors = manifest
        .get("connectors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let connector = connectors.into_iter().find(|item| {
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
        final_state["sessionId"] = Value::String(task_session_id);
        *task_state.lock().await = final_state;
    });

    let mut sessions = browser_auth_sessions().lock().await;
    let stale_ids = sessions
        .iter()
        .filter(|(_, session)| {
            session.plugin_key == plugin_key && session.connector_slug == connector_slug
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
    if plugin_key != session.plugin_key || connector_slug != session.connector_slug {
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

async fn run_plugin_command(
    plugin_root: &Path,
    args: &[String],
    tool: Option<&Path>,
    timeout_seconds: u64,
) -> Result<Value, AppIpcError> {
    if args.is_empty() {
        return Err(AppIpcError::new(
            "local_auth_invalid",
            "Command arguments are required",
        ));
    }
    let program = resolve_program(plugin_root, &args[0])?;
    let rest = &args[1..];
    let mut command = if looks_like_shell_script(&program) {
        let mut cmd = Command::new("sh");
        cmd.arg(&program);
        for arg in rest {
            cmd.arg(arg);
        }
        cmd
    } else if program.extension().and_then(|ext| ext.to_str()) == Some("ps1") {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-File"]);
        cmd.arg(&program);
        for arg in rest {
            cmd.arg(arg);
        }
        cmd
    } else {
        let mut cmd = Command::new(&program);
        for arg in rest {
            cmd.arg(arg);
        }
        cmd
    };
    command
        .current_dir(plugin_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(tool) = tool {
        command.env("WEGENT_LOCAL_AUTH_TOOL", tool);
    }
    let output = tokio::time::timeout(Duration::from_secs(timeout_seconds), command.output())
        .await
        .map_err(|_| AppIpcError::new("local_auth_timeout", "localAuth command timed out"))?
        .map_err(|error| AppIpcError::new("local_auth_failed", error.to_string()))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if stdout.is_empty() {
        return Err(AppIpcError::new(
            "local_auth_failed",
            if stderr.is_empty() {
                "localAuth command returned empty output".to_owned()
            } else {
                redact_secrets(&stderr)
            },
        ));
    }
    let parsed: Value = serde_json::from_str(&stdout).map_err(|error| {
        AppIpcError::new(
            "local_auth_invalid_json",
            format!(
                "localAuth command returned invalid JSON: {}; stderr={}",
                error,
                redact_secrets(&stderr)
            ),
        )
    })?;
    // Non-zero exit is allowed for need_login/health failures when JSON is present.
    let _ = output.status;
    Ok(parsed)
}

fn resolve_program(plugin_root: &Path, arg: &str) -> Result<PathBuf, AppIpcError> {
    validate_relative_arg(arg)?;
    let candidate = plugin_root.join(arg);
    if cfg!(windows)
        && candidate
            .extension()
            .and_then(|extension| extension.to_str())
            == Some("sh")
    {
        let powershell = candidate.with_extension("ps1");
        if powershell.is_file() {
            return Ok(powershell);
        }
    }
    if candidate.exists() {
        return Ok(candidate);
    }
    // Allow bare interpreter names such as python3 only when no path separators.
    if !arg.contains('/') && !arg.contains('\\') {
        return Ok(PathBuf::from(arg));
    }
    Err(AppIpcError::new(
        "local_auth_command_missing",
        format!("Command not found in plugin: {arg}"),
    ))
}

fn looks_like_shell_script(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("sh") | Some("bash")
    )
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
mod tests {
    use super::*;

    #[test]
    fn force_nonblocking_poll_args() {
        let mut command = vec![
            "scripts/run-weibo-wiki.sh".to_owned(),
            "auth".to_owned(),
            "status".to_owned(),
            "--wait-seconds".to_owned(),
            "120".to_owned(),
        ];
        ensure_wait_seconds_zero(&mut command);
        assert_eq!(command.last().map(String::as_str), Some("0"));

        let mut missing = vec![
            "scripts/run.sh".to_owned(),
            "auth".to_owned(),
            "status".to_owned(),
        ];
        ensure_wait_seconds_zero(&mut missing);
        assert!(missing
            .windows(2)
            .any(|pair| pair == ["--wait-seconds", "0"]));
    }

    #[test]
    fn reject_absolute_and_parent_paths() {
        assert!(validate_relative_arg("scripts/run.sh").is_ok());
        assert!(validate_relative_arg("/tmp/evil").is_err());
        assert!(validate_relative_arg("../escape").is_err());
    }

    #[test]
    fn normalize_ok_status() {
        let spec = LocalAuthSpec {
            kind: "local_qr".to_owned(),
            health: vec![],
            start: vec![],
            poll: vec![],
            logout: vec![],
            qr_field: "qr_path".to_owned(),
            status_field: "status".to_owned(),
            ok_values: vec!["ok".to_owned()],
            timeout_seconds: 45,
            tool: None,
        };
        let result =
            normalize_status_response(&json!({"status": "ok", "hint": "ready"}), &spec, None);
        assert_eq!(result.get("status").and_then(Value::as_str), Some("ok"));
        assert_eq!(result.get("rawStatus").and_then(Value::as_str), Some("ok"));
    }
}
