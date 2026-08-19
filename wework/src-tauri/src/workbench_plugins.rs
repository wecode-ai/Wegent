use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;

const MANIFEST_PATH: &str = ".wework-plugin/plugin.json";
const SIDECAR_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchFrontendModule {
    entry: String,
    export: Option<String>,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchDesktopSidecar {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    sha256: String,
    #[serde(default)]
    capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchPluginManifest {
    name: String,
    version: Option<String>,
    #[serde(default = "default_api_version")]
    api_version: String,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    pinned_to_client_version: bool,
    client_version: Option<String>,
    frontend: Option<WorkbenchFrontendModule>,
    desktop: Option<WorkbenchDesktopSidecar>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedWorkbenchPlugin {
    root: String,
    manifest: WorkbenchPluginManifest,
    frontend_path: Option<String>,
    frontend_source: Option<String>,
    desktop_path: Option<String>,
}

struct RunningSidecar {
    child: Child,
    stdin: ChildStdin,
    responses: mpsc::Receiver<Result<Value, String>>,
    next_request_id: u64,
    capabilities: Vec<String>,
}

#[derive(Default)]
pub struct WorkbenchPluginState {
    sidecars: Mutex<HashMap<String, Arc<Mutex<RunningSidecar>>>>,
}

fn default_api_version() -> String {
    "1".to_string()
}

fn normalize_plugin_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("Plugin id must contain only letters, numbers, '-', '_' or '.'".to_string());
    }
    Ok(value.to_string())
}

fn canonical_plugin_root(raw_root: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(raw_root.trim())
        .map_err(|error| format!("Failed to resolve plugin root: {error}"))?;
    if !root.is_dir() {
        return Err("Plugin root is not a directory".to_string());
    }
    if !root.join(MANIFEST_PATH).is_file() {
        return Err(format!("Plugin root is missing {MANIFEST_PATH}"));
    }
    Ok(root)
}

fn resolve_package_file(root: &Path, relative: &str, field: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("Failed to resolve {field}: {error}"))?;
    if !canonical.is_file() || !canonical.starts_with(root) {
        return Err(format!(
            "{field} must resolve to a file inside the plugin package"
        ));
    }
    Ok(canonical)
}

fn verify_sha256_bytes(bytes: &[u8], expected: &str, field: &str) -> Result<(), String> {
    let expected = expected.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{field} must be a SHA-256 hex digest"));
    }
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        return Err(format!("{field} SHA-256 mismatch"));
    }
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str, field: &str) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|error| format!("Failed to read {field}: {error}"))?;
    verify_sha256_bytes(&bytes, expected, field)
}

fn inspect_plugin(raw_root: &str) -> Result<InspectedWorkbenchPlugin, String> {
    let root = canonical_plugin_root(raw_root)?;
    let manifest_bytes = fs::read(root.join(MANIFEST_PATH))
        .map_err(|error| format!("Failed to read {MANIFEST_PATH}: {error}"))?;
    let manifest: WorkbenchPluginManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Invalid {MANIFEST_PATH}: {error}"))?;
    if manifest.api_version != "1" {
        return Err(format!(
            "Unsupported Wework plugin apiVersion '{}'",
            manifest.api_version
        ));
    }
    if manifest.frontend.is_none() && manifest.desktop.is_none() {
        return Err("Wework plugin must declare frontend or desktop".to_string());
    }
    if manifest.required && !manifest.pinned_to_client_version {
        return Err("Required Wework plugins must set pinnedToClientVersion".to_string());
    }
    if manifest.pinned_to_client_version
        && manifest.client_version.as_deref().unwrap_or("").is_empty()
    {
        return Err("Pinned Wework plugins must declare clientVersion".to_string());
    }

    let frontend = manifest
        .frontend
        .as_ref()
        .map(|frontend| {
            let path = resolve_package_file(&root, &frontend.entry, "frontend.entry")?;
            let bytes = fs::read(&path)
                .map_err(|error| format!("Failed to read frontend.entry: {error}"))?;
            verify_sha256_bytes(&bytes, &frontend.sha256, "frontend.entry")?;
            let source = String::from_utf8(bytes)
                .map_err(|_| "frontend.entry must contain valid UTF-8 JavaScript".to_string())?;
            Ok::<(String, String), String>((path.to_string_lossy().into_owned(), source))
        })
        .transpose()?;
    let desktop_path = manifest
        .desktop
        .as_ref()
        .map(|desktop| {
            let path = resolve_package_file(&root, &desktop.command, "desktop.command")?;
            verify_sha256(&path, &desktop.sha256, "desktop.command")?;
            Ok::<String, String>(path.to_string_lossy().into_owned())
        })
        .transpose()?;

    Ok(InspectedWorkbenchPlugin {
        root: root.to_string_lossy().into_owned(),
        manifest,
        frontend_path: frontend.as_ref().map(|(path, _)| path.clone()),
        frontend_source: frontend.map(|(_, source)| source),
        desktop_path,
    })
}

fn plugin_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        roots.push(PathBuf::from(codex_home).join("plugins"));
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".codex/plugins"));
        roots.push(home.join(".agents/plugins"));
        roots.push(home.join(".wework/plugins"));
    }
    roots
}

