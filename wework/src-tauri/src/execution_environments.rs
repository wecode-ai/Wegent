use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tar::Archive;
use tauri::{Emitter, Manager, State};

const RESOURCE_DIRECTORY: &str = "bundled-execution-runtimes";
const NODE_DESCRIPTOR: &str = "node.json";
const STATUS_EVENT: &str = "execution-environment-status-changed";
const MAX_ARCHIVE_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDescriptor {
    id: String,
    version: String,
    fingerprint: String,
    archive_sha256: String,
    archive_bytes: u64,
    download_url: String,
    installed_bytes: u64,
}

#[derive(Deserialize)]
struct RuntimeIdentity {
    id: String,
    version: String,
    fingerprint: String,
}

#[derive(Clone, Default)]
struct RuntimeProgress {
    state: String,
    version: Option<String>,
    downloaded_bytes: u64,
    total_bytes: u64,
    installed_bytes: u64,
    path: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEnvironmentStatus {
    id: String,
    managed: bool,
    auto_install: bool,
    state: String,
    version: Option<String>,
    downloaded_bytes: u64,
    total_bytes: u64,
    installed_bytes: u64,
    path: Option<String>,
    error: Option<String>,
}

pub struct ExecutionEnvironmentState {
    progress: Mutex<RuntimeProgress>,
    install: Mutex<()>,
}

impl Default for ExecutionEnvironmentState {
    fn default() -> Self {
        Self {
            progress: Mutex::new(RuntimeProgress {
                state: "idle".to_string(),
                ..RuntimeProgress::default()
            }),
            install: Mutex::new(()),
        }
    }
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("execution-runtimes"))
        .map_err(|error| format!("Failed to resolve execution runtime directory: {error}"))
}

fn node_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(root(app)?.join("node"))
}

pub fn node_bin_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("WEWORK_NODE_RUNTIME_ROOT").map(PathBuf::from) {
        return Ok(root.join("bin"));
    }
    Ok(node_root(app)?.join("current").join("bin"))
}

pub fn node_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(node_bin_directory(app)?.join(if cfg!(windows) { "node.exe" } else { "node" }))
}

fn resource_descriptor_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_root = app
        .path()
        .resource_dir()
        .map(|path| path.join(RESOURCE_DIRECTORY).join(NODE_DESCRIPTOR));
    #[cfg(debug_assertions)]
    {
        if let Ok(path) = &resource_root {
            if path.is_file() {
                return Ok(path.clone());
            }
        }
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(RESOURCE_DIRECTORY)
            .join(NODE_DESCRIPTOR);
        if source.is_file() {
            return Ok(source);
        }
    }
    resource_root.map_err(|error| format!("Failed to resolve Wework resources: {error}"))
}

fn read_descriptor(app: &tauri::AppHandle) -> Result<RuntimeDescriptor, String> {
    let path = resource_descriptor_path(app)?;
    let descriptor: RuntimeDescriptor = serde_json::from_slice(
        &fs::read(&path)
            .map_err(|error| format!("Failed to read Node runtime descriptor: {error}"))?,
    )
    .map_err(|error| format!("Node runtime descriptor is invalid: {error}"))?;
    if descriptor.id != "node"
        || descriptor.fingerprint.len() != 64
        || descriptor.archive_sha256.len() != 64
        || descriptor.archive_bytes == 0
        || descriptor.archive_bytes > MAX_ARCHIVE_BYTES
    {
        return Err("Node runtime descriptor has invalid identity or size".to_string());
    }
    let url = reqwest::Url::parse(descriptor.download_url.trim())
        .map_err(|error| format!("Node runtime download URL is invalid: {error}"))?;
    if url.scheme() != "https" {
        return Err("Node runtime download URL must use HTTPS".to_string());
    }
    Ok(descriptor)
}

