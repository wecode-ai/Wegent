use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const MANIFEST_PATH: &str = ".wework-plugin/plugin.json";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

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
    desktop_path: Option<String>,
}

struct RunningSidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_request_id: u64,
    capabilities: HashSet<String>,
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
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Plugin id must contain only letters, numbers, '-' or '_'".to_string());
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

fn verify_sha256(path: &Path, expected: &str, field: &str) -> Result<(), String> {
    let expected = expected.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{field} must be a SHA-256 hex digest"));
    }
    let bytes = fs::read(path).map_err(|error| format!("Failed to read {field}: {error}"))?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        return Err(format!("{field} SHA-256 mismatch"));
    }
    Ok(())
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

    let frontend_path = manifest
        .frontend
        .as_ref()
        .map(|frontend| {
            let path = resolve_package_file(&root, &frontend.entry, "frontend.entry")?;
            verify_sha256(&path, &frontend.sha256, "frontend.entry")?;
            Ok::<String, String>(path.to_string_lossy().into_owned())
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
        frontend_path,
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

#[tauri::command]
pub async fn workbench_plugin_list() -> Result<Vec<InspectedWorkbenchPlugin>, String> {
    tauri::async_runtime::spawn_blocking(|| {
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
    })
    .await
    .map_err(|error| format!("Failed to scan workbench plugins: {error}"))
}

#[tauri::command]
pub fn workbench_plugin_inspect(plugin_root: String) -> Result<InspectedWorkbenchPlugin, String> {
    inspect_plugin(&plugin_root)
}

#[tauri::command]
pub async fn workbench_plugin_start(
    state: State<'_, WorkbenchPluginState>,
    plugin_id: String,
    plugin_root: String,
) -> Result<(), String> {
    let plugin_id = normalize_plugin_id(&plugin_id)?;
    {
        let sidecars = state
            .sidecars
            .lock()
            .map_err(|_| "Workbench plugin state lock is poisoned".to_string())?;
        if sidecars.contains_key(&plugin_id) {
            return Err(format!("Workbench plugin '{plugin_id}' is already running"));
        }
    }
    let spawn_plugin_id = plugin_id.clone();
    let sidecar =
        tauri::async_runtime::spawn_blocking(move || spawn_sidecar(&spawn_plugin_id, &plugin_root))
            .await
            .map_err(|error| format!("Failed to join workbench plugin startup: {error}"))??;
    let sidecar = Arc::new(Mutex::new(sidecar));
    let replaced = {
        let mut sidecars = state
            .sidecars
            .lock()
            .map_err(|_| "Workbench plugin state lock is poisoned".to_string())?;
        if sidecars.contains_key(&plugin_id) {
            true
        } else {
            sidecars.insert(plugin_id.clone(), Arc::clone(&sidecar));
            false
        }
    };
    if replaced {
        if let Ok(mut sidecar) = sidecar.lock() {
            terminate_process_tree(&mut sidecar.child);
        }
        return Err(format!("Workbench plugin '{plugin_id}' is already running"));
    }
    Ok(())
}

#[tauri::command]
pub async fn workbench_plugin_request(
    state: State<'_, WorkbenchPluginState>,
    plugin_id: String,
    capability: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let plugin_id = normalize_plugin_id(&plugin_id)?;
    let capability = capability.trim().to_string();
    if capability.is_empty() {
        return Err("Plugin capability is required".to_string());
    }
    let method = method.trim().to_string();
    if method.is_empty() {
        return Err("JSON-RPC method is required".to_string());
    }
    let sidecar = {
        let sidecars = state
            .sidecars
            .lock()
            .map_err(|_| "Workbench plugin state lock is poisoned".to_string())?;
        Arc::clone(
            sidecars
                .get(&plugin_id)
                .ok_or_else(|| format!("Workbench plugin '{plugin_id}' is not running"))?,
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut sidecar = sidecar
            .lock()
            .map_err(|_| format!("Workbench plugin '{plugin_id}' lock is poisoned"))?;
        request_sidecar(&plugin_id, &capability, &method, params, &mut sidecar)
    })
    .await
    .map_err(|error| format!("Failed to join workbench plugin request: {error}"))?
}

fn spawn_sidecar(plugin_id: &str, plugin_root: &str) -> Result<RunningSidecar, String> {
    let inspected = inspect_plugin(plugin_root)?;
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
    let mut command = Command::new(command);
    command
        .args(&desktop.args)
        .current_dir(&inspected.root)
        .env("WEWORK_PLUGIN_ID", plugin_id)
        .env("WEWORK_PLUGIN_ROOT", &inspected.root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_process_group(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start workbench plugin '{plugin_id}': {error}"))?;
    let Some(stdin) = child.stdin.take() else {
        terminate_process_tree(&mut child);
        return Err("Plugin sidecar stdin was not created".to_string());
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_process_tree(&mut child);
        return Err("Plugin sidecar stdout was not created".to_string());
    };
    Ok(RunningSidecar {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        next_request_id: 1,
        capabilities: desktop.capabilities.into_iter().collect(),
    })
}

fn request_sidecar(
    plugin_id: &str,
    capability: &str,
    method: &str,
    params: Value,
    sidecar: &mut RunningSidecar,
) -> Result<Value, String> {
    if !sidecar.capabilities.contains(capability) {
        return Err(format!(
            "Workbench plugin '{plugin_id}' is not authorized for capability '{capability}'"
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

    let response_frame = read_response_frame(&mut sidecar.stdout).map_err(|error| {
        terminate_process_tree(&mut sidecar.child);
        format!("Failed to read plugin response: {error}")
    })?;
    let response: Value = serde_json::from_slice(&response_frame)
        .map_err(|error| format!("Plugin returned invalid JSON-RPC: {error}"))?;
    if response.get("id").and_then(Value::as_u64) != Some(request_id) {
        return Err("Plugin returned a mismatched JSON-RPC response id".to_string());
    }
    if let Some(error) = response.get("error") {
        return Err(format!("Plugin JSON-RPC error: {error}"));
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

fn read_response_frame(reader: &mut impl BufRead) -> Result<Vec<u8>, String> {
    let mut frame = Vec::new();
    loop {
        let (consumed, complete) = {
            let available = reader
                .fill_buf()
                .map_err(|error| format!("I/O error: {error}"))?;
            if available.is_empty() {
                if frame.is_empty() {
                    return Err("plugin exited before responding".to_string());
                }
                return Err("plugin response ended before a newline delimiter".to_string());
            }
            let consumed = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if frame.len() + consumed > MAX_RESPONSE_BYTES {
                return Err(format!(
                    "plugin response exceeds {} bytes",
                    MAX_RESPONSE_BYTES
                ));
            }
            frame.extend_from_slice(&available[..consumed]);
            (consumed, available[consumed - 1] == b'\n')
        };
        reader.consume(consumed);
        if complete {
            return Ok(frame);
        }
    }
}

#[tauri::command]
pub async fn workbench_plugin_stop(
    state: State<'_, WorkbenchPluginState>,
    plugin_id: String,
) -> Result<(), String> {
    let plugin_id = normalize_plugin_id(&plugin_id)?;
    let sidecar = state
        .sidecars
        .lock()
        .map_err(|_| "Workbench plugin state lock is poisoned".to_string())?
        .remove(&plugin_id);
    if let Some(sidecar) = sidecar {
        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(mut sidecar) = sidecar.lock() {
                terminate_process_tree(&mut sidecar.child);
            }
        })
        .await
        .map_err(|error| format!("Failed to join workbench plugin shutdown: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn workbench_plugin_authorize_capability(
    plugin_root: String,
    capability: String,
) -> Result<bool, String> {
    let inspected = inspect_plugin(&plugin_root)?;
    let capabilities = inspected
        .manifest
        .desktop
        .map(|desktop| desktop.capabilities)
        .unwrap_or_default();
    Ok(capabilities.iter().any(|item| item == capability.trim()))
}

pub fn shutdown(state: &WorkbenchPluginState) {
    let Ok(mut registry) = state.sidecars.lock() else {
        return;
    };
    let sidecars = registry
        .drain()
        .map(|(_, sidecar)| sidecar)
        .collect::<Vec<_>>();
    drop(registry);
    for sidecar in sidecars {
        if let Ok(mut sidecar) = sidecar.lock() {
            terminate_process_tree(&mut sidecar.child);
        }
    }
}

fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
}

fn terminate_process_tree(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        let process_group = child.id() as libc::pid_t;
        let _ = libc::kill(-process_group, libc::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = libc::kill(-process_group, libc::SIGKILL);
        let _ = child.wait();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
        let _ = child.wait();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.kill();
        let _ = child.wait();
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
    fn response_frame_is_bounded() {
        let payload = vec![b'a'; MAX_RESPONSE_BYTES + 1];
        let mut reader = BufReader::new(payload.as_slice());

        assert!(read_response_frame(&mut reader)
            .unwrap_err()
            .contains("exceeds"));
    }

    #[test]
    fn response_frame_requires_newline() {
        let mut reader = BufReader::new(br#"{"jsonrpc":"2.0"}"#.as_slice());

        assert!(read_response_frame(&mut reader)
            .unwrap_err()
            .contains("newline delimiter"));
    }
}