fn canonical_plugin_search_roots() -> Vec<PathBuf> {
    plugin_search_roots()
        .into_iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .collect()
}

fn inspect_discovered_plugin(raw_root: &str) -> Result<InspectedWorkbenchPlugin, String> {
    let root = canonical_plugin_root(raw_root)?;
    if !canonical_plugin_search_roots()
        .iter()
        .any(|search_root| root.starts_with(search_root))
    {
        return Err("Plugin root is outside the approved local plugin directories".to_string());
    }
    inspect_plugin(root.to_string_lossy().as_ref())
}

fn collect_plugin_roots(directory: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth == 0 || !directory.is_dir() {
        return;
    }
    if directory.join(MANIFEST_PATH).is_file() {
        output.push(directory.to_path_buf());
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() && !file_type.is_symlink() {
            collect_plugin_roots(&entry.path(), depth - 1, output);
        }
    }
}

fn list_workbench_plugins() -> Vec<InspectedWorkbenchPlugin> {
    let mut roots = Vec::new();
    for search_root in plugin_search_roots() {
        collect_plugin_roots(&search_root, 6, &mut roots);
    }
    roots.sort();
    roots.dedup();
    roots
        .into_iter()
        .filter_map(|root| inspect_plugin(root.to_string_lossy().as_ref()).ok())
        .collect()
}

#[tauri::command]
pub async fn workbench_plugin_list() -> Result<Vec<InspectedWorkbenchPlugin>, String> {
    tauri::async_runtime::spawn_blocking(list_workbench_plugins)
        .await
        .map_err(|error| format!("Failed to join Workbench plugin scan: {error}"))
}

#[tauri::command]
pub fn workbench_plugin_inspect(plugin_root: String) -> Result<InspectedWorkbenchPlugin, String> {
    inspect_discovered_plugin(&plugin_root)
}

#[tauri::command]
pub fn workbench_plugin_start(
    state: State<'_, WorkbenchPluginState>,
    plugin_id: String,
    plugin_root: String,
) -> Result<(), String> {
    let plugin_id = normalize_plugin_id(&plugin_id)?;
    let inspected = inspect_discovered_plugin(&plugin_root)?;
    if inspected.manifest.name != plugin_id {
        return Err("Plugin id must match the package manifest name".to_string());
    }
    let desktop = inspected
        .manifest
        .desktop
        .ok_or_else(|| "Plugin does not declare a desktop sidecar".to_string())?;
    let command = inspected
        .desktop_path
        .ok_or_else(|| "Plugin desktop command was not resolved".to_string())?;
    let mut sidecars = state
        .sidecars
        .lock()
        .map_err(|_| "Workbench plugin state lock is poisoned".to_string())?;
    if sidecars.contains_key(&plugin_id) {
        return Err(format!("Workbench plugin '{plugin_id}' is already running"));
    }

    let mut child = Command::new(command)
        .args(&desktop.args)
        .current_dir(&inspected.root)
        .env("WEWORK_PLUGIN_ID", &plugin_id)
        .env("WEWORK_PLUGIN_ROOT", &inspected.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Failed to start workbench plugin '{plugin_id}': {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Plugin sidecar stdin was not created".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Plugin sidecar stdout was not created".to_string())?;
    let (responses_tx, responses) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let message = line
                .map_err(|error| format!("Failed to read plugin response: {error}"))
                .and_then(|line| {
                    serde_json::from_str(&line)
                        .map_err(|error| format!("Plugin returned invalid JSON-RPC: {error}"))
                });
            if responses_tx.send(message).is_err() {
                break;
            }
        }
    });
    sidecars.insert(
        plugin_id,
        Arc::new(Mutex::new(RunningSidecar {
            child,
            stdin,
            responses,
            next_request_id: 1,
            capabilities: desktop.capabilities,
        })),
    );
    Ok(())
}

fn stop_sidecar(state: &WorkbenchPluginState, plugin_id: &str) -> Result<(), String> {
    let sidecar = state
        .sidecars
        .lock()
        .map_err(|_| "Workbench plugin state lock is poisoned".to_string())?
        .remove(plugin_id);
    if let Some(sidecar) = sidecar {
        let mut sidecar = sidecar
            .lock()
            .map_err(|_| "Workbench plugin sidecar lock is poisoned".to_string())?;
        let _ = sidecar.child.kill();
        let _ = sidecar.child.wait();
    }
    Ok(())
}

fn read_matching_response(
    sidecar: &RunningSidecar,
    plugin_id: &str,
    request_id: u64,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "Workbench plugin '{plugin_id}' timed out waiting for response"
            ));
        }
        let response =
            sidecar
                .responses
                .recv_timeout(remaining)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => {
                        format!("Workbench plugin '{plugin_id}' timed out waiting for response")
                    }
                    mpsc::RecvTimeoutError::Disconnected => {
                        format!("Workbench plugin '{plugin_id}' exited before responding")
                    }
                })??;
        if response.get("id").and_then(Value::as_u64) != Some(request_id) {
            continue;
        }
        if let Some(error) = response.get("error") {
            return Err(format!("Plugin JSON-RPC error: {error}"));
        }
        return Ok(response.get("result").cloned().unwrap_or(Value::Null));
    }
}