fn read_installed_identity(app: &tauri::AppHandle) -> Option<RuntimeIdentity> {
    let path = node_root(app).ok()?.join("current").join("runtime.json");
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn installed_node_status(
    app: &tauri::AppHandle,
    descriptor: Option<&RuntimeDescriptor>,
) -> Option<RuntimeProgress> {
    if std::env::var_os("WEWORK_NODE_RUNTIME_ROOT").is_some() {
        let binary = node_binary(app).ok()?;
        let output = Command::new(&binary)
            .args(["-p", "process.versions.node"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        return Some(RuntimeProgress {
            state: "installed".to_string(),
            version: Some(String::from_utf8_lossy(&output.stdout).trim().to_string()),
            installed_bytes: fs::metadata(&binary).map_or(0, |value| value.len()),
            path: Some(binary.display().to_string()),
            ..RuntimeProgress::default()
        });
    }
    let identity = read_installed_identity(app)?;
    if identity.id != "node"
        || descriptor.is_some_and(|value| value.fingerprint != identity.fingerprint)
    {
        return None;
    }
    let binary = node_binary(app).ok()?;
    let output = Command::new(&binary)
        .args(["-p", "process.versions.node"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(RuntimeProgress {
        state: "installed".to_string(),
        version: Some(identity.version),
        installed_bytes: descriptor.map_or(0, |value| value.installed_bytes),
        path: Some(binary.display().to_string()),
        ..RuntimeProgress::default()
    })
}

fn set_progress(
    app: &tauri::AppHandle,
    state: &ExecutionEnvironmentState,
    progress: RuntimeProgress,
) {
    if let Ok(mut current) = state.progress.lock() {
        *current = progress;
    }
    let _ = app.emit(STATUS_EVENT, ());
}

fn file_sha256(path: &Path) -> Result<(String, u64), String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("Failed to open runtime archive: {error}"))?;
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read runtime archive: {error}"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        bytes += read as u64;
    }
    Ok((format!("{:x}", hash.finalize()), bytes))
}

fn download_archive(
    app: &tauri::AppHandle,
    state: &ExecutionEnvironmentState,
    descriptor: &RuntimeDescriptor,
) -> Result<PathBuf, String> {
    let archive_directory = node_root(app)?.join("archives");
    fs::create_dir_all(&archive_directory)
        .map_err(|error| format!("Failed to create runtime archive cache: {error}"))?;
    let archive_path = archive_directory.join(format!("{}.tar.gz", descriptor.archive_sha256));
    if archive_path.is_file() {
        let (checksum, bytes) = file_sha256(&archive_path)?;
        if checksum == descriptor.archive_sha256 && bytes == descriptor.archive_bytes {
            return Ok(archive_path);
        }
        fs::remove_file(&archive_path)
            .map_err(|error| format!("Failed to remove invalid runtime archive: {error}"))?;
    }

    let temporary = archive_directory.join(format!(
        ".download-{}-{}.part",
        std::process::id(),
        descriptor.archive_sha256
    ));
    let _ = fs::remove_file(&temporary);
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(10 * 60))
        .build()
        .map_err(|error| format!("Failed to prepare Node runtime download: {error}"))?;
    let mut response = client
        .get(descriptor.download_url.trim())
        .send()
        .map_err(|error| format!("Failed to download Node runtime: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Node runtime download failed: {error}"))?;
    let mut output = fs::File::create(&temporary)
        .map_err(|error| format!("Failed to create Node runtime download: {error}"))?;
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read Node runtime download: {error}"))?;
        if read == 0 {
            break;
        }
        bytes += read as u64;
        if bytes > descriptor.archive_bytes {
            return Err("Node runtime download exceeds its declared size".to_string());
        }
        hash.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("Failed to write Node runtime download: {error}"))?;
        set_progress(
            app,
            state,
            RuntimeProgress {
                state: "downloading".to_string(),
                version: Some(descriptor.version.clone()),
                downloaded_bytes: bytes,
                total_bytes: descriptor.archive_bytes,
                installed_bytes: descriptor.installed_bytes,
                ..RuntimeProgress::default()
            },
        );
    }
    output
        .sync_all()
        .map_err(|error| format!("Failed to flush Node runtime download: {error}"))?;
    if bytes != descriptor.archive_bytes
        || format!("{:x}", hash.finalize()) != descriptor.archive_sha256
    {
        let _ = fs::remove_file(&temporary);
        return Err("Node runtime download checksum or size mismatch".to_string());
    }
    fs::rename(&temporary, &archive_path)
        .map_err(|error| format!("Failed to activate Node runtime archive: {error}"))?;
    Ok(archive_path)
}