#[tauri::command]
pub fn workbench_plugin_request(
    state: State<'_, WorkbenchPluginState>,
    plugin_id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let plugin_id = normalize_plugin_id(&plugin_id)?;
    let method = method.trim();
    if method.is_empty() {
        return Err("JSON-RPC method is required".to_string());
    }
    let sidecar = state
        .sidecars
        .lock()
        .map_err(|_| "Workbench plugin state lock is poisoned".to_string())?
        .get(&plugin_id)
        .cloned()
        .ok_or_else(|| format!("Workbench plugin '{plugin_id}' is not running"))?;
    let result = {
        let mut sidecar = sidecar
            .lock()
            .map_err(|_| "Workbench plugin sidecar lock is poisoned".to_string())?;
        if !sidecar
            .capabilities
            .iter()
            .any(|capability| capability == method)
        {
            return Err(format!(
                "Workbench plugin '{plugin_id}' is not authorized for capability '{method}'"
            ));
        }
        let request_id = sidecar.next_request_id;
        sidecar.next_request_id += 1;
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });
        serde_json::to_writer(&mut sidecar.stdin, &request)
            .map_err(|error| format!("Failed to write plugin request: {error}"))?;
        sidecar
            .stdin
            .write_all(b"\n")
            .and_then(|_| sidecar.stdin.flush())
            .map_err(|error| format!("Failed to flush plugin request: {error}"))?;
        read_matching_response(&sidecar, &plugin_id, request_id, SIDECAR_RESPONSE_TIMEOUT)
    };
    if result
        .as_ref()
        .is_err_and(|error| error.contains("timed out") || error.contains("exited"))
    {
        let _ = stop_sidecar(&state, &plugin_id);
    }
    result
}

#[tauri::command]
pub fn workbench_plugin_stop(
    state: State<'_, WorkbenchPluginState>,
    plugin_id: String,
) -> Result<(), String> {
    let plugin_id = normalize_plugin_id(&plugin_id)?;
    stop_sidecar(&state, &plugin_id)
}

#[tauri::command]
pub fn workbench_plugin_authorize_capability(
    plugin_root: String,
    capability: String,
) -> Result<bool, String> {
    let inspected = inspect_discovered_plugin(&plugin_root)?;
    let capabilities = inspected
        .manifest
        .desktop
        .map(|desktop| desktop.capabilities)
        .unwrap_or_default();
    Ok(capabilities.iter().any(|item| item == capability.trim()))
}

pub fn shutdown(state: &WorkbenchPluginState) {
    let Ok(mut sidecars) = state.sidecars.lock() else {
        return;
    };
    for (_, sidecar) in sidecars.drain() {
        let Ok(mut sidecar) = sidecar.lock() else {
            continue;
        };
        let _ = sidecar.child.kill();
        let _ = sidecar.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn inspect_rejects_integrity_mismatch() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(".wework-plugin")).unwrap();
        fs::write(root.path().join("frontend.js"), "export default {}").unwrap();
        fs::write(
            root.path().join(MANIFEST_PATH),
            r#"{
                "name":"test",
                "apiVersion":"1",
                "frontend":{"entry":"frontend.js","sha256":"0000000000000000000000000000000000000000000000000000000000000000"}
            }"#,
        )
        .unwrap();

        assert!(inspect_plugin(root.path().to_str().unwrap())
            .unwrap_err()
            .contains("SHA-256 mismatch"));
    }

    #[test]
    fn package_file_cannot_escape_plugin_root() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let outside_file = outside.path().join("sidecar");
        fs::write(&outside_file, "binary").unwrap();

        assert!(
            resolve_package_file(root.path(), outside_file.to_str().unwrap(), "command")
                .unwrap_err()
                .contains("inside the plugin package")
        );
    }

    #[test]
    fn plugin_ids_accept_periods() {
        assert_eq!(
            normalize_plugin_id("example.plugin").unwrap(),
            "example.plugin"
        );
    }

    #[test]
    fn response_reader_skips_notifications_and_mismatched_ids() {
        let (sender, responses) = mpsc::channel();
        sender
            .send(Ok(serde_json::json!({"jsonrpc":"2.0","method":"status"})))
            .unwrap();
        sender
            .send(Ok(
                serde_json::json!({"jsonrpc":"2.0","id":4,"result":"old"}),
            ))
            .unwrap();
        sender
            .send(Ok(
                serde_json::json!({"jsonrpc":"2.0","id":5,"result":"ok"}),
            ))
            .unwrap();
        let sidecar = RunningSidecar {
            child: Command::new("true").spawn().unwrap(),
            stdin: Command::new("cat")
                .stdin(Stdio::piped())
                .spawn()
                .unwrap()
                .stdin
                .take()
                .unwrap(),
            responses,
            next_request_id: 1,
            capabilities: vec![],
        };

        assert_eq!(
            read_matching_response(&sidecar, "example", 5, Duration::from_secs(1)).unwrap(),
            Value::String("ok".to_string())
        );
    }
}