fn activate_archive(
    app: &tauri::AppHandle,
    descriptor: &RuntimeDescriptor,
    archive_path: &Path,
) -> Result<PathBuf, String> {
    let runtime_root = node_root(app)?;
    fs::create_dir_all(&runtime_root)
        .map_err(|error| format!("Failed to create Node runtime directory: {error}"))?;
    let staging = runtime_root.join(format!(
        ".install-{}-{}",
        std::process::id(),
        descriptor.fingerprint
    ));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Failed to create Node runtime staging: {error}"))?;
    let installation = (|| {
        let archive_file = fs::File::open(archive_path)
            .map_err(|error| format!("Failed to open Node runtime archive: {error}"))?;
        Archive::new(GzDecoder::new(archive_file))
            .unpack(&staging)
            .map_err(|error| format!("Failed to extract Node runtime: {error}"))?;
        let identity: RuntimeIdentity = serde_json::from_slice(
            &fs::read(staging.join("runtime.json"))
                .map_err(|error| format!("Failed to read Node runtime identity: {error}"))?,
        )
        .map_err(|error| format!("Node runtime identity is invalid: {error}"))?;
        if identity.id != "node"
            || identity.version != descriptor.version
            || identity.fingerprint != descriptor.fingerprint
        {
            return Err("Node runtime identity does not match its descriptor".to_string());
        }
        let staged_binary =
            staging
                .join("bin")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        let output = Command::new(&staged_binary)
            .args(["-e", "process.stdout.write(process.versions.node)"])
            .output()
            .map_err(|error| format!("Failed to validate Node runtime: {error}"))?;
        if !output.status.success() {
            return Err("Node runtime failed to initialize V8".to_string());
        }

        let current = runtime_root.join("current");
        let previous = runtime_root.join(".previous");
        let _ = fs::remove_dir_all(&previous);
        if current.exists() {
            fs::rename(&current, &previous)
                .map_err(|error| format!("Failed to replace the active Node runtime: {error}"))?;
        }
        if let Err(error) = fs::rename(&staging, &current) {
            if previous.exists() {
                let _ = fs::rename(&previous, &current);
            }
            return Err(format!("Failed to activate Node runtime: {error}"));
        }
        let _ = fs::remove_dir_all(&previous);
        Ok(current
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" }))
    })();
    if installation.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    installation
}

fn install_node(
    app: &tauri::AppHandle,
    state: &ExecutionEnvironmentState,
) -> Result<PathBuf, String> {
    let _guard = state
        .install
        .lock()
        .map_err(|_| "Node runtime installation lock failed".to_string())?;
    let descriptor = read_descriptor(app)?;
    if let Some(installed) = installed_node_status(app, Some(&descriptor)) {
        let path = installed
            .path
            .as_deref()
            .map(PathBuf::from)
            .ok_or_else(|| "Installed Node runtime path is missing".to_string())?;
        set_progress(app, state, installed);
        return Ok(path);
    }
    set_progress(
        app,
        state,
        RuntimeProgress {
            state: "downloading".to_string(),
            version: Some(descriptor.version.clone()),
            total_bytes: descriptor.archive_bytes,
            installed_bytes: descriptor.installed_bytes,
            ..RuntimeProgress::default()
        },
    );
    let result = download_archive(app, state, &descriptor)
        .and_then(|archive| activate_archive(app, &descriptor, &archive));
    match result {
        Ok(path) => {
            set_progress(
                app,
                state,
                RuntimeProgress {
                    state: "installed".to_string(),
                    version: Some(descriptor.version),
                    total_bytes: descriptor.archive_bytes,
                    downloaded_bytes: descriptor.archive_bytes,
                    installed_bytes: descriptor.installed_bytes,
                    path: Some(path.display().to_string()),
                    ..RuntimeProgress::default()
                },
            );
            Ok(path)
        }
        Err(error) => {
            set_progress(
                app,
                state,
                RuntimeProgress {
                    state: "error".to_string(),
                    version: Some(descriptor.version),
                    total_bytes: descriptor.archive_bytes,
                    installed_bytes: descriptor.installed_bytes,
                    error: Some(error.clone()),
                    ..RuntimeProgress::default()
                },
            );
            Err(error)
        }
    }
}

fn start_node_install(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<ExecutionEnvironmentState>();
        if let Err(error) = install_node(&app, state.inner()) {
            log::warn!("Failed to install Wework Node runtime: {error}");
        }
    });
}

pub fn setup(app: &tauri::AppHandle) {
    if std::env::var_os("WEWORK_NODE_RUNTIME_ROOT").is_some() {
        return;
    }
    start_node_install(app.clone());
}

pub fn ensure_node_runtime(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("WEWORK_NODE_RUNTIME_ROOT").map(PathBuf::from) {
        let path = root
            .join("bin")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        return path
            .is_file()
            .then_some(path)
            .ok_or_else(|| "Configured Wework Node runtime is unavailable".to_string());
    }
    let state = app.state::<ExecutionEnvironmentState>();
    install_node(app, state.inner())
}

fn python_status() -> ExecutionEnvironmentStatus {
    let candidates: &[(&str, &[&str])] = if cfg!(windows) {
        &[
            ("python.exe", &["--version"]),
            ("py.exe", &["-3", "--version"]),
        ]
    } else {
        &[("python3", &["--version"]), ("python", &["--version"])]
    };
    for (command, args) in candidates {
        if let Ok(output) = Command::new(command).args(*args).output() {
            if output.status.success() {
                let version = String::from_utf8_lossy(if output.stdout.is_empty() {
                    &output.stderr
                } else {
                    &output.stdout
                })
                .trim()
                .trim_start_matches("Python ")
                .to_string();
                return ExecutionEnvironmentStatus {
                    id: "python".to_string(),
                    managed: false,
                    auto_install: false,
                    state: "installed".to_string(),
                    version: Some(version),
                    downloaded_bytes: 0,
                    total_bytes: 0,
                    installed_bytes: 0,
                    path: Some((*command).to_string()),
                    error: None,
                };
            }
        }
    }
    ExecutionEnvironmentStatus {
        id: "python".to_string(),
        managed: false,
        auto_install: false,
        state: "notInstalled".to_string(),
        version: None,
        downloaded_bytes: 0,
        total_bytes: 0,
        installed_bytes: 0,
        path: None,
        error: None,
    }
}

fn node_status(
    app: &tauri::AppHandle,
    state: &ExecutionEnvironmentState,
) -> ExecutionEnvironmentStatus {
    let descriptor = read_descriptor(app).ok();
    if let Some(installed) = installed_node_status(app, descriptor.as_ref()) {
        return ExecutionEnvironmentStatus {
            id: "node".to_string(),
            managed: true,
            auto_install: true,
            state: installed.state,
            version: installed.version,
            downloaded_bytes: installed.downloaded_bytes,
            total_bytes: descriptor.as_ref().map_or(0, |value| value.archive_bytes),
            installed_bytes: installed.installed_bytes,
            path: installed.path,
            error: None,
        };
    }
    let progress = state
        .progress
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    ExecutionEnvironmentStatus {
        id: "node".to_string(),
        managed: true,
        auto_install: true,
        state: progress.state,
        version: progress
            .version
            .or_else(|| descriptor.as_ref().map(|value| value.version.clone())),
        downloaded_bytes: progress.downloaded_bytes,
        total_bytes: progress
            .total_bytes
            .max(descriptor.as_ref().map_or(0, |value| value.archive_bytes)),
        installed_bytes: progress
            .installed_bytes
            .max(descriptor.as_ref().map_or(0, |value| value.installed_bytes)),
        path: progress.path,
        error: progress.error,
    }
}

#[tauri::command]
pub fn list_execution_environments(
    app: tauri::AppHandle,
    state: State<'_, ExecutionEnvironmentState>,
) -> Vec<ExecutionEnvironmentStatus> {
    vec![node_status(&app, state.inner()), python_status()]
}

#[tauri::command]
pub fn install_execution_environment(
    app: tauri::AppHandle,
    state: State<'_, ExecutionEnvironmentState>,
    id: String,
) -> Result<ExecutionEnvironmentStatus, String> {
    match id.trim() {
        "node" => {
            start_node_install(app.clone());
            Ok(node_status(&app, state.inner()))
        }
        "python" => Err(
            "Install Python on this device, then refresh Wework execution environments".to_string(),
        ),
        other => Err(format!("Unsupported execution environment: {other}")),
    }
}

#[tauri::command]
pub fn remove_execution_environment(
    app: tauri::AppHandle,
    state: State<'_, ExecutionEnvironmentState>,
    id: String,
) -> Result<(), String> {
    if id.trim() != "node" {
        return Err("Only the Wework-managed Node runtime can be removed".to_string());
    }
    let _guard = state
        .install
        .lock()
        .map_err(|_| "Node runtime installation lock failed".to_string())?;
    let current = node_root(&app)?.join("current");
    if current.exists() {
        fs::remove_dir_all(&current)
            .map_err(|error| format!("Failed to remove Node runtime: {error}"))?;
    }
    set_progress(
        &app,
        state.inner(),
        RuntimeProgress {
            state: "notInstalled".to_string(),
            ..RuntimeProgress::default()
        },
    );
    Ok(())
}
