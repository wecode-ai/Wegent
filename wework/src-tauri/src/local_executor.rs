use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{async_runtime::Mutex as AsyncMutex, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::process_environment;

const LOCAL_EXECUTOR_EVENT: &str = "local-executor:event";
const LOCAL_EXECUTOR_SIDECAR: &str = "wegent-executor";
const LOCAL_EXECUTOR_SIDECAR_ENV: &str = "WEWORK_EXECUTOR_SIDECAR";
const LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV: &str = "WEWORK_EXECUTOR_ISOLATION_OVERRIDE";
const LOCAL_EXECUTOR_HOME_ENV: &str = "WEGENT_EXECUTOR_HOME";
const LOCAL_EXECUTOR_NAMESPACE: Option<&str> = option_env!("WEWORK_EXECUTOR_NAMESPACE");
const LOCAL_EXECUTOR_SHARED_HOME_ENV: &str = "WEWORK_SHARED_EXECUTOR_HOME";
const LOCAL_EXECUTOR_LOG_DIR_ENV: &str = "WEGENT_EXECUTOR_LOG_DIR";
const LOCAL_EXECUTOR_LOG_FILE_ENV: &str = "WEGENT_EXECUTOR_LOG_FILE";
const CODEX_HOME_ENV: &str = "CODEX_HOME";
const WEGENT_CODEX_HOME_ENV: &str = "WEGENT_CODEX_HOME";
const WEWORK_E2E_NATIVE_CODEX_HOME_ENV: &str = "WEWORK_E2E_NATIVE_CODEX_HOME";
const FILE_EDIT_HOOK_COMMAND_ENV: &str = "WEGENT_FILE_EDIT_HOOK_COMMAND";
const FILE_EDIT_LOG_ENDPOINT_ENV: &str = "WEWORK_FILE_EDIT_LOG_ENDPOINT";
const CODEX_BINARY_PATH_ENV: &str = "CODEX_BINARY_PATH";
const CODEX_BIN_ENV: &str = "CODEX_BIN";
const CODEX_MANAGED_PACKAGE_ROOT_ENV: &str = "CODEX_MANAGED_PACKAGE_ROOT";
const DWS_BINARY_PATH_ENV: &str = "DWS_BINARY_PATH";
const BUNDLED_HOOKS_DIR_ENV: &str = "WEGENT_BUNDLED_HOOKS_DIR";
const MANAGED_HOOKS_DIR_ENV: &str = "WEGENT_MANAGED_HOOKS_DIR";
const BUNDLED_PLUGIN_MARKETPLACE_DIR_NAME: &str = "bundled-plugins";
const WEWORK_PERSONAL_MARKETPLACE_ID: &str = "wework-personal";
const APP_IPC_DEVICE_ID_ENV: &str = "WEGENT_APP_IPC_DEVICE_ID";
const WEGENT_AUTH_TOKEN_ENV: &str = "WEGENT_AUTH_TOKEN";
const WEGENT_RUNTIME_AUTH_TOKEN_ENV: &str = "WEGENT_RUNTIME_AUTH_TOKEN";
const SESSION_GATEWAY_HOST_ENV: &str = "DEVICE_SESSION_GATEWAY_HOST";
const SESSION_GATEWAY_PORT_ENV: &str = "DEVICE_SESSION_GATEWAY_PORT";
const SESSION_GATEWAY_PUBLIC_BASE_URL_ENV: &str = "DEVICE_PUBLIC_BASE_URL";
const DEFAULT_FILE_EDIT_LOG_ENDPOINT: &str = "http://127.0.0.1:3456/api/file-edit-log";
const LOCAL_EXECUTOR_DEVICE_ID: &str = "local-device";
const LOCAL_EXECUTOR_LOG_FILE_NAME: &str = "executor.log";
const LOCAL_EXECUTOR_SIGNAL_AUDIT_FILE_NAME: &str = "wework-executor-signal-audit.log";
const LOCAL_EXECUTOR_RUNTIME_DIR_NAME: &str = "app-runtime";
const LOCAL_EXECUTOR_LOG_TAIL_BYTES: u64 = 200 * 1024;
const LOCAL_EXECUTOR_LOG_TAIL_LINES: usize = 20;
const WEWORK_HOME_DIR: &str = ".wework";
const LEGACY_EXECUTOR_HOME_DIR: &str = ".wegent-executor";
const LEGACY_WECODE_HOME_DIR: &str = ".wecode";
const LEGACY_MIGRATION_CONFLICTS_DIR: &str = ".legacy-migration-conflicts";
const LOCAL_EXECUTOR_READY_TIMEOUT_SECS: u64 = if cfg!(debug_assertions) {
    if cfg!(windows) {
        180
    } else {
        60
    }
} else {
    10
};
const LOCAL_EXECUTOR_PROCESS_GROUP_GRACE_MS: u64 = 500;
const LOCAL_EXECUTOR_PROCESS_GROUP_POLL_MS: u64 = 20;
const LOCAL_EXECUTOR_REQUEST_TIMEOUT_SECONDS: u64 = 60;
const MAX_PLUGIN_PACKAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_PLUGIN_EXPANDED_BYTES: u64 = 200 * 1024 * 1024;
const PLUGIN_MUTATION_LOCK_FILE: &str = "plugin-mutations.lock";

type PendingSender = mpsc::Sender<Result<Value, String>>;
type SharedExecutorInner = Arc<Mutex<LocalExecutorInner>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginPackage {
    name: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsurePersonalPluginOptions {
    source_marketplace_path: String,
    destination_marketplace_path: String,
    plugin_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsurePersonalPluginResult {
    plugin_name: String,
    marketplace_path: String,
    plugin_path: String,
    migrated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginCopyImportOptions {
    marketplace_path: String,
    download_url: String,
    sha256: String,
    source_plugin_id: i64,
    source_release_id: i64,
    source_plugin_name: String,
    source_display_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginCopyImportResult {
    plugin_name: String,
    display_name: String,
    version: String,
    marketplace_path: String,
    plugin_path: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalPluginCopyRegistry {
    #[serde(default)]
    copies: Vec<LocalPluginCopyRecord>,
    #[serde(default)]
    cloud_links: Vec<LocalPluginCloudLink>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPluginCopyRecord {
    local_plugin_name: String,
    source_plugin_id: i64,
    source_release_id: i64,
    source_plugin_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPluginCloudLink {
    local_plugin_name: String,
    cloud_plugin_id: i64,
    cloud_release_id: i64,
}

pub struct LocalExecutorState {
    inner: SharedExecutorInner,
    next_id: Arc<AtomicU64>,
    start_lock: Arc<AsyncMutex<()>>,
    backend_connection_lock: Arc<AsyncMutex<()>>,
    bundled_plugin_marketplace: Arc<AsyncMutex<Option<BundledPluginMarketplace>>>,
}

impl Clone for LocalExecutorState {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            next_id: self.next_id.clone(),
            start_lock: self.start_lock.clone(),
            backend_connection_lock: self.backend_connection_lock.clone(),
            bundled_plugin_marketplace: self.bundled_plugin_marketplace.clone(),
        }
    }
}

#[derive(Default)]
struct LocalExecutorInner {
    child: Option<LocalExecutorChild>,
    pending: HashMap<String, PendingSender>,
    backend_connection: Option<LocalExecutorBackendConnection>,
    running: bool,
    ready: bool,
    device_id: Option<String>,
    runtime_instance_id: Option<String>,
    version: Option<String>,
    error: Option<String>,
    codex_initialize_elapsed_ms: Option<u64>,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalExecutorBackendConnection {
    backend_url: String,
    socket_url: String,
    auth_token: String,
    runtime_auth_token: Option<String>,
}

enum LocalExecutorChild {
    Tauri(CommandChild),
    Process(ManagedProcessChild),
}

struct ManagedProcessChild {
    child: Child,
    #[cfg(unix)]
    process_group_id: u32,
}

#[derive(Clone, Copy)]
enum LocalExecutorOutputStream {
    Stderr,
}

impl LocalExecutorOutputStream {
    fn log_label(self) -> &'static str {
        match self {
            Self::Stderr => "Local executor diagnostic",
        }
    }

    fn log_line(self, line: &str) {
        log::info!("{}: {}", self.log_label(), line);
    }
}

impl LocalExecutorChild {
    fn is_running(&mut self) -> bool {
        match self {
            LocalExecutorChild::Tauri(_) => true,
            LocalExecutorChild::Process(child) => child.is_running(),
        }
    }

    fn kill(self) {
        match self {
            LocalExecutorChild::Tauri(child) => {
                let child_pid = child.pid();
                audit_local_executor_signal(format!(
                    "event=child_kill_requested sender_pid={} target_pid={} child_kind=tauri signal=SIGKILL",
                    std::process::id(), child_pid
                ));
                if let Err(error) = child.kill() {
                    audit_local_executor_signal(format!(
                        "event=child_kill_failed sender_pid={} target_pid={} child_kind=tauri error={error}",
                        std::process::id(), child_pid
                    ));
                }
            }
            LocalExecutorChild::Process(child) => child.kill(),
        }
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        match self {
            LocalExecutorChild::Tauri(child) => child
                .write(bytes)
                .map_err(|error| format!("Failed to write local executor stdin: {error}")),
            LocalExecutorChild::Process(child) => child.write(bytes),
        }
    }
}

impl ManagedProcessChild {
    fn new(child: Child) -> Self {
        #[cfg(unix)]
        {
            let process_group_id = child.id();
            Self {
                child,
                process_group_id,
            }
        }
        #[cfg(not(unix))]
        {
            Self { child }
        }
    }

    fn is_running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| "Local executor stdin is unavailable".to_string())?;
        stdin
            .write_all(bytes)
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("Failed to write local executor stdin: {error}"))
    }

    fn kill(mut self) {
        #[cfg(unix)]
        {
            audit_local_executor_signal(format!(
                "event=process_group_kill_requested sender_pid={} target_pid={} target_pgid={}",
                std::process::id(),
                self.child.id(),
                self.process_group_id
            ));
            terminate_process_group(self.process_group_id);
            let _ = self.child.wait();
        }

        #[cfg(not(unix))]
        {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(unix)]
fn configure_managed_process_group(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_managed_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(process_group_id: u32) {
    audit_local_executor_signal(format!(
        "event=process_group_termination_started sender_pid={} target_pgid={process_group_id}",
        std::process::id()
    ));
    send_process_group_signal(process_group_id, libc::SIGTERM);
    wait_for_process_group_exit(
        process_group_id,
        Duration::from_millis(LOCAL_EXECUTOR_PROCESS_GROUP_GRACE_MS),
    );
    send_process_group_signal(process_group_id, libc::SIGKILL);
    audit_local_executor_signal(format!(
        "event=process_group_termination_finished sender_pid={} target_pgid={process_group_id}",
        std::process::id()
    ));
}

#[cfg(unix)]
fn wait_for_process_group_exit(process_group_id: u32, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !process_group_exists(process_group_id) {
            return;
        }
        thread::sleep(Duration::from_millis(LOCAL_EXECUTOR_PROCESS_GROUP_POLL_MS));
    }
}

#[cfg(unix)]
fn process_group_exists(process_group_id: u32) -> bool {
    let result = unsafe { libc::kill(-(process_group_id as libc::pid_t), 0) };
    log::debug!(
        "Tauri process-group signal probe: sender_pid={}, target_pgid={process_group_id}, signal=0, result={result}",
        std::process::id()
    );
    result == 0
}

#[cfg(unix)]
fn send_process_group_signal(process_group_id: u32, signal: libc::c_int) {
    let result = unsafe { libc::kill(-(process_group_id as libc::pid_t), signal) };
    let error = (result != 0).then(std::io::Error::last_os_error);
    audit_local_executor_signal(format!(
        "event=process_group_signal_sent sender_pid={} target_pgid={process_group_id} signal={signal} result={result} error={error:?}",
        std::process::id()
    ));
}

impl Default for LocalExecutorState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(LocalExecutorInner::default())),
            next_id: Arc::new(AtomicU64::new(1)),
            start_lock: Arc::new(AsyncMutex::new(())),
            backend_connection_lock: Arc::new(AsyncMutex::new(())),
            bundled_plugin_marketplace: Arc::new(AsyncMutex::new(None)),
        }
    }
}

pub fn shutdown_local_executor(state: &LocalExecutorState, reason: &str) {
    audit_local_executor_signal(format!(
        "event=executor_shutdown_entered sender_pid={} reason={reason}",
        std::process::id()
    ));
    let child = state.inner.lock().ok().and_then(|mut inner| {
        inner.running = false;
        inner.ready = false;
        inner.generation = inner.generation.saturating_add(1);
        inner.error = Some("Local executor stopped".to_string());
        inner.child.take()
    });

    if let Some(child) = child {
        child.kill();
    } else {
        audit_local_executor_signal(format!(
            "event=executor_shutdown_no_owned_child sender_pid={} reason={reason}",
            std::process::id()
        ));
    }

    fail_pending_requests_inner(&state.inner, "Local executor stopped".to_string());
    audit_local_executor_signal(format!(
        "event=executor_shutdown_finished sender_pid={} reason={reason}",
        std::process::id()
    ));
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ExecutorLine {
    #[serde(rename = "response")]
    Response(ExecutorResponse),
    #[serde(rename = "event")]
    Event(ExecutorEvent),
}

#[derive(Debug, Deserialize)]
pub struct ExecutorResponse {
    pub id: String,
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<ExecutorError>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExecutorEvent {
    pub event: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ExecutorError {
    pub code: String,
    pub message: String,
}

#[derive(Deserialize)]
pub struct LocalExecutorRequest {
    method: String,
    params: Value,
}

#[derive(Serialize)]
pub struct LocalExecutorStatus {
    running: bool,
    ready: bool,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: Option<String>,
    #[serde(rename = "codexInitializeElapsedMs")]
    codex_initialize_elapsed_ms: Option<u64>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalExecutorLog {
    path: String,
    content: String,
    truncated: bool,
    line_count: usize,
    transport: String,
    transport_connected: bool,
    process_pids: Vec<u32>,
    process_paths: Vec<String>,
    sidecar_source: String,
    sidecar_path: String,
    current_dir: String,
    executor_home: String,
    backend_url: Option<String>,
    socket_url: Option<String>,
    has_backend_auth_token: bool,
    pending_request_count: usize,
    status: LocalExecutorStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHomeMigrationStatus {
    wework_codex_home: String,
    native_codex_home: String,
    wework_codex_home_exists: bool,
    native_codex_home_exists: bool,
    should_prompt_migration: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHomeInitializeOptions {
    migrate_native_home: bool,
    #[serde(default = "default_remote_apps_enabled")]
    remote_apps_enabled: bool,
}

fn default_remote_apps_enabled() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalContentImportOptions {
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalContentImportResult {
    source: String,
    source_path: String,
    destination_path: String,
    imported_entries: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLocalConfigPatch {
    remote_apps_enabled: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLocalConfig {
    codex_home: String,
    config_path: String,
    remote_apps_enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledPluginMarketplace {
    id: String,
    path: String,
    plugin_count: usize,
}

struct LocalExecutorLogTail {
    path: String,
    content: String,
    truncated: bool,
    line_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalExecutorProcessInfo {
    pid: u32,
    path: String,
}

pub fn parse_executor_line(line: &str) -> Result<ExecutorLine, String> {
    serde_json::from_str::<ExecutorLine>(line).map_err(|error| error.to_string())
}

fn next_request_id(state: &LocalExecutorState) -> String {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    format!("local-req-{id}")
}

fn local_executor_instance_name() -> &'static str {
    static INSTANCE_NAME: OnceLock<String> = OnceLock::new();
    INSTANCE_NAME.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        format!("wework-{}-{nanos}", std::process::id())
    })
}

fn local_executor_runtime_dir_path() -> Result<PathBuf, String> {
    if let Some((_, instance)) = isolated_runtime_instance_paths()? {
        return Ok(instance);
    }

    local_executor_home_path()
}

pub(crate) fn isolated_runtime_instance_paths() -> Result<Option<(PathBuf, PathBuf)>, String> {
    if !local_executor_isolation_enabled()? {
        return Ok(None);
    }

    let root = local_executor_home_path()?.join(LOCAL_EXECUTOR_RUNTIME_DIR_NAME);
    let instance = root.join(local_executor_instance_name());
    Ok(Some((root, instance)))
}

fn local_executor_runtime_home_path() -> Result<PathBuf, String> {
    local_executor_runtime_dir_path()
}

fn local_executor_isolation_enabled() -> Result<bool, String> {
    if let Ok(value) = std::env::var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV) {
        return match value.trim() {
            "" => Ok(cfg!(debug_assertions)),
            "true" => Ok(true),
            "false" => Ok(false),
            value => Err(format!(
                "{LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV} must be true or false, got {value:?}"
            )),
        };
    }

    Ok(cfg!(debug_assertions)
        && std::env::var(LOCAL_EXECUTOR_SHARED_HOME_ENV)
            .map(|value| value.trim() != "1")
            .unwrap_or(true))
}

pub(crate) fn local_executor_home_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(LOCAL_EXECUTOR_HOME_ENV) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    migrate_legacy_executor_homes(&home)?;
    Ok(default_local_executor_home_path(
        &home,
        LOCAL_EXECUTOR_NAMESPACE,
    ))
}

fn default_local_executor_home_path(home: &Path, namespace: Option<&str>) -> PathBuf {
    let root = home.join(WEWORK_HOME_DIR);
    namespace
        .filter(|value| !value.is_empty())
        .map_or(root.clone(), |value| root.join("apps").join(value))
}

pub(crate) fn migrate_legacy_executor_homes(home: &Path) -> Result<(), String> {
    let destination = home.join(WEWORK_HOME_DIR);
    for (source, label) in [
        (
            home.join(LEGACY_EXECUTOR_HOME_DIR),
            LEGACY_EXECUTOR_HOME_DIR,
        ),
        (
            home.join(LEGACY_WECODE_HOME_DIR)
                .join(LEGACY_EXECUTOR_HOME_DIR),
            "wecode-wegent-executor",
        ),
    ] {
        migrate_legacy_executor_home(&source, &destination, label)?;
    }
    Ok(())
}

fn migrate_legacy_executor_home(
    source: &Path,
    destination: &Path,
    legacy_label: &str,
) -> Result<(), String> {
    let source_metadata = match fs::symlink_metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect legacy Wework directory {}: {error}",
                source.display()
            ));
        }
    };
    let source_is_symlink = source_metadata.file_type().is_symlink();
    if !source.is_dir() {
        log::warn!(
            "Skipping legacy Wework migration because {} is not a directory",
            source.display()
        );
        return Ok(());
    }

    match fs::symlink_metadata(destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !source_is_symlink {
                fs::rename(source, destination).map_err(|error| {
                    format!(
                        "Failed to migrate {} to {}: {error}",
                        source.display(),
                        destination.display()
                    )
                })?;
                log::info!(
                    "Migrated legacy Wework directory {} to {}",
                    source.display(),
                    destination.display()
                );
                return Ok(());
            }

            fs::create_dir_all(destination)
                .map_err(|error| format!("Failed to create {}: {error}", destination.display()))?;
            merge_legacy_executor_directory(
                source,
                destination,
                &destination
                    .join(LEGACY_MIGRATION_CONFLICTS_DIR)
                    .join(legacy_label),
            )?;
            remove_empty_legacy_executor_home(source, source_is_symlink)?;
            log::info!(
                "Migrated linked legacy Wework directory {} to {}",
                source.display(),
                destination.display()
            );
            return Ok(());
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(format!(
                "Wework home is not a directory: {}",
                destination.display()
            ));
        }
        Ok(_) => {}
        Err(error) => {
            return Err(format!(
                "Failed to inspect Wework home {}: {error}",
                destination.display()
            ));
        }
    }

    merge_legacy_executor_directory(
        source,
        destination,
        &destination
            .join(LEGACY_MIGRATION_CONFLICTS_DIR)
            .join(legacy_label),
    )?;
    remove_empty_legacy_executor_home(source, source_is_symlink)?;
    Ok(())
}

fn remove_empty_legacy_executor_home(source: &Path, source_is_symlink: bool) -> Result<(), String> {
    if fs::read_dir(source)
        .map_err(|error| format!("Failed to read {}: {error}", source.display()))?
        .next()
        .is_some()
    {
        return Ok(());
    }

    if source_is_symlink {
        fs::remove_file(source)
    } else {
        fs::remove_dir(source)
    }
    .map_err(|error| format!("Failed to remove {}: {error}", source.display()))
}

fn merge_legacy_executor_directory(
    source: &Path,
    destination: &Path,
    conflict_destination: &Path,
) -> Result<(), String> {
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Failed to read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        match fs::symlink_metadata(&destination_path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::rename(&source_path, &destination_path).map_err(|error| {
                    format!(
                        "Failed to migrate {} to {}: {error}",
                        source_path.display(),
                        destination_path.display()
                    )
                })?;
            }
            Ok(destination_metadata)
                if entry
                    .file_type()
                    .map_err(|error| {
                        format!("Failed to inspect {}: {error}", source_path.display())
                    })?
                    .is_dir()
                    && destination_metadata.is_dir() =>
            {
                merge_legacy_executor_directory(
                    &source_path,
                    &destination_path,
                    &conflict_destination.join(entry.file_name()),
                )?;
                if fs::read_dir(&source_path)
                    .map_err(|error| format!("Failed to read {}: {error}", source_path.display()))?
                    .next()
                    .is_none()
                {
                    fs::remove_dir(&source_path).map_err(|error| {
                        format!("Failed to remove {}: {error}", source_path.display())
                    })?;
                }
            }
            Ok(_) => {
                fs::create_dir_all(conflict_destination).map_err(|error| {
                    format!(
                        "Failed to create {}: {error}",
                        conflict_destination.display()
                    )
                })?;
                let conflict_path = conflict_destination.join(entry.file_name());
                fs::rename(&source_path, &conflict_path).map_err(|error| {
                    format!(
                        "Failed to preserve conflicting legacy Wework entry {} at {}: {error}",
                        source_path.display(),
                        conflict_path.display()
                    )
                })?;
                log::warn!(
                    "Preserved conflicting legacy Wework entry {} at {} because {} already exists",
                    source_path.display(),
                    conflict_path.display(),
                    destination_path.display(),
                );
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect Wework migration destination {}: {error}",
                    destination_path.display()
                ));
            }
        }
    }
    Ok(())
}

fn local_executor_log_path() -> Result<PathBuf, String> {
    let log_dir = local_executor_log_dir_path()?;
    let log_file = std::env::var(LOCAL_EXECUTOR_LOG_FILE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| LOCAL_EXECUTOR_LOG_FILE_NAME.to_string());

    Ok(log_dir.join(log_file))
}

pub(crate) fn local_executor_log_dir_path() -> Result<PathBuf, String> {
    std::env::var(LOCAL_EXECUTOR_LOG_DIR_ENV)
        .ok()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| local_executor_runtime_dir_path().map(|path| path.join("logs")))
}

fn audit_local_executor_signal(message: String) {
    log::warn!("Tauri local executor signal audit: {message}");

    let Ok(log_dir) = local_executor_log_dir_path() else {
        return;
    };
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }

    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let audit_path = log_dir.join(LOCAL_EXECUTOR_SIGNAL_AUDIT_FILE_NAME);
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_path)
    {
        let _ = writeln!(file, "timestamp_ms={timestamp_ms} {message}");
    }
}

fn read_local_executor_log_tail(
    path: &Path,
    max_bytes: u64,
) -> Result<LocalExecutorLogTail, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open local executor log: {error}"))?;
    let len = file
        .metadata()
        .map_err(|error| format!("Failed to inspect local executor log: {error}"))?
        .len();
    let byte_truncated = len > max_bytes;
    let offset = if byte_truncated { len - max_bytes } else { 0 };
    let starts_on_line_boundary = if offset == 0 {
        true
    } else {
        file.seek(SeekFrom::Start(offset - 1))
            .map_err(|error| format!("Failed to seek local executor log: {error}"))?;
        let mut previous = [0_u8; 1];
        file.read_exact(&mut previous)
            .map_err(|error| format!("Failed to read local executor log: {error}"))?;
        previous[0] == b'\n'
    };
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Failed to seek local executor log: {error}"))?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read local executor log: {error}"))?;
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if byte_truncated && !starts_on_line_boundary {
        if let Some(index) = content.find('\n') {
            content = content[index + 1..].to_string();
        }
    }
    let (content, line_truncated, line_count) =
        limit_log_lines(&content, LOCAL_EXECUTOR_LOG_TAIL_LINES);

    Ok(LocalExecutorLogTail {
        path: path.display().to_string(),
        content,
        truncated: byte_truncated || line_truncated,
        line_count,
    })
}

fn limit_log_lines(content: &str, max_lines: usize) -> (String, bool, usize) {
    let has_trailing_newline = content.ends_with('\n');
    let lines = content.lines().collect::<Vec<_>>();
    let line_count = lines.len();
    let line_truncated = line_count > max_lines;
    let kept = if line_truncated {
        &lines[line_count - max_lines..]
    } else {
        &lines[..]
    };
    let mut content = kept.join("\n");
    if has_trailing_newline && !content.is_empty() {
        content.push('\n');
    }

    (content, line_truncated, kept.len())
}

fn parse_executor_processes(output: &str) -> Vec<LocalExecutorProcessInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<u32>().ok()?;
            let executable = parts.next()?;
            let file_name = Path::new(executable)
                .file_name()
                .and_then(|name| name.to_str())?;
            if file_name != "wegent-executor" {
                return None;
            }
            Some(LocalExecutorProcessInfo {
                pid,
                path: executable.to_string(),
            })
        })
        .collect()
}

#[cfg(unix)]
fn local_executor_processes() -> Vec<LocalExecutorProcessInfo> {
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_executor_processes(&stdout)
}

#[cfg(not(unix))]
fn local_executor_processes() -> Vec<LocalExecutorProcessInfo> {
    Vec::new()
}

fn sidecar_source_and_path() -> (String, String) {
    if let Some(path) = configured_sidecar_path() {
        return ("configured".to_string(), path.display().to_string());
    }

    ("bundled".to_string(), LOCAL_EXECUTOR_SIDECAR.to_string())
}

fn path_or_error(result: Result<PathBuf, String>) -> String {
    result
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("unavailable: {error}"))
}

#[cfg(target_os = "macos")]
fn write_text_to_native_clipboard(text: &str) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let text = NSString::from_str(text);
    let string_type = unsafe { NSPasteboardTypeString };
    if pasteboard.setString_forType(&text, string_type) {
        Ok(())
    } else {
        Err("Failed to write text to the macOS pasteboard".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn write_text_to_native_clipboard(_text: &str) -> Result<(), String> {
    Err("Native clipboard copy is only available in the desktop macOS app".to_string())
}

fn configured_sidecar_path() -> Option<PathBuf> {
    std::env::var_os(LOCAL_EXECUTOR_SIDECAR_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn status_from_inner(inner: &LocalExecutorInner) -> LocalExecutorStatus {
    LocalExecutorStatus {
        running: inner.running,
        ready: inner.ready,
        device_id: inner.device_id.clone(),
        runtime_instance_id: inner.runtime_instance_id.clone(),
        codex_initialize_elapsed_ms: inner.codex_initialize_elapsed_ms,
        version: inner.version.clone(),
        error: inner.error.clone(),
    }
}

fn status_from_state(state: &LocalExecutorState) -> Result<LocalExecutorStatus, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?;
    Ok(status_from_inner(&inner))
}

fn normalize_command_arg(value: String, name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{name} must not be empty"))
    } else {
        Ok(trimmed.to_string())
    }
}

fn normalize_optional_command_arg(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn default_file_edit_hook_command() -> String {
    let endpoint = non_empty_env(FILE_EDIT_LOG_ENDPOINT_ENV)
        .unwrap_or_else(|| DEFAULT_FILE_EDIT_LOG_ENDPOINT.to_string());
    format!("curl -s -X POST {endpoint} -H \"Content-Type: application/json\" -d @-")
}

fn configured_file_edit_hook_command() -> String {
    non_empty_env(FILE_EDIT_HOOK_COMMAND_ENV).unwrap_or_else(default_file_edit_hook_command)
}

fn local_executor_backend_env(inner: &LocalExecutorInner) -> Vec<(String, String)> {
    let executor_home = path_or_error(local_executor_runtime_home_path());
    let codex_home = path_or_error(wework_codex_home_path(&executor_home));
    let log_dir = path_or_error(local_executor_log_dir_path());
    let app_ipc_device_id = inner
        .device_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(LOCAL_EXECUTOR_DEVICE_ID)
        .to_string();
    let mut envs = vec![
        (LOCAL_EXECUTOR_HOME_ENV.to_string(), executor_home),
        (CODEX_HOME_ENV.to_string(), codex_home),
        (LOCAL_EXECUTOR_LOG_DIR_ENV.to_string(), log_dir),
        (APP_IPC_DEVICE_ID_ENV.to_string(), app_ipc_device_id.clone()),
        ("DEVICE_ID".to_string(), app_ipc_device_id.clone()),
        (
            "DEVICE_NAME".to_string(),
            format!("{app_ipc_device_id} app"),
        ),
        ("DEVICE_TYPE".to_string(), "app".to_string()),
        ("BIND_SHELL".to_string(), "claudecode".to_string()),
        (
            SESSION_GATEWAY_HOST_ENV.to_string(),
            "127.0.0.1".to_string(),
        ),
        (SESSION_GATEWAY_PORT_ENV.to_string(), "0".to_string()),
        (
            SESSION_GATEWAY_PUBLIC_BASE_URL_ENV.to_string(),
            String::new(),
        ),
        (
            "PATH".to_string(),
            process_environment::normalized_current_path(),
        ),
        (
            FILE_EDIT_HOOK_COMMAND_ENV.to_string(),
            configured_file_edit_hook_command(),
        ),
    ];
    if let Some(log_file) = non_empty_env(LOCAL_EXECUTOR_LOG_FILE_ENV) {
        envs.push((LOCAL_EXECUTOR_LOG_FILE_ENV.to_string(), log_file));
    }
    let Some(connection) = &inner.backend_connection else {
        return envs;
    };

    envs.extend([
        (
            "WEGENT_BACKEND_URL".to_string(),
            connection.backend_url.clone(),
        ),
        (
            "WEGENT_SOCKET_URL".to_string(),
            connection.socket_url.clone(),
        ),
        (
            WEGENT_AUTH_TOKEN_ENV.to_string(),
            connection.auth_token.clone(),
        ),
    ]);
    envs
}

fn wework_codex_home_path(executor_home: &str) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(WEGENT_CODEX_HOME_ENV) {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    Ok(PathBuf::from(executor_home).join("codex"))
}

fn native_codex_home_path() -> Result<PathBuf, String> {
    if std::env::var("VITE_WEWORK_E2E").as_deref() == Ok("true") {
        if let Some(path) = non_empty_env(WEWORK_E2E_NATIVE_CODEX_HOME_ENV) {
            return Ok(PathBuf::from(path));
        }
    }
    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    Ok(home.join(".codex"))
}

fn link_native_codex_auth(
    native_codex_home: &Path,
    wework_codex_home: &Path,
) -> Result<(), String> {
    let source = native_codex_home.join("auth.json");
    let target = wework_codex_home.join("auth.json");
    if source == target || !source.is_file() {
        return Ok(());
    }

    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() && !target.exists() {
            fs::remove_file(&target).map_err(|error| {
                format!(
                    "failed to remove stale Codex auth link {}: {error}",
                    target.display()
                )
            })?;
        } else {
            return Ok(());
        }
    }

    fs::create_dir_all(wework_codex_home)
        .map_err(|error| format!("failed to create {}: {error}", wework_codex_home.display()))?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&source, &target).map_err(|error| {
        format!(
            "failed to link Codex auth {} -> {}: {error}",
            target.display(),
            source.display()
        )
    })?;
    #[cfg(not(unix))]
    fs::copy(&source, &target).map_err(|error| {
        format!(
            "failed to copy Codex auth {} to {}: {error}",
            source.display(),
            target.display()
        )
    })?;
    Ok(())
}

fn prepare_local_executor_codex_auth(envs: &[(String, String)]) -> Result<(), String> {
    let Some(codex_home) = envs
        .iter()
        .find_map(|(key, value)| (key == CODEX_HOME_ENV).then_some(PathBuf::from(value)))
    else {
        return Ok(());
    };
    link_native_codex_auth(&native_codex_home_path()?, &codex_home)
}

fn codex_home_migration_status() -> Result<CodexHomeMigrationStatus, String> {
    let executor_home = local_executor_home_path()?;
    let wework_codex_home = wework_codex_home_path(&executor_home.display().to_string())?;
    let wework_codex_config = wework_codex_home.join("config.toml");
    let native_codex_home = native_codex_home_path()?;
    let wework_codex_home_exists = wework_codex_home.exists();
    let wework_codex_config_exists = wework_codex_config.exists();
    let native_codex_home_exists = native_codex_home.exists();
    Ok(CodexHomeMigrationStatus {
        wework_codex_home: wework_codex_home.display().to_string(),
        native_codex_home: native_codex_home.display().to_string(),
        wework_codex_home_exists,
        native_codex_home_exists,
        should_prompt_migration: !wework_codex_config_exists && native_codex_home_exists,
    })
}

fn wework_codex_config_path() -> Result<(PathBuf, PathBuf), String> {
    let executor_home = local_executor_home_path()?;
    let codex_home = wework_codex_home_path(&executor_home.display().to_string())?;
    let config_path = codex_home.join("config.toml");
    Ok((codex_home, config_path))
}

fn read_remote_apps_enabled_from_config(content: &str) -> bool {
    let mut in_features = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_features = trimmed == "[features]";
            continue;
        }
        if !in_features || trimmed.starts_with('#') {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix("apps") else {
            continue;
        };
        if !rest.trim_start().starts_with('=') {
            continue;
        }
        return rest
            .trim_start()
            .trim_start_matches('=')
            .trim()
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            == "true";
    }
    false
}

fn read_codex_local_config() -> Result<CodexLocalConfig, String> {
    let (codex_home, config_path) = wework_codex_config_path()?;
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    Ok(CodexLocalConfig {
        codex_home: codex_home.display().to_string(),
        config_path: config_path.display().to_string(),
        remote_apps_enabled: read_remote_apps_enabled_from_config(&content),
    })
}

fn set_remote_apps_enabled_in_config(content: &str, enabled: bool) -> String {
    let apps_line = format!("apps = {enabled}");
    let mut lines = content.lines().map(str::to_string).collect::<Vec<_>>();
    let mut features_start = None;
    let mut features_end = lines.len();

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if features_start.is_some() {
                features_end = index;
                break;
            }
            if trimmed == "[features]" {
                features_start = Some(index);
            }
        }
    }

    if let Some(start) = features_start {
        for line in lines.iter_mut().take(features_end).skip(start + 1) {
            let trimmed = line.trim_start();
            let Some(rest) = trimmed.strip_prefix("apps") else {
                continue;
            };
            if rest.trim_start().starts_with('=') {
                let indent_len = line.len() - trimmed.len();
                *line = format!("{}{}", " ".repeat(indent_len), apps_line);
                return format!("{}\n", lines.join("\n"));
            }
        }
        lines.insert(start + 1, apps_line);
        return format!("{}\n", lines.join("\n"));
    }

    let mut next = content.trim_end().to_string();
    if !next.is_empty() {
        next.push_str("\n\n");
    }
    next.push_str("[features]\n");
    next.push_str(&apps_line);
    next.push('\n');
    next
}

fn toml_basic_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0C}' => output.push_str("\\f"),
            character if character.is_control() => {
                output.push_str(&format!("\\u{:04X}", character as u32));
            }
            character => output.push(character),
        }
    }
    output.push('"');
    output
}

fn set_shell_environment_value_in_config(content: &str, key: &str, value: Option<&str>) -> String {
    let mut lines = content.lines().map(str::to_string).collect::<Vec<_>>();
    let mut section_start = None;
    let mut section_end = lines.len();

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if section_start.is_some() {
                section_end = index;
                break;
            }
            if trimmed == "[shell_environment_policy.set]" {
                section_start = Some(index);
            }
        }
    }

    if let Some(start) = section_start {
        for index in (start + 1)..section_end {
            let trimmed = lines[index].trim_start();
            let Some(rest) = trimmed.strip_prefix(key) else {
                continue;
            };
            if !rest.trim_start().starts_with('=') {
                continue;
            }

            if let Some(value) = value {
                let indent_len = lines[index].len() - trimmed.len();
                lines[index] = format!(
                    "{}{} = {}",
                    " ".repeat(indent_len),
                    key,
                    toml_basic_string(value)
                );
            } else {
                lines.remove(index);
            }
            return format!("{}\n", lines.join("\n"));
        }

        if let Some(value) = value {
            lines.insert(start + 1, format!("{key} = {}", toml_basic_string(value)));
            return format!("{}\n", lines.join("\n"));
        }
        return content.to_string();
    }

    let Some(value) = value else {
        return content.to_string();
    };
    let mut next = content.trim_end().to_string();
    if !next.is_empty() {
        next.push_str("\n\n");
    }
    next.push_str("[shell_environment_policy.set]\n");
    next.push_str(&format!("{key} = {}\n", toml_basic_string(value)));
    next
}

fn write_codex_shell_environment_value(
    key: &str,
    value: Option<&str>,
) -> Result<CodexLocalConfig, String> {
    let (codex_home, config_path) = wework_codex_config_path()?;
    fs::create_dir_all(&codex_home)
        .map_err(|error| format!("failed to create {}: {error}", codex_home.display()))?;
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    let next_content = set_shell_environment_value_in_config(&content, key, value);
    if next_content != content {
        fs::write(&config_path, next_content)
            .map_err(|error| format!("failed to write {}: {error}", config_path.display()))?;
    }
    read_codex_local_config()
}

fn snapshot_codex_shell_environment_config() -> Result<(PathBuf, bool, String), String> {
    let (_, config_path) = wework_codex_config_path()?;
    let existed = config_path.exists();
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    Ok((config_path, existed, content))
}

fn restore_codex_shell_environment_config(
    config_path: &Path,
    existed: bool,
    content: &str,
) -> Result<(), String> {
    if existed {
        fs::write(config_path, content)
            .map_err(|error| format!("failed to restore {}: {error}", config_path.display()))?;
    } else if config_path.exists() {
        fs::remove_file(config_path)
            .map_err(|error| format!("failed to remove {}: {error}", config_path.display()))?;
    }
    Ok(())
}

fn write_codex_remote_apps_enabled(enabled: bool) -> Result<CodexLocalConfig, String> {
    let (codex_home, config_path) = wework_codex_config_path()?;
    fs::create_dir_all(&codex_home)
        .map_err(|error| format!("failed to create {}: {error}", codex_home.display()))?;
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    let next_content = set_remote_apps_enabled_in_config(&content, enabled);
    fs::write(&config_path, next_content)
        .map_err(|error| format!("failed to write {}: {error}", config_path.display()))?;
    read_codex_local_config()
}

fn copy_codex_initialization_entry(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    if destination.exists() {
        if let (Ok(source_path), Ok(destination_path)) =
            (fs::canonicalize(source), fs::canonicalize(destination))
        {
            if source_path == destination_path {
                return Ok(());
            }
        }
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("failed to inspect {}: {error}", source.display()))?;
    if metadata.is_dir() {
        copy_directory_recursive(source, destination)
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        fs::copy(source, destination).map_err(|error| {
            format!(
                "failed to copy {} to {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
        Ok(())
    } else {
        Ok(())
    }
}

fn copy_codex_initialization_files(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;

    let entries = [
        "config.toml",
        "auth.json",
        "AGENTS.md",
        "models_cache.json",
        "plugins",
        "skills",
        "cache",
        "vendor_imports",
    ];
    for entry in entries {
        let source_path = source.join(entry);
        let destination_path = destination.join(entry);
        log::info!(
            "Codex home initialization copying entry: source={}, destination={}",
            source_path.display(),
            destination_path.display()
        );
        copy_codex_initialization_entry(&source_path, &destination_path)?;
    }
    Ok(())
}

fn import_external_content(source: &str) -> Result<ExternalContentImportResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    let executor_home = local_executor_home_path()?;
    let destination = wework_codex_home_path(&executor_home.display().to_string())?;
    import_external_content_from_paths(source, &home, &destination)
}

fn import_external_content_from_paths(
    source: &str,
    home: &Path,
    destination: &Path,
) -> Result<ExternalContentImportResult, String> {
    let (source_path, entries): (PathBuf, Vec<(&str, &str)>) = match source {
        "codex" => (
            home.join(".codex"),
            vec![
                ("config.toml", "config.toml"),
                ("auth.json", "auth.json"),
                ("AGENTS.md", "AGENTS.md"),
                ("models_cache.json", "models_cache.json"),
                ("plugins", "plugins"),
                ("skills", "skills"),
                ("cache", "cache"),
                ("vendor_imports", "vendor_imports"),
            ],
        ),
        "claude-code" => (
            home.join(".claude"),
            vec![("CLAUDE.md", "AGENTS.md"), ("skills", "skills")],
        ),
        _ => return Err(format!("Unsupported import source: {source}")),
    };
    if !source_path.is_dir() {
        return Err(format!(
            "Import source does not exist: {}",
            source_path.display()
        ));
    }

    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    let mut imported_entries = Vec::new();
    for (source_entry, destination_entry) in entries {
        let entry_path = source_path.join(source_entry);
        if !entry_path.exists() {
            continue;
        }
        copy_codex_initialization_entry(&entry_path, &destination.join(destination_entry))?;
        imported_entries.push(source_entry.to_string());
    }
    if imported_entries.is_empty() {
        return Err(format!(
            "No supported content was found in {}",
            source_path.display()
        ));
    }
    Ok(ExternalContentImportResult {
        source: source.to_string(),
        source_path: source_path.display().to_string(),
        destination_path: destination.display().to_string(),
        imported_entries,
    })
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("failed to read {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", source_path.display()))?;
        if file_type.is_dir() {
            copy_directory_recursive(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
            }
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "failed to copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn marketplace_plugin_names(manifest_path: &Path) -> Result<HashSet<String>, String> {
    let content = fs::read_to_string(manifest_path)
        .map_err(|error| format!("failed to read {}: {error}", manifest_path.display()))?;
    let manifest: Value = serde_json::from_str(&content)
        .map_err(|error| format!("invalid marketplace {}: {error}", manifest_path.display()))?;
    if manifest.get("name").and_then(Value::as_str) != Some(WEWORK_PERSONAL_MARKETPLACE_ID) {
        return Err(format!(
            "marketplace {} must use the reserved name {WEWORK_PERSONAL_MARKETPLACE_ID:?}",
            manifest_path.display()
        ));
    }
    let plugins = manifest
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            format!(
                "marketplace {} must contain a plugins array",
                manifest_path.display()
            )
        })?;
    let mut names = HashSet::new();
    for plugin in plugins {
        let name = plugin
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                format!(
                    "marketplace {} contains a plugin without a name",
                    manifest_path.display()
                )
            })?;
        if !names.insert(name.to_string()) {
            return Err(format!(
                "marketplace {} contains duplicate plugin {name:?}",
                manifest_path.display()
            ));
        }
    }
    Ok(names)
}

fn remove_bundled_marketplace_path(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("failed to remove {}: {error}", path.display()))
    } else if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("failed to remove {}: {error}", path.display()))
    } else {
        Ok(())
    }
}

fn initialize_bundled_plugin_marketplace_from_paths(
    source: &Path,
    destination: &Path,
) -> Result<BundledPluginMarketplace, String> {
    let codex_manifest = source.join(".agents/plugins/marketplace.json");
    let claude_manifest = source.join(".claude-plugin/marketplace.json");
    let codex_plugins = marketplace_plugin_names(&codex_manifest)?;
    let claude_plugins = marketplace_plugin_names(&claude_manifest)?;
    if codex_plugins != claude_plugins {
        return Err(
            "Bundled Codex and Claude Code marketplace plugin names must match".to_string(),
        );
    }

    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Bundled plugin marketplace destination has no parent: {}",
            destination.display()
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let staging = parent.join(format!(
        ".{WEWORK_PERSONAL_MARKETPLACE_ID}-{}-staging",
        std::process::id()
    ));
    remove_bundled_marketplace_path(&staging)?;
    if let Err(error) = copy_directory_recursive(source, &staging) {
        let _ = remove_bundled_marketplace_path(&staging);
        return Err(error);
    }
    remove_bundled_marketplace_path(destination)?;
    fs::rename(&staging, destination).map_err(|error| {
        format!(
            "failed to activate bundled plugin marketplace {}: {error}",
            destination.display()
        )
    })?;

    Ok(BundledPluginMarketplace {
        id: WEWORK_PERSONAL_MARKETPLACE_ID.to_string(),
        path: destination.display().to_string(),
        plugin_count: codex_plugins.len(),
    })
}

fn initialize_bundled_plugin_marketplace(
    _app: &tauri::AppHandle,
) -> Result<BundledPluginMarketplace, String> {
    #[cfg(debug_assertions)]
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(BUNDLED_PLUGIN_MARKETPLACE_DIR_NAME)
        .join(WEWORK_PERSONAL_MARKETPLACE_ID);
    #[cfg(not(debug_assertions))]
    let source = _app
        .path()
        .resource_dir()
        .map_err(|error| format!("failed to resolve WeWork resources: {error}"))?
        .join(BUNDLED_PLUGIN_MARKETPLACE_DIR_NAME)
        .join(WEWORK_PERSONAL_MARKETPLACE_ID);
    let destination = local_executor_runtime_home_path()?
        .join("capabilities")
        .join("bundled-marketplaces")
        .join(WEWORK_PERSONAL_MARKETPLACE_ID);
    let initialized = initialize_bundled_plugin_marketplace_from_paths(&source, &destination)?;
    log::info!(
        "Initialized WeWork bundled plugin marketplace: id={}, path={}, plugins={}",
        initialized.id,
        initialized.path,
        initialized.plugin_count,
    );
    Ok(initialized)
}

fn local_executor_sidecar_env(
    inner: &LocalExecutorInner,
    app: &tauri::AppHandle,
) -> Vec<(String, String)> {
    let mut envs = local_executor_backend_env(inner);
    if let Some(path) = non_empty_env(MANAGED_HOOKS_DIR_ENV) {
        envs.push((MANAGED_HOOKS_DIR_ENV.to_string(), path));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_hooks = resource_dir.join("bundled-hooks");
        if bundled_hooks.is_dir() {
            envs.push((
                BUNDLED_HOOKS_DIR_ENV.to_string(),
                bundled_hooks.display().to_string(),
            ));
        }
    }
    if std::env::var_os(CODEX_BINARY_PATH_ENV).is_none()
        && std::env::var_os(CODEX_BIN_ENV).is_none()
    {
        if let Some((package_root, binary_path)) = bundled_codex_paths(app) {
            envs.push((
                CODEX_BINARY_PATH_ENV.to_string(),
                binary_path.display().to_string(),
            ));
            envs.push((
                CODEX_MANAGED_PACKAGE_ROOT_ENV.to_string(),
                package_root.display().to_string(),
            ));
        }
    }
    if std::env::var_os(DWS_BINARY_PATH_ENV).is_none() {
        if let Some(path) = bundled_dws_path() {
            envs.push((DWS_BINARY_PATH_ENV.to_string(), path.display().to_string()));
        }
    }
    envs
}

fn bundled_dws_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let sibling = executable.with_file_name(if cfg!(windows) { "dws.exe" } else { "dws" });
    sibling.is_file().then_some(sibling)
}

fn append_bundled_codex_envs_for_root(envs: &mut Vec<(String, String)>, root: &Path) {
    if std::env::var_os(CODEX_BINARY_PATH_ENV).is_some()
        || std::env::var_os(CODEX_BIN_ENV).is_some()
    {
        return;
    }
    let Some((target, binary)) = bundled_codex_target_layout() else {
        return;
    };
    let package_root = root.join("binaries").join("codex").join(target);
    let binary_path = package_root.join(binary);
    if binary_path.is_file() {
        envs.push((
            CODEX_BINARY_PATH_ENV.to_string(),
            binary_path.display().to_string(),
        ));
        envs.push((
            CODEX_MANAGED_PACKAGE_ROOT_ENV.to_string(),
            package_root.display().to_string(),
        ));
    }
}

fn bundled_codex_paths(app: &tauri::AppHandle) -> Option<(PathBuf, PathBuf)> {
    let resource_dir = app.path().resource_dir().ok()?;
    let mut envs = Vec::new();
    append_bundled_codex_envs_for_root(&mut envs, &resource_dir);
    let package_root = envs
        .iter()
        .find(|(key, _)| key == CODEX_MANAGED_PACKAGE_ROOT_ENV)
        .map(|(_, value)| PathBuf::from(value))?;
    let binary_path = envs
        .iter()
        .find(|(key, _)| key == CODEX_BINARY_PATH_ENV)
        .map(|(_, value)| PathBuf::from(value))?;
    Some((package_root, binary_path))
}

fn bundled_codex_target_layout() -> Option<(&'static str, &'static str)> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some((
            "aarch64-apple-darwin",
            "vendor/aarch64-apple-darwin/bin/codex",
        ));
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some((
            "x86_64-apple-darwin",
            "vendor/x86_64-apple-darwin/bin/codex",
        ));
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return Some((
            "x86_64-unknown-linux-gnu",
            "vendor/x86_64-unknown-linux-musl/bin/codex",
        ));
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return Some((
            "aarch64-unknown-linux-gnu",
            "vendor/aarch64-unknown-linux-musl/bin/codex",
        ));
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some((
            "x86_64-pc-windows-msvc",
            "vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        ));
    }
    #[allow(unreachable_code)]
    None
}

fn response_error(response: ExecutorResponse) -> String {
    response
        .error
        .map(|error| {
            if error.code.is_empty() {
                error.message
            } else {
                format!("{}: {}", error.code, error.message)
            }
        })
        .unwrap_or_else(|| "Local executor request failed".to_string())
}

fn resolve_response_inner(inner: &SharedExecutorInner, response: ExecutorResponse) {
    let sender = inner
        .lock()
        .ok()
        .and_then(|mut inner| inner.pending.remove(&response.id));

    if let Some(sender) = sender {
        let result = if response.ok {
            Ok(response.result.unwrap_or(Value::Null))
        } else {
            Err(response_error(response))
        };
        let _ = sender.send(result);
    }
}

fn fail_pending_requests(state: &LocalExecutorState, message: String) {
    fail_pending_requests_inner(&state.inner, message);
}

fn fail_pending_requests_inner(inner: &SharedExecutorInner, message: String) {
    let pending = inner
        .lock()
        .map(|mut inner| {
            inner
                .pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for sender in pending {
        let _ = sender.send(Err(message.clone()));
    }
}

fn fail_pending_requests_for_generation(
    inner: &SharedExecutorInner,
    generation: u64,
    message: String,
) {
    let pending = inner
        .lock()
        .map(|mut inner| {
            if inner.generation != generation {
                return Vec::new();
            }
            inner
                .pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    for sender in pending {
        let _ = sender.send(Err(message.clone()));
    }
}

fn remove_pending_request(inner: &SharedExecutorInner, request_id: &str) {
    if let Ok(mut inner) = inner.lock() {
        inner.pending.remove(request_id);
    }
}

fn set_executor_error(state: &LocalExecutorState, error: String) {
    set_executor_error_inner(&state.inner, error);
}

fn set_executor_error_inner(inner: &SharedExecutorInner, error: String) {
    if let Ok(mut inner) = inner.lock() {
        inner.running = false;
        inner.ready = false;
        inner.error = Some(error);
    }
}

fn mark_child_terminated_for_generation(
    inner: &SharedExecutorInner,
    generation: u64,
    message: String,
) -> Option<LocalExecutorChild> {
    if let Ok(mut inner) = inner.lock() {
        if inner.generation != generation {
            return None;
        }
        let child = inner.child.take();
        inner.running = false;
        inner.ready = false;
        inner.error = Some(message);
        return child;
    }
    None
}

fn update_ready_event_inner(
    inner: &SharedExecutorInner,
    event: &ExecutorEvent,
) -> Option<(String, String)> {
    if event.event != "executor.ready" {
        return None;
    }

    let ready = event
        .payload
        .get("ready")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let device_id = event
        .payload
        .get("device_id")
        .or_else(|| event.payload.get("deviceId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let version = event
        .payload
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string);
    let runtime_instance_id = event
        .payload
        .get("runtime_instance_id")
        .or_else(|| event.payload.get("runtimeInstanceId"))
        .and_then(Value::as_str)
        .map(str::to_string);

    if let Ok(mut inner) = inner.lock() {
        let replaced_runtime = inner
            .runtime_instance_id
            .as_ref()
            .zip(runtime_instance_id.as_ref())
            .filter(|(previous, current)| previous != current)
            .map(|(previous, current)| (previous.clone(), current.clone()));
        inner.running = true;
        inner.ready = ready;
        if device_id.is_some() {
            inner.device_id = device_id;
        }
        if runtime_instance_id.is_some() {
            inner.runtime_instance_id = runtime_instance_id;
        }
        if version.is_some() {
            inner.version = version;
        }
        if ready {
            inner.error = None;
        }
        return replaced_runtime;
    }

    None
}

fn handle_executor_line_inner(
    app: &tauri::AppHandle,
    inner: &SharedExecutorInner,
    line: &str,
) -> Result<(), String> {
    if line.trim().is_empty() {
        return Ok(());
    }

    match parse_executor_line(line)? {
        ExecutorLine::Response(response) => {
            resolve_response_inner(inner, response);
        }
        ExecutorLine::Event(event) => {
            let debug_text_delta = event.event == "response.output_text.delta"
                && std::env::var_os("WEGENT_CODEX_STREAM_DEBUG").is_some();
            if debug_text_delta {
                let data = event.payload.get("data").unwrap_or(&Value::Null);
                log::info!(
                    "Forwarding runtime text delta to frontend: task_id={:?}, subtask_id={:?}, item_id={:?}, offset={:?}, delta_len={}",
                    event.payload.get("taskId"),
                    event.payload.get("subtaskId"),
                    data.get("itemId").or_else(|| data.get("item_id")),
                    data.get("offset"),
                    data.get("delta")
                        .and_then(Value::as_str)
                        .map(str::len)
                        .unwrap_or_default()
                );
            }
            app.state::<crate::system_sleep::SystemSleepState>()
                .handle_runtime_event(
                    &event.event,
                    event.payload.get("taskId").and_then(Value::as_str),
                );
            if let Some((previous_runtime_instance_id, runtime_instance_id)) =
                update_ready_event_inner(inner, &event)
            {
                log::warn!(
                    "Local executor runtime replaced: previous_runtime_instance_id={}, runtime_instance_id={}",
                    previous_runtime_instance_id,
                    runtime_instance_id
                );
                app.emit(
                    LOCAL_EXECUTOR_EVENT,
                    ExecutorEvent {
                        event: "executor.runtime_replaced".to_string(),
                        payload: json!({
                            "previousRuntimeInstanceId": previous_runtime_instance_id,
                            "runtimeInstanceId": runtime_instance_id,
                        }),
                    },
                )
                .map_err(|error| error.to_string())?;
            }
            let terminal = is_terminal_response_event(&event.event);
            let terminal_event = event.event.clone();
            let terminal_task_id = event
                .payload
                .get("taskId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let terminal_subtask_id = event
                .payload
                .get("subtaskId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let terminal_device_id = event
                .payload
                .get("deviceId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if terminal {
                log::info!(
                    "Received runtime terminal event from executor: event={}, task_id={:?}, subtask_id={:?}, device_id={:?}",
                    terminal_event,
                    terminal_task_id,
                    terminal_subtask_id,
                    terminal_device_id
                );
            }
            if event.event == "runtime.plan.updated" {
                log::info!(
                    "Forwarding runtime task plan event to frontend: task_id={:?}, device_id={:?}",
                    event.payload.get("taskId"),
                    event.payload.get("deviceId")
                );
            }
            if let Err(error) = app.emit(LOCAL_EXECUTOR_EVENT, event) {
                if terminal {
                    log::warn!(
                        "Failed to forward runtime terminal event to frontend: event={}, task_id={:?}, subtask_id={:?}, device_id={:?}, error={}",
                        terminal_event,
                        terminal_task_id,
                        terminal_subtask_id,
                        terminal_device_id,
                        error
                    );
                }
                return Err(error.to_string());
            }
            if debug_text_delta {
                log::info!("Forwarded runtime text delta to frontend event bus");
            }
            if terminal {
                log::info!(
                    "Forwarded runtime terminal event to frontend event bus: event={}, task_id={:?}, subtask_id={:?}, device_id={:?}",
                    terminal_event,
                    terminal_task_id,
                    terminal_subtask_id,
                    terminal_device_id
                );
            }
        }
    }

    Ok(())
}

fn is_terminal_response_event(event: &str) -> bool {
    matches!(
        event,
        "response.completed" | "response.failed" | "response.incomplete"
    )
}

fn write_request_line(inner: &mut LocalExecutorInner, line: &str) -> Result<(), String> {
    let Some(child) = inner.child.as_mut() else {
        return Err("Local executor stdio is not connected".to_string());
    };
    child.write(line.as_bytes())
}

fn drain_process_output(
    stream: LocalExecutorOutputStream,
    output: impl std::io::Read + Send + 'static,
) {
    thread::spawn(move || {
        let reader = BufReader::new(output);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                stream.log_line(trimmed);
            }
        }
    });
}

fn register_spawned_child(
    state: &LocalExecutorState,
    child: LocalExecutorChild,
) -> Result<u64, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?;
    inner.generation = inner.generation.saturating_add(1);
    inner.child = Some(child);
    inner.running = true;
    inner.ready = false;
    inner.codex_initialize_elapsed_ms = None;
    inner.device_id = Some(
        inner
            .device_id
            .clone()
            .unwrap_or_else(|| LOCAL_EXECUTOR_DEVICE_ID.to_string()),
    );
    inner.error = None;
    Ok(inner.generation)
}

fn report_ready_from_protocol(
    state: &SharedExecutorInner,
    sender: &mut Option<mpsc::Sender<Result<(), String>>>,
) {
    let ready = state.lock().map(|inner| inner.ready).unwrap_or(false);
    if ready {
        if let Some(sender) = sender.take() {
            let _ = sender.send(Ok(()));
        }
    }
}

fn handle_stdio_line(
    app: &tauri::AppHandle,
    state: &SharedExecutorInner,
    sender: &mut Option<mpsc::Sender<Result<(), String>>>,
    line: &str,
) {
    if let Err(error) = handle_executor_line_inner(app, state, line) {
        log::warn!("Failed to handle local executor stdio line: {error}");
        if let Some(sender) = sender.take() {
            let _ = sender.send(Err(error));
        }
        return;
    }
    report_ready_from_protocol(state, sender);
}

fn finish_stdio_reader(
    app: &tauri::AppHandle,
    state: &SharedExecutorInner,
    generation: u64,
    sender: &mut Option<mpsc::Sender<Result<(), String>>>,
    message: String,
    terminate_child: bool,
) {
    app.state::<crate::system_sleep::SystemSleepState>()
        .clear_running_tasks();
    if let Some(sender) = sender.take() {
        let _ = sender.send(Err(message.clone()));
    }
    let child = mark_child_terminated_for_generation(state, generation, message.clone());
    fail_pending_requests_for_generation(state, generation, message);
    if terminate_child {
        if let Some(child) = child {
            child.kill();
        }
    }
}

fn spawn_configured_sidecar(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    path: PathBuf,
    envs: &[(String, String)],
) -> Result<mpsc::Receiver<Result<(), String>>, String> {
    if !path.exists() {
        return Err(format!(
            "Configured local executor sidecar does not exist: {}",
            path.display()
        ));
    }

    let mut command = Command::new(&path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env_clear();
    command.envs(process_environment::sanitized_current_environment());
    command.envs(envs.iter().map(|(key, value)| (key, value)));
    configure_managed_process_group(&mut command);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Failed to start local executor sidecar {}: {error}",
            path.display()
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Local executor stdout is unavailable".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        drain_process_output(LocalExecutorOutputStream::Stderr, stderr);
    }
    let generation = register_spawned_child(
        state,
        LocalExecutorChild::Process(ManagedProcessChild::new(child)),
    )?;
    let state_handle = state.inner.clone();
    let (ready_sender, ready_receiver) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut ready_sender = Some(ready_sender);
        for line in reader.lines() {
            match line {
                Ok(line) => handle_stdio_line(&app, &state_handle, &mut ready_sender, &line),
                Err(error) => {
                    let message = format!("Local executor stdout read failed: {error}");
                    finish_stdio_reader(
                        &app,
                        &state_handle,
                        generation,
                        &mut ready_sender,
                        message,
                        true,
                    );
                    return;
                }
            }
        }
        finish_stdio_reader(
            &app,
            &state_handle,
            generation,
            &mut ready_sender,
            "Local executor stdout closed".to_string(),
            true,
        );
    });
    Ok(ready_receiver)
}

fn spawn_bundled_sidecar(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    envs: &[(String, String)],
) -> Result<mpsc::Receiver<Result<(), String>>, String> {
    let sidecar = app
        .shell()
        .sidecar(LOCAL_EXECUTOR_SIDECAR)
        .map_err(|error| {
            format!("Failed to resolve local executor sidecar {LOCAL_EXECUTOR_SIDECAR}: {error}")
        })?
        .env_clear()
        .envs(process_environment::sanitized_current_environment())
        .envs(envs.iter().map(|(key, value)| (key, value)));
    let (mut rx, child) = sidecar.spawn().map_err(|error| {
        format!("Failed to start local executor sidecar {LOCAL_EXECUTOR_SIDECAR}: {error}")
    })?;

    let generation = register_spawned_child(state, LocalExecutorChild::Tauri(child))?;
    let state_handle = state.inner.clone();
    let (ready_sender, ready_receiver) = mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let mut ready_sender = Some(ready_sender);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    if !text.trim().is_empty() {
                        handle_stdio_line(&app, &state_handle, &mut ready_sender, text.trim());
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    if !text.trim().is_empty() {
                        LocalExecutorOutputStream::Stderr.log_line(text.trim());
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let message = format!("Local executor exited: {payload:?}");
                    finish_stdio_reader(
                        &app,
                        &state_handle,
                        generation,
                        &mut ready_sender,
                        message,
                        false,
                    );
                    return;
                }
                CommandEvent::Error(error) => {
                    let message = format!("Local executor stdio failed: {error}");
                    finish_stdio_reader(
                        &app,
                        &state_handle,
                        generation,
                        &mut ready_sender,
                        message,
                        true,
                    );
                    return;
                }
                _ => {}
            }
        }
        finish_stdio_reader(
            &app,
            &state_handle,
            generation,
            &mut ready_sender,
            "Local executor stdio closed".to_string(),
            true,
        );
    });
    Ok(ready_receiver)
}

async fn wait_for_executor_ready(
    receiver: mpsc::Receiver<Result<(), String>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(LOCAL_EXECUTOR_READY_TIMEOUT_SECS))
            .unwrap_or_else(|_| Err("Timed out waiting for local executor ready event".to_string()))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn stop_failed_sidecar_start(state: &LocalExecutorState, error: &str) {
    let child = state.inner.lock().ok().and_then(|mut inner| {
        inner.running = false;
        inner.ready = false;
        inner.error = Some(error.to_string());
        inner.generation = inner.generation.saturating_add(1);
        inner.child.take()
    });
    if let Some(child) = child {
        child.kill();
    }
    fail_pending_requests(state, error.to_string());
}

async fn spawn_sidecar(app: tauri::AppHandle, state: &LocalExecutorState) -> Result<(), String> {
    let envs = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        local_executor_sidecar_env(&inner, &app)
    };
    prepare_local_executor_codex_auth(&envs)?;
    let receiver = if let Some(path) = configured_sidecar_path() {
        spawn_configured_sidecar(app, state, path, &envs)?
    } else {
        spawn_bundled_sidecar(app, state, &envs)?
    };
    if let Err(error) = wait_for_executor_ready(receiver).await {
        stop_failed_sidecar_start(state, &error);
        return Err(error);
    }
    let ready = state
        .inner
        .lock()
        .map_err(|_| "Failed to lock local executor state".to_string())?
        .ready;
    if !ready {
        let error = "Local executor did not report ready".to_string();
        stop_failed_sidecar_start(state, &error);
        return Err(error);
    }
    Ok(())
}

async fn start_executor_if_needed_unlocked(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let child_to_kill = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        if inner.running && inner.ready {
            if inner
                .child
                .as_mut()
                .map(LocalExecutorChild::is_running)
                .unwrap_or(false)
            {
                return Ok(());
            }
        }
        inner.running = false;
        inner.ready = false;
        inner.child.take()
    };
    if let Some(child) = child_to_kill {
        child.kill();
    }
    if let Err(error) = spawn_sidecar(app, state).await {
        set_executor_error(state, error.clone());
        return Err(error);
    }
    Ok(())
}

async fn start_executor_if_needed(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
) -> Result<(), String> {
    let _guard = state.start_lock.lock().await;
    start_executor_if_needed_unlocked(app, state).await
}

async fn send_executor_request(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    request: LocalExecutorRequest,
) -> Result<Value, String> {
    send_executor_request_with_timeout(
        app,
        state,
        request,
        Duration::from_secs(LOCAL_EXECUTOR_REQUEST_TIMEOUT_SECONDS),
    )
    .await
}

async fn send_executor_request_with_timeout(
    app: tauri::AppHandle,
    state: &LocalExecutorState,
    request: LocalExecutorRequest,
    timeout: Duration,
) -> Result<Value, String> {
    start_executor_if_needed(app, state).await?;

    let request_id = next_request_id(state);
    let method = request.method.clone();
    let log_request = method != "executor.health";
    let started_at = Instant::now();
    let (sender, receiver) = mpsc::channel::<Result<Value, String>>();
    let message = json!({
        "type": "request",
        "id": request_id,
        "method": method,
        "params": request.params,
    });
    let line = format!(
        "{}\n",
        serde_json::to_string(&message).map_err(|error| error.to_string())?
    );

    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        inner.pending.insert(request_id.clone(), sender);
        let pending_count = inner.pending.len();
        if log_request {
            log::info!(
                "Local executor IPC request started: request_id={request_id}, method={method}, pending_count={pending_count}"
            );
        }
        if let Err(error) = write_request_line(&mut inner, &line) {
            inner.pending.remove(&request_id);
            log::warn!(
                "Local executor IPC request write failed: request_id={request_id}, method={method}, error={error}"
            );
            return Err(error);
        }
    }

    let inner = state.inner.clone();
    let wait_request_id = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match receiver.recv_timeout(timeout) {
            Ok(result) => {
                if log_request {
                    log::info!(
                        "Local executor IPC request finished: request_id={wait_request_id}, method={method}, elapsed_ms={}",
                        started_at.elapsed().as_millis()
                    );
                }
                result
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                log::warn!(
                    "Local executor IPC request disconnected: request_id={wait_request_id}, method={method}, elapsed_ms={}",
                    started_at.elapsed().as_millis()
                );
                Err("Local executor disconnected".to_string())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let message = format!(
                    "Local executor request {method} timed out after {}s",
                    timeout.as_secs()
                );
                log::warn!(
                    "Local executor IPC request timed out: request_id={wait_request_id}, method={method}, elapsed_ms={}",
                    started_at.elapsed().as_millis()
                );
                remove_pending_request(&inner, &wait_request_id);
                Err(message)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_executor_status(
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_read_log(
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorLog, String> {
    let path = local_executor_log_path()?;
    let path_for_read = path.clone();
    let tail_result = tauri::async_runtime::spawn_blocking(move || {
        read_local_executor_log_tail(&path_for_read, LOCAL_EXECUTOR_LOG_TAIL_BYTES)
    })
    .await
    .map_err(|error| error.to_string())?;
    let tail = tail_result.unwrap_or_else(|error| LocalExecutorLogTail {
        path: path.display().to_string(),
        content: format!("Executor log unavailable: {error}"),
        truncated: false,
        line_count: 0,
    });
    let processes = local_executor_processes();
    let process_pids = processes
        .iter()
        .map(|process| process.pid)
        .collect::<Vec<_>>();
    let process_paths = processes
        .iter()
        .map(|process| process.path.clone())
        .collect::<Vec<_>>();
    let (sidecar_source, sidecar_path) = sidecar_source_and_path();
    let current_dir = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("unavailable: {error}"));
    let executor_home = path_or_error(local_executor_home_path());
    let (
        status,
        backend_url,
        socket_url,
        has_backend_auth_token,
        pending_request_count,
        transport_connected,
    ) = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        let backend_url = inner
            .backend_connection
            .as_ref()
            .map(|connection| connection.backend_url.clone());
        let socket_url = inner
            .backend_connection
            .as_ref()
            .map(|connection| connection.socket_url.clone());
        let has_backend_auth_token = inner
            .backend_connection
            .as_ref()
            .map(|connection| !connection.auth_token.trim().is_empty())
            .unwrap_or(false);
        (
            status_from_inner(&inner),
            backend_url,
            socket_url,
            has_backend_auth_token,
            inner.pending.len(),
            inner.child.is_some() && inner.running && inner.ready,
        )
    };

    Ok(LocalExecutorLog {
        path: tail.path,
        content: tail.content,
        truncated: tail.truncated,
        line_count: tail.line_count,
        transport: "stdio".to_string(),
        transport_connected,
        process_pids,
        process_paths,
        sidecar_source,
        sidecar_path,
        current_dir,
        executor_home,
        backend_url,
        socket_url,
        has_backend_auth_token,
        pending_request_count,
        status,
    })
}

#[tauri::command]
pub async fn local_executor_codex_home_migration_status() -> Result<CodexHomeMigrationStatus, String>
{
    codex_home_migration_status()
}

#[tauri::command]
pub async fn local_executor_read_codex_local_config() -> Result<CodexLocalConfig, String> {
    read_codex_local_config()
}

#[tauri::command]
pub async fn local_executor_update_codex_local_config(
    patch: CodexLocalConfigPatch,
) -> Result<CodexLocalConfig, String> {
    if let Some(enabled) = patch.remote_apps_enabled {
        return write_codex_remote_apps_enabled(enabled);
    }
    read_codex_local_config()
}

#[tauri::command]
pub async fn local_executor_initialize_codex_home(
    options: CodexHomeInitializeOptions,
) -> Result<CodexHomeMigrationStatus, String> {
    let status = codex_home_migration_status()?;
    log::info!(
        "Codex home initialization started: migrate_native_home={}, remote_apps_enabled={}, should_prompt_migration={}, native={}, wework={}",
        options.migrate_native_home,
        options.remote_apps_enabled,
        status.should_prompt_migration,
        status.native_codex_home,
        status.wework_codex_home
    );
    if options.migrate_native_home && status.should_prompt_migration {
        let source = PathBuf::from(&status.native_codex_home);
        let destination = PathBuf::from(&status.wework_codex_home);
        copy_codex_initialization_files(&source, &destination)?;
    } else {
        let destination = PathBuf::from(&status.wework_codex_home);
        fs::create_dir_all(&destination)
            .map_err(|error| format!("failed to create {}: {error}", destination.display()))?;
    }
    write_codex_remote_apps_enabled(options.remote_apps_enabled)?;
    let next_status = codex_home_migration_status()?;
    log::info!(
        "Codex home initialization finished: should_prompt_migration={}, wework={}",
        next_status.should_prompt_migration,
        next_status.wework_codex_home
    );
    Ok(next_status)
}

#[tauri::command]
pub async fn local_executor_initialize_bundled_plugin_marketplace(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
) -> Result<BundledPluginMarketplace, String> {
    let mut initialized = state.bundled_plugin_marketplace.lock().await;
    if let Some(marketplace) = initialized.as_ref() {
        return Ok(marketplace.clone());
    }
    let marketplace = initialize_bundled_plugin_marketplace(&app)?;
    *initialized = Some(marketplace.clone());
    Ok(marketplace)
}

#[tauri::command]
pub async fn local_executor_migrate_native_codex_home() -> Result<CodexHomeMigrationStatus, String>
{
    local_executor_initialize_codex_home(CodexHomeInitializeOptions {
        migrate_native_home: true,
        remote_apps_enabled: true,
    })
    .await
}

fn collect_plugin_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    fn visit(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        let mut entries = fs::read_dir(directory)
            .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Plugin package cannot contain symbolic links: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                visit(root, &path, files)?;
            } else if metadata.is_file() {
                path.strip_prefix(root)
                    .map_err(|_| "Plugin file escaped its package root".to_string())?;
                files.push(path);
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn marketplace_manifest_paths(marketplace_path: &Path) -> Vec<PathBuf> {
    vec![
        marketplace_path.join(".agents/plugins/marketplace.json"),
        marketplace_path.join(".claude-plugin/marketplace.json"),
        marketplace_path.join("marketplace.json"),
        marketplace_path.join("plugins/marketplace.json"),
    ]
}

fn marketplace_roots_for_resolution(marketplace_path: &Path) -> Vec<PathBuf> {
    let mut roots = vec![marketplace_path.to_path_buf()];
    if marketplace_path
        .file_name()
        .is_some_and(|name| name == ".agents")
    {
        if let Some(parent) = marketplace_path.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    if marketplace_path
        .file_name()
        .is_some_and(|name| name == "plugins")
    {
        if let Some(agents) = marketplace_path.parent() {
            roots.push(agents.to_path_buf());
            if agents.file_name().is_some_and(|name| name == ".agents") {
                if let Some(home) = agents.parent() {
                    roots.push(home.to_path_buf());
                }
            }
        }
    }
    roots
}

fn plugin_source_path_from_marketplace_json(
    manifest_path: &Path,
    plugin_name: &str,
) -> Option<PathBuf> {
    let content = fs::read_to_string(manifest_path).ok()?;
    let manifest = serde_json::from_str::<Value>(&content).ok()?;
    let plugins = manifest.get("plugins")?.as_array()?;
    for plugin in plugins {
        let name = plugin.get("name").and_then(Value::as_str)?;
        if name != plugin_name {
            continue;
        }
        let source = plugin.get("source")?;
        let relative = source
            .get("path")
            .and_then(Value::as_str)
            .or_else(|| source.as_str())?;
        let relative = relative
            .trim()
            .trim_start_matches("./")
            .trim_start_matches(".\\");
        if relative.is_empty() {
            continue;
        }
        let path = PathBuf::from(relative);
        if path.is_absolute() {
            return Some(path);
        }
        // Codex personal marketplace keeps marketplace.json under ~/.agents/plugins
        // while plugin sources are relative to the marketplace root (usually $HOME).
        for root in marketplace_roots_for_resolution(
            manifest_path
                .parent()
                .and_then(|parent| {
                    if parent.file_name().is_some_and(|name| name == "plugins") {
                        parent.parent()
                    } else {
                        Some(parent)
                    }
                })
                .unwrap_or_else(|| Path::new(".")),
        ) {
            let candidate = root.join(relative);
            if candidate.join(".codex-plugin/plugin.json").is_file() {
                return Some(candidate);
            }
        }
        if let Some(manifest_dir) = manifest_path.parent() {
            let candidate = manifest_dir.join(relative);
            if candidate.join(".codex-plugin/plugin.json").is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_local_plugin_root(
    marketplace_path: &Path,
    plugin_name: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let resolved_marketplace_path = marketplace_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve local marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&resolved_marketplace_path);
    let mut candidates = vec![
        marketplace_root.join("plugins").join(plugin_name),
        marketplace_root.join(plugin_name),
    ];
    for root in marketplace_roots_for_resolution(&marketplace_root) {
        candidates.push(root.join("plugins").join(plugin_name));
        candidates.push(root.join(plugin_name));
        for manifest in marketplace_manifest_paths(&root) {
            if let Some(source) = plugin_source_path_from_marketplace_json(&manifest, plugin_name) {
                candidates.push(source);
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("plugins").join(plugin_name));
    }

    let mut seen = std::collections::HashSet::new();
    for candidate in candidates {
        let Ok(normalized) = candidate.canonicalize() else {
            continue;
        };
        if !seen.insert(normalized.clone()) {
            continue;
        }
        if normalized.join(".codex-plugin/plugin.json").is_file()
            || normalized.join(".claude-plugin/plugin.json").is_file()
        {
            return Ok((marketplace_root, normalized));
        }
    }
    Err("Local plugin manifest is unavailable".to_string())
}

fn marketplace_root_from_path(path: &Path) -> PathBuf {
    if path
        .file_name()
        .is_none_or(|name| name != "marketplace.json")
    {
        return path.to_path_buf();
    }
    let Some(parent) = path.parent() else {
        return path.to_path_buf();
    };
    if parent.file_name().is_some_and(|name| name == "plugins") {
        if let Some(scope) = parent.parent() {
            if scope
                .file_name()
                .is_some_and(|name| name == ".agents" || name == ".claude-plugin")
            {
                return scope.parent().unwrap_or(scope).to_path_buf();
            }
        }
    }
    if parent
        .file_name()
        .is_some_and(|name| name == ".agents" || name == ".claude-plugin")
    {
        return parent.parent().unwrap_or(parent).to_path_buf();
    }
    parent.to_path_buf()
}

fn validate_plugin_name(plugin_name: &str) -> Result<&str, String> {
    let normalized_name = plugin_name.trim();
    if normalized_name.is_empty()
        || normalized_name.contains('/')
        || normalized_name.contains('\\')
        || normalized_name == "."
        || normalized_name == ".."
    {
        return Err("Plugin name is invalid".to_string());
    }
    Ok(normalized_name)
}

fn upsert_marketplace_plugin_entry(manifest_path: &Path, plugin_name: &str) -> Result<(), String> {
    let relative_source = format!("./plugins/{plugin_name}");
    let mut manifest = if manifest_path.is_file() {
        let content = fs::read_to_string(manifest_path)
            .map_err(|error| format!("Failed to read {}: {error}", manifest_path.display()))?;
        serde_json::from_str::<Value>(&content).map_err(|error| {
            format!(
                "Invalid marketplace manifest {}: {error}",
                manifest_path.display()
            )
        })?
    } else {
        json!({
            "name": WEWORK_PERSONAL_MARKETPLACE_ID,
            "interface": { "displayName": "WeWork Personal Marketplace" },
            "plugins": []
        })
    };
    let object = manifest
        .as_object_mut()
        .ok_or_else(|| "Marketplace manifest must be an object".to_string())?;
    object
        .entry("name")
        .or_insert_with(|| Value::String(WEWORK_PERSONAL_MARKETPLACE_ID.to_string()));
    let plugins = object
        .entry("plugins")
        .or_insert_with(|| Value::Array(vec![]));
    let plugins = plugins
        .as_array_mut()
        .ok_or_else(|| "Marketplace plugins must be an array".to_string())?;
    let already_present = plugins.iter().any(|plugin| {
        plugin
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == plugin_name)
    });
    if !already_present {
        plugins.push(json!({
            "name": plugin_name,
            "source": {
                "source": "local",
                "path": relative_source
            },
            "policy": {
                "installation": "AVAILABLE",
                "authentication": "ON_INSTALL"
            }
        }));
    }
    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Failed to serialize marketplace manifest: {error}"))?;
    write_atomic_file(manifest_path, &bytes)
}

fn ensure_plugin_in_personal_marketplace(
    source_marketplace_path: &Path,
    destination_marketplace_path: &Path,
    plugin_name: &str,
) -> Result<EnsurePersonalPluginResult, String> {
    let normalized_name = validate_plugin_name(plugin_name)?;
    let destination_root = {
        fs::create_dir_all(destination_marketplace_path).map_err(|error| {
            format!(
                "Failed to create personal marketplace {}: {error}",
                destination_marketplace_path.display()
            )
        })?;
        destination_marketplace_path
            .canonicalize()
            .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?
    };
    let _mutation_lock = acquire_plugin_mutation_lock(&destination_root)?;
    let destination_plugin = destination_root.join("plugins").join(normalized_name);
    if destination_plugin
        .join(".codex-plugin/plugin.json")
        .is_file()
    {
        let plugin_path = destination_plugin
            .canonicalize()
            .map_err(|error| format!("Failed to resolve personal plugin: {error}"))?;
        return Ok(EnsurePersonalPluginResult {
            plugin_name: normalized_name.to_string(),
            marketplace_path: destination_root.display().to_string(),
            plugin_path: plugin_path.display().to_string(),
            migrated: false,
        });
    }

    let (_source_root, source_plugin) =
        resolve_local_plugin_root(source_marketplace_path, normalized_name)?;
    if source_plugin.starts_with(&destination_root) {
        return Ok(EnsurePersonalPluginResult {
            plugin_name: normalized_name.to_string(),
            marketplace_path: destination_root.display().to_string(),
            plugin_path: source_plugin.display().to_string(),
            migrated: false,
        });
    }

    let plugins_root = destination_root.join("plugins");
    fs::create_dir_all(&plugins_root)
        .map_err(|error| format!("Failed to create plugin directory: {error}"))?;
    let staging = plugins_root.join(format!(
        ".{}-migrate-{}",
        normalized_name,
        std::process::id()
    ));
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("Failed to clear stale plugin migration: {error}"))?;
    }
    if let Err(error) = copy_directory_recursive(&source_plugin, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if destination_plugin.exists() {
        fs::remove_dir_all(&destination_plugin).map_err(|error| {
            format!(
                "Failed to replace personal plugin {}: {error}",
                destination_plugin.display()
            )
        })?;
    }
    if let Err(error) = fs::rename(&staging, &destination_plugin) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Failed to activate migrated plugin: {error}"));
    }

    for manifest in [
        destination_root.join(".agents/plugins/marketplace.json"),
        destination_root.join(".claude-plugin/marketplace.json"),
    ] {
        if let Err(error) = upsert_marketplace_plugin_entry(&manifest, normalized_name) {
            let _ = fs::remove_dir_all(&destination_plugin);
            return Err(error);
        }
    }

    let plugin_path = destination_plugin
        .canonicalize()
        .map_err(|error| format!("Failed to resolve migrated plugin: {error}"))?;
    Ok(EnsurePersonalPluginResult {
        plugin_name: normalized_name.to_string(),
        marketplace_path: destination_root.display().to_string(),
        plugin_path: plugin_path.display().to_string(),
        migrated: true,
    })
}

fn package_local_plugin(
    marketplace_path: &Path,
    plugin_name: &str,
) -> Result<LocalPluginPackage, String> {
    let normalized_name = validate_plugin_name(plugin_name)?;
    let (_marketplace_root, plugin_root) =
        resolve_local_plugin_root(marketplace_path, normalized_name)?;

    let files = collect_plugin_files(&plugin_root)?;
    let expanded_size = files.iter().try_fold(0_u64, |total, path| {
        let size = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .len();
        total
            .checked_add(size)
            .ok_or_else(|| "Plugin package size overflow".to_string())
    })?;
    if expanded_size > MAX_PLUGIN_EXPANDED_BYTES {
        return Err("Expanded plugin package exceeds 200 MB".to_string());
    }

    let cursor = std::io::Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for path in files {
        let relative = path
            .strip_prefix(&plugin_root)
            .map_err(|_| "Plugin file escaped its package root".to_string())?;
        let archive_path = relative.to_string_lossy().replace('\\', "/");
        archive
            .start_file(&archive_path, options)
            .map_err(|error| format!("Failed to add {archive_path}: {error}"))?;
        let mut file = fs::File::open(&path)
            .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
        std::io::copy(&mut file, &mut archive)
            .map_err(|error| format!("Failed to package {archive_path}: {error}"))?;
    }
    let bytes = archive
        .finish()
        .map_err(|error| format!("Failed to finish plugin package: {error}"))?
        .into_inner();
    if bytes.len() > MAX_PLUGIN_PACKAGE_BYTES {
        return Err("Plugin ZIP exceeds 50 MB".to_string());
    }
    Ok(LocalPluginPackage {
        name: format!("{normalized_name}.zip"),
        bytes,
    })
}

#[tauri::command]
pub async fn local_executor_package_plugin(
    marketplace_path: String,
    plugin_name: String,
) -> Result<LocalPluginPackage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        package_local_plugin(Path::new(&marketplace_path), &plugin_name)
    })
    .await
    .map_err(|error| format!("Failed to join plugin packaging task: {error}"))?
}

#[tauri::command]
pub async fn local_executor_read_plugin_manifest(
    marketplace_path: String,
    plugin_name: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_local_plugin_manifest(Path::new(&marketplace_path), &plugin_name)
    })
    .await
    .map_err(|error| format!("Failed to join plugin manifest task: {error}"))?
}

fn read_local_plugin_manifest(marketplace_path: &Path, plugin_name: &str) -> Result<Value, String> {
    let normalized_name = validate_plugin_name(plugin_name)?;
    let (_marketplace_root, plugin_root) =
        resolve_local_plugin_root(marketplace_path, normalized_name)?;
    let manifest_path = [
        plugin_root.join(".codex-plugin/plugin.json"),
        plugin_root.join(".claude-plugin/plugin.json"),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .ok_or_else(|| "Local plugin manifest is unavailable".to_string())?;
    let content = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Failed to read plugin manifest: {error}"))?;
    let manifest = serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("Invalid plugin manifest: {error}"))?;
    Ok(json!({
        "connectors": manifest.get("connectors").cloned().unwrap_or_else(|| json!([])),
    }))
}

#[tauri::command]
pub async fn local_executor_ensure_personal_plugin(
    options: EnsurePersonalPluginOptions,
) -> Result<EnsurePersonalPluginResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_plugin_in_personal_marketplace(
            Path::new(&options.source_marketplace_path),
            Path::new(&options.destination_marketplace_path),
            &options.plugin_name,
        )
    })
    .await
    .map_err(|error| format!("Failed to join personal plugin migration task: {error}"))?
}

fn normalized_copy_slug(source_name: &str) -> String {
    let mut slug = source_name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug = slug.trim_matches(['-', '_']).to_string();
    if slug.is_empty() {
        slug = "plugin".to_string();
    }
    format!("{slug}-copy")
}

fn unique_copy_slug(plugins_root: &Path, source_name: &str) -> String {
    let base = normalized_copy_slug(source_name);
    if !plugins_root.join(&base).exists() {
        return base;
    }
    for suffix in 2_u32.. {
        let candidate = format!("{base}-{suffix}");
        if !plugins_root.join(&candidate).exists() {
            return candidate;
        }
    }
    unreachable!("copy suffix range is unbounded")
}

fn safe_archive_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('\0') || name.contains('\\') {
        return Err("Plugin ZIP contains an invalid path".to_string());
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!("Plugin ZIP contains an unsafe path: {name}"));
    }
    Ok(path.to_path_buf())
}

fn reject_duplicate_zip_paths(package: &[u8]) -> Result<(), String> {
    const END_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
    const CENTRAL_SIGNATURE: &[u8; 4] = b"PK\x01\x02";
    let search_start = package.len().saturating_sub(65_557);
    let end_offset = (search_start..package.len().saturating_sub(3))
        .rev()
        .find(|offset| &package[*offset..*offset + 4] == END_SIGNATURE)
        .ok_or_else(|| "Plugin package is missing its ZIP directory".to_string())?;
    if end_offset + 22 > package.len() {
        return Err("Plugin ZIP directory is truncated".to_string());
    }
    let read_u16 =
        |offset: usize| u16::from_le_bytes([package[offset], package[offset + 1]]) as usize;
    let read_u32 = |offset: usize| {
        u32::from_le_bytes([
            package[offset],
            package[offset + 1],
            package[offset + 2],
            package[offset + 3],
        ]) as usize
    };
    let entry_count = read_u16(end_offset + 10);
    let directory_size = read_u32(end_offset + 12);
    let mut cursor = read_u32(end_offset + 16);
    if entry_count == u16::MAX as usize
        || directory_size == u32::MAX as usize
        || cursor == u32::MAX as usize
    {
        return Err("ZIP64 plugin copies are not supported".to_string());
    }
    let directory_end = cursor
        .checked_add(directory_size)
        .ok_or_else(|| "Plugin ZIP directory size overflow".to_string())?;
    if directory_end > end_offset || directory_end > package.len() {
        return Err("Plugin ZIP directory is invalid".to_string());
    }
    let mut names = HashSet::new();
    for _ in 0..entry_count {
        if cursor + 46 > directory_end || &package[cursor..cursor + 4] != CENTRAL_SIGNATURE {
            return Err("Plugin ZIP directory entry is invalid".to_string());
        }
        let name_length = read_u16(cursor + 28);
        let extra_length = read_u16(cursor + 30);
        let comment_length = read_u16(cursor + 32);
        let name_start = cursor + 46;
        let name_end = name_start
            .checked_add(name_length)
            .ok_or_else(|| "Plugin ZIP filename size overflow".to_string())?;
        if name_end > directory_end {
            return Err("Plugin ZIP filename is truncated".to_string());
        }
        if !names.insert(package[name_start..name_end].to_vec()) {
            let name = String::from_utf8_lossy(&package[name_start..name_end]);
            return Err(format!("Plugin ZIP contains a duplicate path: {name}"));
        }
        cursor = name_end
            .checked_add(extra_length)
            .and_then(|value| value.checked_add(comment_length))
            .ok_or_else(|| "Plugin ZIP directory entry size overflow".to_string())?;
    }
    if cursor != directory_end {
        return Err("Plugin ZIP directory length does not match its entries".to_string());
    }
    Ok(())
}

fn extract_plugin_copy(package: &[u8], destination: &Path) -> Result<Value, String> {
    if package.len() > MAX_PLUGIN_PACKAGE_BYTES {
        return Err("Plugin ZIP exceeds 50 MB".to_string());
    }
    reject_duplicate_zip_paths(package)?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package))
        .map_err(|error| format!("Plugin package is not a valid ZIP: {error}"))?;
    let mut paths = HashSet::new();
    let mut expanded_size = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read plugin ZIP entry: {error}"))?;
        let entry_name = entry.name().trim_end_matches('/');
        if entry_name.is_empty() {
            continue;
        }
        let relative = safe_archive_path(entry_name)?;
        let normalized = relative.to_string_lossy().replace('\\', "/");
        if !paths.insert(normalized.clone()) {
            return Err(format!(
                "Plugin ZIP contains a duplicate path: {normalized}"
            ));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("Plugin ZIP contains a symbolic link: {normalized}"));
        }
        expanded_size = expanded_size
            .checked_add(entry.size())
            .ok_or_else(|| "Plugin expanded size overflow".to_string())?;
        if expanded_size > MAX_PLUGIN_EXPANDED_BYTES {
            return Err("Expanded plugin package exceeds 200 MB".to_string());
        }
        let output = destination.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| format!("Failed to create {}: {error}", output.display()))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let mut file = fs::File::create(&output)
            .map_err(|error| format!("Failed to create {}: {error}", output.display()))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("Failed to extract {normalized}: {error}"))?;
    }

    let manifest_path = destination.join(".codex-plugin/plugin.json");
    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|_| "Local plugin copy is missing .codex-plugin/plugin.json".to_string())?;
    let manifest = serde_json::from_slice::<Value>(&manifest_bytes)
        .map_err(|error| format!("Local plugin manifest is invalid: {error}"))?;
    if !manifest.is_object()
        || manifest.get("name").and_then(Value::as_str).is_none()
        || manifest.get("version").and_then(Value::as_str).is_none()
    {
        return Err("Local plugin manifest requires string name and version fields".to_string());
    }
    Ok(manifest)
}

fn copy_registry_path(marketplace_root: &Path) -> PathBuf {
    marketplace_root.join(".wegent/plugin-copy-sources.json")
}

fn acquire_plugin_mutation_lock(marketplace_root: &Path) -> Result<fs::File, String> {
    let lock_directory = marketplace_root.join(".wegent");
    fs::create_dir_all(&lock_directory).map_err(|error| {
        format!(
            "Failed to create plugin mutation lock directory {}: {error}",
            lock_directory.display()
        )
    })?;
    let lock_path = lock_directory.join(PLUGIN_MUTATION_LOCK_FILE);
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|error| {
            format!(
                "Failed to open plugin mutation lock {}: {error}",
                lock_path.display()
            )
        })?;
    lock.lock_exclusive().map_err(|error| {
        format!(
            "Failed to lock personal marketplace {}: {error}",
            marketplace_root.display()
        )
    })?;
    Ok(lock)
}

fn updated_copy_registry(path: &Path, record: LocalPluginCopyRecord) -> Result<Vec<u8>, String> {
    let mut registry = if path.is_file() {
        let bytes = fs::read(path)
            .map_err(|error| format!("Failed to read plugin copy registry: {error}"))?;
        serde_json::from_slice::<LocalPluginCopyRegistry>(&bytes)
            .map_err(|error| format!("Plugin copy registry is invalid: {error}"))?
    } else {
        LocalPluginCopyRegistry::default()
    };
    registry.copies.push(record);
    serde_json::to_vec_pretty(&registry)
        .map_err(|error| format!("Failed to serialize plugin copy registry: {error}"))
}

fn write_atomic_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Plugin copy registry path is invalid".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let temp_path = parent.join(format!(".plugin-copy-registry-{}.tmp", std::process::id()));
    fs::write(&temp_path, bytes)
        .map_err(|error| format!("Failed to write plugin copy registry: {error}"))?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("Failed to replace plugin copy registry: {error}"));
    }
    Ok(())
}

fn import_plugin_copy_package(
    marketplace_path: &Path,
    package: &[u8],
    options: &LocalPluginCopyImportOptions,
) -> Result<LocalPluginCopyImportResult, String> {
    let expected_sha256 = options.sha256.trim().to_ascii_lowercase();
    if expected_sha256.len() != 64
        || !expected_sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Plugin copy checksum is invalid".to_string());
    }
    let actual_sha256 = format!("{:x}", Sha256::digest(package));
    if actual_sha256 != expected_sha256 {
        return Err("Plugin copy checksum mismatch".to_string());
    }

    fs::create_dir_all(marketplace_path).map_err(|error| {
        format!(
            "Failed to create personal marketplace {}: {error}",
            marketplace_path.display()
        )
    })?;
    let marketplace_root = marketplace_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
    let plugins_root = marketplace_root.join("plugins");
    fs::create_dir_all(&plugins_root)
        .map_err(|error| format!("Failed to create plugin directory: {error}"))?;
    let plugin_name = unique_copy_slug(&plugins_root, &options.source_plugin_name);
    let display_base = options.source_display_name.trim();
    let display_name = format!(
        "{} · 我的副本",
        if display_base.is_empty() {
            options.source_plugin_name.trim()
        } else {
            display_base
        }
    );
    let temp_root = plugins_root.join(format!(".{}-import-{}", plugin_name, std::process::id()));
    if temp_root.exists() {
        fs::remove_dir_all(&temp_root)
            .map_err(|error| format!("Failed to clear stale plugin import: {error}"))?;
    }
    fs::create_dir(&temp_root)
        .map_err(|error| format!("Failed to create plugin import directory: {error}"))?;

    let import_result = (|| {
        let mut manifest = extract_plugin_copy(package, &temp_root)?;
        let manifest_object = manifest
            .as_object_mut()
            .ok_or_else(|| "Local plugin manifest must be an object".to_string())?;
        manifest_object.insert("name".to_string(), Value::String(plugin_name.clone()));
        manifest_object.insert("version".to_string(), Value::String("0.1.0".to_string()));
        let interface = manifest_object
            .entry("interface")
            .or_insert_with(|| json!({}));
        let interface_object = interface
            .as_object_mut()
            .ok_or_else(|| "Local plugin manifest interface must be an object".to_string())?;
        interface_object.insert(
            "displayName".to_string(),
            Value::String(display_name.clone()),
        );
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Failed to serialize local plugin manifest: {error}"))?;
        fs::write(temp_root.join(".codex-plugin/plugin.json"), manifest_bytes)
            .map_err(|error| format!("Failed to write local plugin manifest: {error}"))?;

        let registry_path = copy_registry_path(&marketplace_root);
        let registry_bytes = updated_copy_registry(
            &registry_path,
            LocalPluginCopyRecord {
                local_plugin_name: plugin_name.clone(),
                source_plugin_id: options.source_plugin_id,
                source_release_id: options.source_release_id,
                source_plugin_name: options.source_plugin_name.clone(),
            },
        )?;
        let plugin_path = plugins_root.join(&plugin_name);
        fs::rename(&temp_root, &plugin_path)
            .map_err(|error| format!("Failed to install local plugin copy: {error}"))?;
        if let Err(error) = write_atomic_file(&registry_path, &registry_bytes) {
            let _ = fs::remove_dir_all(&plugin_path);
            return Err(error);
        }
        Ok(LocalPluginCopyImportResult {
            plugin_name,
            display_name,
            version: "0.1.0".to_string(),
            marketplace_path: marketplace_root.display().to_string(),
            plugin_path: plugin_path.display().to_string(),
        })
    })();
    if import_result.is_err() {
        let _ = fs::remove_dir_all(&temp_root);
    }
    import_result
}

fn download_plugin_copy(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Failed to prepare plugin download: {error}"))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("Failed to download plugin copy: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Plugin copy download failed: {error}"))?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_PLUGIN_PACKAGE_BYTES as u64)
    {
        return Err("Plugin ZIP exceeds 50 MB".to_string());
    }
    let mut package = Vec::new();
    response
        .take((MAX_PLUGIN_PACKAGE_BYTES + 1) as u64)
        .read_to_end(&mut package)
        .map_err(|error| format!("Failed to read plugin copy download: {error}"))?;
    if package.len() > MAX_PLUGIN_PACKAGE_BYTES {
        return Err("Plugin ZIP exceeds 50 MB".to_string());
    }
    Ok(package)
}

#[tauri::command]
pub async fn local_executor_import_plugin_copy(
    options: LocalPluginCopyImportOptions,
) -> Result<LocalPluginCopyImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let package = download_plugin_copy(&options.download_url)?;
        import_plugin_copy_package(Path::new(&options.marketplace_path), &package, &options)
    })
    .await
    .map_err(|error| format!("Failed to join plugin copy import task: {error}"))?
}

fn rollback_plugin_copy(marketplace_path: &Path, plugin_name: &str) -> Result<(), String> {
    let marketplace_root = marketplace_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
    let plugins_root = marketplace_root.join("plugins");
    let plugin_path = plugins_root.join(plugin_name);
    if plugin_name.is_empty()
        || plugin_name.contains('/')
        || plugin_name.contains('\\')
        || !plugin_name.ends_with("-copy") && !plugin_name.contains("-copy-")
    {
        return Err("Plugin copy name is invalid".to_string());
    }
    if plugin_path.exists() {
        let canonical = plugin_path
            .canonicalize()
            .map_err(|error| format!("Failed to resolve plugin copy: {error}"))?;
        if !canonical.starts_with(&plugins_root) {
            return Err("Plugin copy is outside the personal marketplace".to_string());
        }
        fs::remove_dir_all(&canonical)
            .map_err(|error| format!("Failed to remove plugin copy: {error}"))?;
    }
    let registry_path = copy_registry_path(&marketplace_root);
    if registry_path.is_file() {
        let bytes = fs::read(&registry_path)
            .map_err(|error| format!("Failed to read plugin copy registry: {error}"))?;
        let mut registry = serde_json::from_slice::<LocalPluginCopyRegistry>(&bytes)
            .map_err(|error| format!("Plugin copy registry is invalid: {error}"))?;
        registry
            .copies
            .retain(|copy| copy.local_plugin_name != plugin_name);
        let updated = serde_json::to_vec_pretty(&registry)
            .map_err(|error| format!("Failed to serialize plugin copy registry: {error}"))?;
        write_atomic_file(&registry_path, &updated)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn local_executor_rollback_plugin_copy(
    marketplace_path: String,
    plugin_name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        rollback_plugin_copy(Path::new(&marketplace_path), &plugin_name)
    })
    .await
    .map_err(|error| format!("Failed to join plugin copy rollback task: {error}"))?
}

fn link_local_plugin_release(
    marketplace_path: &Path,
    local_plugin_name: &str,
    cloud_plugin_id: i64,
    cloud_release_id: i64,
) -> Result<(), String> {
    if local_plugin_name.trim().is_empty()
        || local_plugin_name.contains('/')
        || local_plugin_name.contains('\\')
    {
        return Err("Local plugin name is invalid".to_string());
    }
    let marketplace_root = marketplace_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let _mutation_lock = acquire_plugin_mutation_lock(&marketplace_root)?;
    let plugin_root = marketplace_root.join("plugins").join(local_plugin_name);
    if !plugin_root.join(".codex-plugin/plugin.json").is_file() {
        return Err("Local plugin manifest is unavailable".to_string());
    }
    let registry_path = copy_registry_path(&marketplace_root);
    let mut registry = if registry_path.is_file() {
        serde_json::from_slice::<LocalPluginCopyRegistry>(
            &fs::read(&registry_path)
                .map_err(|error| format!("Failed to read plugin registry: {error}"))?,
        )
        .map_err(|error| format!("Plugin registry is invalid: {error}"))?
    } else {
        LocalPluginCopyRegistry::default()
    };
    registry
        .cloud_links
        .retain(|link| link.local_plugin_name != local_plugin_name);
    registry.cloud_links.push(LocalPluginCloudLink {
        local_plugin_name: local_plugin_name.to_string(),
        cloud_plugin_id,
        cloud_release_id,
    });
    let bytes = serde_json::to_vec_pretty(&registry)
        .map_err(|error| format!("Failed to serialize plugin registry: {error}"))?;
    write_atomic_file(&registry_path, &bytes)
}

#[tauri::command]
pub async fn local_executor_link_plugin_release(
    marketplace_path: String,
    local_plugin_name: String,
    cloud_plugin_id: i64,
    cloud_release_id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        link_local_plugin_release(
            Path::new(&marketplace_path),
            &local_plugin_name,
            cloud_plugin_id,
            cloud_release_id,
        )
    })
    .await
    .map_err(|error| format!("Failed to join plugin release linking task: {error}"))?
}

#[tauri::command]
pub async fn local_executor_import_external_content(
    options: ExternalContentImportOptions,
) -> Result<ExternalContentImportResult, String> {
    import_external_content(&options.source)
}

#[tauri::command]
pub async fn local_executor_copy_debug_info(text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Debug info must not be empty".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || write_text_to_native_clipboard(&text))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn local_executor_ensure_started(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
    proxy_url: Option<String>,
) -> Result<LocalExecutorStatus, String> {
    start_executor_if_needed(app.clone(), &state).await?;
    send_executor_request(
        app.clone(),
        &state,
        LocalExecutorRequest {
            method: "runtime.codex.runtime_config.update".to_string(),
            params: json!({"proxyUrl": proxy_url}),
        },
    )
    .await?;
    let startup = send_executor_request(
        app,
        &state,
        LocalExecutorRequest {
            method: "runtime.codex.ensure_started".to_string(),
            params: json!({}),
        },
    )
    .await?;
    if startup
        .get("started")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let elapsed_ms = startup.get("initializeElapsedMs").and_then(Value::as_u64);
        state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?
            .codex_initialize_elapsed_ms = elapsed_ms;
    }
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_connect_backend(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
    backend_url: String,
    socket_url: String,
    auth_token: String,
    runtime_auth_token: Option<String>,
) -> Result<LocalExecutorStatus, String> {
    let backend_url = normalize_command_arg(backend_url, "backend_url")?;
    let socket_url = normalize_command_arg(socket_url, "socket_url")?;
    let auth_token = normalize_command_arg(auth_token, "auth_token")?;
    let runtime_auth_token = normalize_optional_command_arg(runtime_auth_token);
    let _guard = state.backend_connection_lock.lock().await;
    let (config_path, config_existed, previous_config) = snapshot_codex_shell_environment_config()?;
    write_codex_shell_environment_value(
        WEGENT_RUNTIME_AUTH_TOKEN_ENV,
        runtime_auth_token.as_deref(),
    )?;
    log::info!(
        "Local executor backend connection update requested: connected=true, backend_url={backend_url}, socket_url={socket_url}"
    );
    let configure_result = send_executor_request(
        app.clone(),
        &state,
        LocalExecutorRequest {
            method: "executor.backend.configure".to_string(),
            params: json!({
                "backend_url": backend_url.clone(),
                "socket_url": socket_url.clone(),
                "auth_token": auth_token.clone(),
                "runtime_auth_token": runtime_auth_token.clone(),
            }),
        },
    )
    .await;
    if let Err(error) = configure_result {
        restore_codex_shell_environment_config(&config_path, config_existed, &previous_config)
            .map_err(|restore_error| format!("{error}; {restore_error}"))?;
        return Err(error);
    }
    let changed = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        replace_backend_connection(
            &mut inner,
            Some(LocalExecutorBackendConnection {
                backend_url,
                socket_url,
                auth_token,
                runtime_auth_token,
            }),
        )
    };
    log::info!(
        "Local executor backend connection updated in process: connected=true, changed={changed}"
    );
    status_from_state(&state)
}

#[tauri::command]
pub async fn local_executor_disconnect_backend(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
) -> Result<LocalExecutorStatus, String> {
    let _guard = state.backend_connection_lock.lock().await;
    let (config_path, config_existed, previous_config) = snapshot_codex_shell_environment_config()?;
    write_codex_shell_environment_value(WEGENT_RUNTIME_AUTH_TOKEN_ENV, None)?;
    log::info!("Local executor backend connection update requested: connected=false");
    let configure_result = send_executor_request(
        app.clone(),
        &state,
        LocalExecutorRequest {
            method: "executor.backend.configure".to_string(),
            params: json!({
                "backend_url": Value::Null,
                "auth_token": Value::Null,
            }),
        },
    )
    .await;
    if let Err(error) = configure_result {
        restore_codex_shell_environment_config(&config_path, config_existed, &previous_config)
            .map_err(|restore_error| format!("{error}; {restore_error}"))?;
        return Err(error);
    }
    let changed = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Failed to lock local executor state".to_string())?;
        replace_backend_connection(&mut inner, None)
    };
    log::info!(
        "Local executor backend connection updated in process: connected=false, changed={changed}"
    );
    status_from_state(&state)
}

fn replace_backend_connection(
    inner: &mut LocalExecutorInner,
    connection: Option<LocalExecutorBackendConnection>,
) -> bool {
    if inner.backend_connection == connection {
        return false;
    }
    inner.backend_connection = connection;
    true
}

#[tauri::command]
pub async fn local_executor_request(
    app: tauri::AppHandle,
    state: State<'_, LocalExecutorState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    send_executor_request(app, &state, LocalExecutorRequest { method, params }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::process::Stdio;
    use std::sync::{Mutex as TestMutex, MutexGuard, OnceLock};
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<TestMutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| TestMutex::new(()))
            .lock()
            .expect("env lock should be available")
    }

    fn restore_env(key: &str, value: Option<OsString>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn packages_a_personal_codex_plugin_without_manual_zip_selection() {
        let root = import_test_root("package-plugin");
        let plugin_root = root.join("plugins/gitlab");
        fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
        fs::create_dir_all(plugin_root.join("skills/review")).unwrap();
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"gitlab","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(plugin_root.join("skills/review/SKILL.md"), "# Review").unwrap();

        let package = package_local_plugin(&root, "gitlab").unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package.bytes)).unwrap();

        assert_eq!(package.name, "gitlab.zip");
        assert!(archive.by_name(".codex-plugin/plugin.json").is_ok());
        assert!(archive.by_name("skills/review/SKILL.md").is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_plugin_connectors_from_a_marketplace_manifest_path() {
        let root = import_test_root("read-plugin-manifest");
        let marketplace_manifest = root.join(".agents/plugins/marketplace.json");
        let plugin_manifest = root.join("plugins/browser-auth/.codex-plugin/plugin.json");
        fs::create_dir_all(marketplace_manifest.parent().unwrap()).unwrap();
        fs::create_dir_all(plugin_manifest.parent().unwrap()).unwrap();
        fs::write(
            &marketplace_manifest,
            r#"{"name":"local","plugins":[{"name":"browser-auth","source":{"source":"local","path":"./plugins/browser-auth"}}]}"#,
        )
        .unwrap();
        fs::write(
            plugin_manifest,
            r#"{"name":"browser-auth","version":"1.0.0","connectors":[{"slug":"browser-auth","authPolicy":"on_install","localAuth":{"kind":"browser_oauth","health":["auth","health"],"start":["auth","login"]}}]}"#,
        )
        .unwrap();

        let manifest = read_local_plugin_manifest(&marketplace_manifest, "browser-auth").unwrap();

        assert_eq!(manifest["connectors"][0]["slug"], "browser-auth");
        assert_eq!(
            manifest["connectors"][0]["localAuth"]["kind"],
            "browser_oauth"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn packages_codex_personal_marketplace_plugins_outside_agents_dir() {
        let root = import_test_root("package-codex-personal");
        let agents = root.join(".agents");
        let plugin_root = root.join("plugins/dev-tools");
        fs::create_dir_all(agents.join("plugins")).unwrap();
        fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
        fs::create_dir_all(plugin_root.join("skills/ip")).unwrap();
        fs::write(
            agents.join("plugins/marketplace.json"),
            r#"{"name":"personal","plugins":[{"name":"dev-tools","source":{"source":"local","path":"./plugins/dev-tools"}}]}"#,
        )
        .unwrap();
        fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            r#"{"name":"dev-tools","version":"0.1.0"}"#,
        )
        .unwrap();
        fs::write(plugin_root.join("skills/ip/SKILL.md"), "# IP").unwrap();

        // Codex reports the personal marketplace path as ~/.agents while plugin
        // sources live under ~/plugins relative to the marketplace root.
        let package = package_local_plugin(&agents, "dev-tools").unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package.bytes)).unwrap();
        assert_eq!(package.name, "dev-tools.zip");
        assert!(archive.by_name(".codex-plugin/plugin.json").is_ok());
        assert!(archive.by_name("skills/ip/SKILL.md").is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrates_codex_personal_plugin_into_wework_personal_marketplace() {
        let root = import_test_root("migrate-personal-plugin");
        let source_home = root.join("home");
        let agents = source_home.join(".agents");
        let source_plugin = source_home.join("plugins/dev-tools");
        let destination = root.join("wework-personal");
        fs::create_dir_all(agents.join("plugins")).unwrap();
        fs::create_dir_all(source_plugin.join(".codex-plugin")).unwrap();
        fs::create_dir_all(source_plugin.join("skills/ip")).unwrap();
        fs::create_dir_all(destination.join(".agents/plugins")).unwrap();
        fs::create_dir_all(destination.join(".claude-plugin")).unwrap();
        fs::write(
            agents.join("plugins/marketplace.json"),
            r#"{"name":"personal","plugins":[{"name":"dev-tools","source":{"source":"local","path":"./plugins/dev-tools"}}]}"#,
        )
        .unwrap();
        fs::write(
            source_plugin.join(".codex-plugin/plugin.json"),
            r#"{"name":"dev-tools","version":"0.1.0"}"#,
        )
        .unwrap();
        fs::write(source_plugin.join("skills/ip/SKILL.md"), "# IP").unwrap();
        fs::write(
            destination.join(".agents/plugins/marketplace.json"),
            r#"{"name":"wework-personal","interface":{"displayName":"WeWork Personal Marketplace"},"plugins":[]}"#,
        )
        .unwrap();
        fs::write(
            destination.join(".claude-plugin/marketplace.json"),
            r#"{"name":"wework-personal","interface":{"displayName":"WeWork Personal Marketplace"},"plugins":[]}"#,
        )
        .unwrap();

        let first =
            ensure_plugin_in_personal_marketplace(&agents, &destination, "dev-tools").unwrap();
        assert!(first.migrated);
        assert!(destination
            .join("plugins/dev-tools/.codex-plugin/plugin.json")
            .is_file());
        assert!(destination
            .join("plugins/dev-tools/skills/ip/SKILL.md")
            .is_file());
        let agents_manifest: Value = serde_json::from_str(
            &fs::read_to_string(destination.join(".agents/plugins/marketplace.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            agents_manifest["plugins"][0]["name"].as_str(),
            Some("dev-tools")
        );

        let second =
            ensure_plugin_in_personal_marketplace(&agents, &destination, "dev-tools").unwrap();
        assert!(!second.migrated);
        assert_eq!(first.plugin_path, second.plugin_path);

        let package = package_local_plugin(&destination, "dev-tools").unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package.bytes)).unwrap();
        assert!(archive.by_name("skills/ip/SKILL.md").is_ok());
        let _ = fs::remove_dir_all(root);
    }

    fn plugin_copy_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (path, contents) in entries {
            archive.start_file(*path, options).unwrap();
            archive.write_all(contents).unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    fn valid_plugin_copy_zip() -> Vec<u8> {
        plugin_copy_zip(&[
            (
                ".codex-plugin/plugin.json",
                br#"{"name":"source-plugin","version":"2.0.0","interface":{"displayName":"Source Plugin"}}"#,
            ),
            ("skills/review/SKILL.md", b"# Review"),
        ])
    }

    fn plugin_copy_options(
        package: &[u8],
        marketplace_path: &Path,
    ) -> LocalPluginCopyImportOptions {
        LocalPluginCopyImportOptions {
            marketplace_path: marketplace_path.display().to_string(),
            download_url: "https://objects.example/plugin.zip".to_string(),
            sha256: format!("{:x}", Sha256::digest(package)),
            source_plugin_id: 41,
            source_release_id: 52,
            source_plugin_name: "source-plugin".to_string(),
            source_display_name: "Source Plugin".to_string(),
        }
    }

    #[test]
    fn imports_plugin_copy_with_rewritten_manifest_and_provenance() {
        let root = import_test_root("plugin-copy");
        let package = valid_plugin_copy_zip();
        let options = plugin_copy_options(&package, &root);

        let imported = import_plugin_copy_package(&root, &package, &options).unwrap();

        assert_eq!(imported.plugin_name, "source-plugin-copy");
        assert_eq!(imported.version, "0.1.0");
        let manifest: Value = serde_json::from_slice(
            &fs::read(root.join("plugins/source-plugin-copy/.codex-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], "source-plugin-copy");
        assert_eq!(manifest["version"], "0.1.0");
        assert_eq!(
            manifest["interface"]["displayName"],
            "Source Plugin · 我的副本"
        );
        let registry: LocalPluginCopyRegistry = serde_json::from_slice(
            &fs::read(root.join(".wegent/plugin-copy-sources.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(registry.copies.len(), 1);
        assert_eq!(registry.copies[0].source_plugin_id, 41);
        link_local_plugin_release(&root, &imported.plugin_name, 71, 82).unwrap();
        let linked: LocalPluginCopyRegistry = serde_json::from_slice(
            &fs::read(root.join(".wegent/plugin-copy-sources.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(linked.cloud_links.len(), 1);
        assert_eq!(linked.cloud_links[0].cloud_plugin_id, 71);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_copy_import_uses_unique_names() {
        let root = import_test_root("plugin-copy-unique");
        let package = valid_plugin_copy_zip();
        let options = plugin_copy_options(&package, &root);

        let first = import_plugin_copy_package(&root, &package, &options).unwrap();
        let second = import_plugin_copy_package(&root, &package, &options).unwrap();

        assert_eq!(first.plugin_name, "source-plugin-copy");
        assert_eq!(second.plugin_name, "source-plugin-copy-2");
        assert!(root.join("plugins/source-plugin-copy-2").is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn concurrent_plugin_copy_mutations_preserve_registry_entries() {
        let root = import_test_root("plugin-copy-concurrent");
        let package = valid_plugin_copy_zip();
        let mut imports = Vec::new();
        for source_plugin_id in 1..=4 {
            let root = root.clone();
            let package = package.clone();
            imports.push(std::thread::spawn(move || {
                let mut options = plugin_copy_options(&package, &root);
                options.source_plugin_id = source_plugin_id;
                import_plugin_copy_package(&root, &package, &options).unwrap()
            }));
        }
        let imported = imports
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();

        let mut links = Vec::new();
        for (index, plugin) in imported.iter().enumerate() {
            let root = root.clone();
            let plugin_name = plugin.plugin_name.clone();
            links.push(std::thread::spawn(move || {
                link_local_plugin_release(
                    &root,
                    &plugin_name,
                    100 + index as i64,
                    200 + index as i64,
                )
                .unwrap();
            }));
        }
        for link in links {
            link.join().unwrap();
        }

        let registry: LocalPluginCopyRegistry = serde_json::from_slice(
            &fs::read(root.join(".wegent/plugin-copy-sources.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(registry.copies.len(), 4);
        assert_eq!(registry.cloud_links.len(), 4);
        assert_eq!(
            fs::read_dir(root.join("plugins"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .count(),
            4
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_copy_import_rejects_checksum_mismatch_without_partial_files() {
        let root = import_test_root("plugin-copy-checksum");
        let package = valid_plugin_copy_zip();
        let mut options = plugin_copy_options(&package, &root);
        options.sha256 = "0".repeat(64);

        let error = import_plugin_copy_package(&root, &package, &options).unwrap_err();

        assert!(error.contains("checksum mismatch"));
        assert!(!root.exists());
    }

    #[test]
    fn plugin_copy_import_rejects_path_traversal_and_duplicate_entries() {
        use base64::Engine;
        let duplicate_package = base64::engine::general_purpose::STANDARD
            .decode("UEsDBBQAAAAAAAOO/VyYNCpDKgAAACoAAAAZAAAALmNvZGV4LXBsdWdpbi9wbHVnaW4uanNvbnsibmFtZSI6InNvdXJjZS1wbHVnaW4iLCJ2ZXJzaW9uIjoiMS4wLjAifVBLAwQUAAAAAAADjv1cV+5xkgUAAAAFAAAAFgAAAHNraWxscy9yZXZpZXcvU0tJTEwubWRmaXJzdFBLAwQUAAAAAAADjv1caREftgYAAAAGAAAAFgAAAHNraWxscy9yZXZpZXcvU0tJTEwubWRzZWNvbmRQSwECFAMUAAAAAAADjv1cmDQqQyoAAAAqAAAAGQAAAAAAAAAAAAAAgAEAAAAALmNvZGV4LXBsdWdpbi9wbHVnaW4uanNvblBLAQIUAxQAAAAAAAOO/VxX7nGSBQAAAAUAAAAWAAAAAAAAAAAAAACAAWEAAABza2lsbHMvcmV2aWV3L1NLSUxMLm1kUEsBAhQDFAAAAAAAA479XGkRH7YGAAAABgAAABYAAAAAAAAAAAAAAIABmgAAAHNraWxscy9yZXZpZXcvU0tJTEwubWRQSwUGAAAAAAMAAwDPAAAA1AAAAAAA")
            .unwrap();
        for (label, package, expected) in [
            (
                "traversal",
                plugin_copy_zip(&[
                    (
                        ".codex-plugin/plugin.json",
                        br#"{"name":"source-plugin","version":"1.0.0"}"#,
                    ),
                    ("../escape", b"escape"),
                ]),
                "unsafe path",
            ),
            ("duplicate", duplicate_package, "duplicate path"),
        ] {
            let root = import_test_root(&format!("plugin-copy-{label}"));
            let options = plugin_copy_options(&package, &root);

            let error = import_plugin_copy_package(&root, &package, &options).unwrap_err();

            assert!(error.contains(expected), "unexpected error: {error}");
            assert!(
                fs::read_dir(root.join("plugins"))
                    .map(|mut entries| entries.next().is_none())
                    .unwrap_or(true),
                "failed imports must not leave a plugin directory"
            );
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn plugin_copy_import_rejects_invalid_manifest_and_rollback_removes_mapping() {
        let root = import_test_root("plugin-copy-invalid");
        let invalid =
            plugin_copy_zip(&[(".codex-plugin/plugin.json", br#"{"name":"source-plugin"}"#)]);
        let invalid_options = plugin_copy_options(&invalid, &root);
        let error = import_plugin_copy_package(&root, &invalid, &invalid_options).unwrap_err();
        assert!(error.contains("requires string name and version"));
        assert!(fs::read_dir(root.join("plugins"))
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true));

        let package = valid_plugin_copy_zip();
        let options = plugin_copy_options(&package, &root);
        let imported = import_plugin_copy_package(&root, &package, &options).unwrap();
        rollback_plugin_copy(&root, &imported.plugin_name).unwrap();
        assert!(!root.join("plugins/source-plugin-copy").exists());
        let registry: LocalPluginCopyRegistry = serde_json::from_slice(
            &fs::read(root.join(".wegent/plugin-copy-sources.json")).unwrap(),
        )
        .unwrap();
        assert!(registry.copies.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    fn import_test_root(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "wework-import-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn parses_success_response_line() {
        let line = r#"{"type":"response","id":"req-1","ok":true,"result":{"value":1}}"#;
        let message = parse_executor_line(line).expect("line should parse");

        match message {
            ExecutorLine::Response(response) => assert_eq!(response.id, "req-1"),
            ExecutorLine::Event(_) => panic!("expected response line"),
        }
    }

    #[test]
    fn parses_event_line() {
        let line =
            r#"{"type":"event","event":"response.completed","payload":{"localTaskId":"task-1"}}"#;
        let message = parse_executor_line(line).expect("line should parse");

        assert!(matches!(message, ExecutorLine::Event(_)));
    }

    #[test]
    fn stderr_output_uses_diagnostic_label_in_app_logs() {
        let label = LocalExecutorOutputStream::Stderr.log_label();

        assert_eq!(label, "Local executor diagnostic");
        assert!(!label.contains("stderr"));
    }

    #[test]
    fn codex_local_config_remote_apps_reports_missing_or_false_as_disabled() {
        assert!(!read_remote_apps_enabled_from_config(""));
        assert!(!read_remote_apps_enabled_from_config("[features]\n"));
        assert!(!read_remote_apps_enabled_from_config(
            "[features]\napps = false\n"
        ));
        assert!(!read_remote_apps_enabled_from_config(
            "[other]\napps = true\n"
        ));
    }

    #[test]
    fn codex_home_initialization_defaults_remote_apps_to_enabled() {
        let options: CodexHomeInitializeOptions =
            serde_json::from_value(serde_json::json!({ "migrateNativeHome": true })).unwrap();

        assert!(options.remote_apps_enabled);
    }

    #[test]
    fn initializes_empty_bundled_plugin_marketplace_idempotently() {
        let root = import_test_root("bundled-plugin-marketplace");
        let source = root.join("source");
        let destination = root.join("destination/wework-personal");
        fs::create_dir_all(source.join(".agents/plugins")).unwrap();
        fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        fs::write(
            source.join(".agents/plugins/marketplace.json"),
            r#"{"name":"wework-personal","plugins":[]}"#,
        )
        .unwrap();
        fs::write(
            source.join(".claude-plugin/marketplace.json"),
            r#"{"name":"wework-personal","plugins":[]}"#,
        )
        .unwrap();

        let first =
            initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();
        fs::write(destination.join("stale.txt"), "stale").unwrap();
        let second =
            initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

        assert_eq!(first.id, WEWORK_PERSONAL_MARKETPLACE_ID);
        assert_eq!(first.plugin_count, 0);
        assert_eq!(first.path, second.path);
        assert!(destination
            .join(".agents/plugins/marketplace.json")
            .is_file());
        assert!(destination
            .join(".claude-plugin/marketplace.json")
            .is_file());
        assert!(!destination.join("stale.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_mismatched_bundled_plugin_marketplaces_before_replacing_destination() {
        let root = import_test_root("bundled-plugin-marketplace-mismatch");
        let source = root.join("source");
        let destination = root.join("destination/wework-personal");
        fs::create_dir_all(source.join(".agents/plugins")).unwrap();
        fs::create_dir_all(source.join(".claude-plugin")).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("existing.txt"), "existing").unwrap();
        fs::write(
            source.join(".agents/plugins/marketplace.json"),
            r#"{"name":"wework-personal","plugins":[{"name":"codex-only"}]}"#,
        )
        .unwrap();
        fs::write(
            source.join(".claude-plugin/marketplace.json"),
            r#"{"name":"wework-personal","plugins":[]}"#,
        )
        .unwrap();

        let error = initialize_bundled_plugin_marketplace_from_paths(&source, &destination)
            .expect_err("mismatched marketplaces should fail");

        assert!(error.contains("plugin names must match"));
        assert_eq!(
            fs::read_to_string(destination.join("existing.txt")).unwrap(),
            "existing"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn imports_codex_initialization_content_again() {
        let root = import_test_root("codex");
        let home = root.join("home");
        let destination = root.join("destination");
        fs::create_dir_all(home.join(".codex/skills/example")).unwrap();
        fs::write(home.join(".codex/config.toml"), "model = \"gpt-5\"").unwrap();
        fs::write(home.join(".codex/skills/example/SKILL.md"), "example").unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("config.toml"), "old").unwrap();

        let result = import_external_content_from_paths("codex", &home, &destination).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("config.toml")).unwrap(),
            "model = \"gpt-5\""
        );
        assert!(destination.join("skills/example/SKILL.md").is_file());
        assert_eq!(result.imported_entries, vec!["config.toml", "skills"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn maps_claude_instructions_and_skills_to_codex_content() {
        let root = import_test_root("claude");
        let home = root.join("home");
        let destination = root.join("destination");
        fs::create_dir_all(home.join(".claude/skills/example")).unwrap();
        fs::write(home.join(".claude/CLAUDE.md"), "Claude instructions").unwrap();
        fs::write(home.join(".claude/skills/example/SKILL.md"), "example").unwrap();

        let result =
            import_external_content_from_paths("claude-code", &home, &destination).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("AGENTS.md")).unwrap(),
            "Claude instructions"
        );
        assert!(destination.join("skills/example/SKILL.md").is_file());
        assert_eq!(result.imported_entries, vec!["CLAUDE.md", "skills"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_local_config_remote_apps_reads_features_section() {
        let content = r#"
model = "gpt-5.5"

[features]
apps = true # enables remote apps

[projects."/tmp/example"]
trust_level = "trusted"
"#;

        assert!(read_remote_apps_enabled_from_config(content));
    }

    #[test]
    fn codex_local_config_remote_apps_updates_existing_value() {
        let content = r#"
model = "gpt-5.5"

[features]
  apps = true
shell_environment_policy = "inherit"
"#;

        let next = set_remote_apps_enabled_in_config(content, false);

        assert!(next.contains("[features]\n  apps = false\nshell_environment_policy"));
        assert!(next.contains("model = \"gpt-5.5\""));
    }

    #[test]
    fn codex_local_config_remote_apps_inserts_features_section() {
        let next = set_remote_apps_enabled_in_config("model = \"gpt-5.5\"\n", true);

        assert_eq!(next, "model = \"gpt-5.5\"\n\n[features]\napps = true\n");
    }

    #[test]
    fn codex_local_config_remote_apps_adds_to_existing_features_section() {
        let content = r#"
[features]
shell_environment_policy = "inherit"

[mcp_servers.example]
command = "example"
"#;

        let next = set_remote_apps_enabled_in_config(content, true);

        assert!(next.contains("[features]\napps = true\nshell_environment_policy"));
        assert!(next.contains("[mcp_servers.example]\ncommand = \"example\""));
    }

    #[test]
    fn codex_local_config_backend_auth_token_updates_shell_environment() {
        let content = r#"
model = "gpt-5.5"

[shell_environment_policy.set]
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"
WEGENT_RUNTIME_AUTH_TOKEN = "old"

[projects."/tmp/example"]
trust_level = "trusted"
"#;

        let next = set_shell_environment_value_in_config(
            content,
            WEGENT_RUNTIME_AUTH_TOKEN_ENV,
            Some("runtime-task-token"),
        );

        assert!(next.contains("WEGENT_RUNTIME_AUTH_TOKEN = \"runtime-task-token\""));
        assert!(next.contains("BROWSER_USE_AVAILABLE_BACKENDS = \"chrome,iab\""));
        assert!(next.contains("[projects.\"/tmp/example\"]\ntrust_level = \"trusted\""));
    }

    #[test]
    fn codex_local_config_backend_auth_token_removes_stale_shell_environment_value() {
        let content = r#"
[shell_environment_policy.set]
WEGENT_RUNTIME_AUTH_TOKEN = "runtime-task-token"
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"
"#;

        let next =
            set_shell_environment_value_in_config(content, WEGENT_RUNTIME_AUTH_TOKEN_ENV, None);

        assert!(!next.contains("WEGENT_RUNTIME_AUTH_TOKEN"));
        assert!(next.contains("BROWSER_USE_AVAILABLE_BACKENDS = \"chrome,iab\""));
    }

    #[test]
    fn bundled_sidecar_path_uses_bundled_executable_name() {
        let _guard = env_lock();
        let previous_sidecar = std::env::var_os(LOCAL_EXECUTOR_SIDECAR_ENV);
        std::env::remove_var(LOCAL_EXECUTOR_SIDECAR_ENV);

        let (source, path) = sidecar_source_and_path();
        restore_env(LOCAL_EXECUTOR_SIDECAR_ENV, previous_sidecar);

        assert_eq!(source, "bundled");
        assert_eq!(path, "wegent-executor");
    }

    #[cfg(unix)]
    #[test]
    fn links_native_codex_auth_into_isolated_home() {
        let root = import_test_root("codex-auth-link");
        let native_home = root.join("native");
        let wework_home = root.join("wework");
        fs::create_dir_all(&native_home).unwrap();
        fs::write(native_home.join("auth.json"), "native-auth").unwrap();

        link_native_codex_auth(&native_home, &wework_home).unwrap();

        let target = wework_home.join("auth.json");
        assert!(fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(target).unwrap(), "native-auth");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn migrating_codex_home_preserves_linked_native_auth() {
        let root = import_test_root("codex-auth-migration");
        let native_home = root.join("native");
        let wework_home = root.join("wework");
        fs::create_dir_all(&native_home).unwrap();
        fs::write(native_home.join("auth.json"), "native-auth").unwrap();
        fs::write(native_home.join("config.toml"), "model = \"gpt-5\"").unwrap();
        link_native_codex_auth(&native_home, &wework_home).unwrap();

        copy_codex_initialization_files(&native_home, &wework_home).unwrap();

        assert_eq!(
            fs::read_to_string(native_home.join("auth.json")).unwrap(),
            "native-auth"
        );
        assert!(fs::symlink_metadata(wework_home.join("auth.json"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(wework_home.join("config.toml")).unwrap(),
            "model = \"gpt-5\""
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn replaces_stale_isolated_codex_auth_link() {
        let root = import_test_root("codex-auth-stale-link");
        let native_home = root.join("native");
        let wework_home = root.join("wework");
        fs::create_dir_all(&native_home).unwrap();
        fs::create_dir_all(&wework_home).unwrap();
        fs::write(native_home.join("auth.json"), "current-auth").unwrap();
        std::os::unix::fs::symlink(
            root.join("missing-auth.json"),
            wework_home.join("auth.json"),
        )
        .unwrap();

        link_native_codex_auth(&native_home, &wework_home).unwrap();

        assert_eq!(
            fs::read_to_string(wework_home.join("auth.json")).unwrap(),
            "current-auth"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_existing_isolated_codex_auth_file() {
        let root = import_test_root("codex-auth-existing");
        let native_home = root.join("native");
        let wework_home = root.join("wework");
        fs::create_dir_all(&native_home).unwrap();
        fs::create_dir_all(&wework_home).unwrap();
        fs::write(native_home.join("auth.json"), "native-auth").unwrap();
        fs::write(wework_home.join("auth.json"), "isolated-auth").unwrap();

        link_native_codex_auth(&native_home, &wework_home).unwrap();

        assert_eq!(
            fs::read_to_string(wework_home.join("auth.json")).unwrap(),
            "isolated-auth"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skips_codex_auth_link_when_native_auth_is_missing() {
        let root = import_test_root("codex-auth-missing");
        let native_home = root.join("native");
        let wework_home = root.join("wework");

        link_native_codex_auth(&native_home, &wework_home).unwrap();

        assert!(!wework_home.join("auth.json").exists());
    }

    #[test]
    fn executor_isolation_override_controls_runtime_home() {
        let _guard = env_lock();
        let previous_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
        let previous_override = std::env::var_os(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV);
        let previous_shared_home = std::env::var_os(LOCAL_EXECUTOR_SHARED_HOME_ENV);
        let home = PathBuf::from("/tmp/wework-isolation-override");
        std::env::set_var(LOCAL_EXECUTOR_HOME_ENV, &home);
        std::env::remove_var(LOCAL_EXECUTOR_SHARED_HOME_ENV);

        std::env::remove_var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV);
        assert_eq!(
            local_executor_isolation_enabled().expect("default isolation should resolve"),
            cfg!(debug_assertions)
        );

        std::env::set_var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, "true");
        assert_eq!(
            local_executor_runtime_home_path().expect("isolated home should resolve"),
            home.join(LOCAL_EXECUTOR_RUNTIME_DIR_NAME)
                .join(local_executor_instance_name())
        );

        std::env::set_var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, "false");
        assert_eq!(
            local_executor_runtime_home_path().expect("shared home should resolve"),
            home
        );

        restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_home);
        restore_env(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, previous_override);
        restore_env(LOCAL_EXECUTOR_SHARED_HOME_ENV, previous_shared_home);
    }

    #[test]
    fn executor_isolation_override_rejects_invalid_values() {
        let _guard = env_lock();
        let previous_override = std::env::var_os(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV);
        std::env::set_var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, "sometimes");

        let error = local_executor_isolation_enabled().expect_err("invalid override should fail");

        restore_env(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, previous_override);
        assert_eq!(
            error,
            "WEWORK_EXECUTOR_ISOLATION_OVERRIDE must be true or false, got \"sometimes\""
        );
    }

    #[test]
    fn local_executor_log_path_follows_build_mode() {
        let _guard = env_lock();
        let previous_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
        let previous_log_dir = std::env::var_os(LOCAL_EXECUTOR_LOG_DIR_ENV);
        std::env::set_var(LOCAL_EXECUTOR_HOME_ENV, "/tmp/wegent-executor-debug");
        std::env::remove_var(LOCAL_EXECUTOR_LOG_DIR_ENV);

        let path = local_executor_log_path().expect("log path should resolve");
        restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_home);
        restore_env(LOCAL_EXECUTOR_LOG_DIR_ENV, previous_log_dir);

        if cfg!(debug_assertions) {
            assert!(path.starts_with("/tmp/wegent-executor-debug/app-runtime"));
        } else {
            assert_eq!(
                path,
                PathBuf::from("/tmp/wegent-executor-debug/logs/executor.log")
            );
        }
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("executor.log")
        );
    }

    #[cfg(unix)]
    #[test]
    fn branded_executor_home_stays_under_shared_root() {
        let home = Path::new("/tmp/wework-test-home");

        assert_eq!(
            default_local_executor_home_path(home, None),
            PathBuf::from("/tmp/wework-test-home/.wework")
        );
        assert_eq!(
            default_local_executor_home_path(home, Some("com.example.demo-wework")),
            PathBuf::from("/tmp/wework-test-home/.wework/apps/com.example.demo-wework")
        );
    }

    #[test]
    fn migrates_legacy_executor_homes_into_wework_home() {
        let home = import_test_root("legacy-executor-home");
        let current_legacy_home = home.join(LEGACY_EXECUTOR_HOME_DIR);
        let wecode_legacy_home = home
            .join(LEGACY_WECODE_HOME_DIR)
            .join(LEGACY_EXECUTOR_HOME_DIR);
        fs::create_dir_all(current_legacy_home.join("workspace/chats")).unwrap();
        fs::create_dir_all(wecode_legacy_home.join("capabilities")).unwrap();
        fs::write(
            current_legacy_home.join("device-config.json"),
            "{\"device_id\":\"current-device\"}",
        )
        .unwrap();
        fs::write(
            current_legacy_home.join("workspace/chats/current.md"),
            "current",
        )
        .unwrap();
        fs::write(wecode_legacy_home.join("capabilities/legacy.md"), "legacy").unwrap();

        migrate_legacy_executor_homes(&home).unwrap();

        let destination = home.join(WEWORK_HOME_DIR);
        assert_eq!(
            fs::read_to_string(destination.join("device-config.json")).unwrap(),
            "{\"device_id\":\"current-device\"}"
        );
        assert_eq!(
            fs::read_to_string(destination.join("workspace/chats/current.md")).unwrap(),
            "current"
        );
        assert_eq!(
            fs::read_to_string(destination.join("capabilities/legacy.md")).unwrap(),
            "legacy"
        );
        assert!(!current_legacy_home.exists());
        assert!(!wecode_legacy_home.exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn preserves_conflicting_legacy_entries_without_using_legacy_home() {
        let home = import_test_root("legacy-executor-conflict");
        let destination = home.join(WEWORK_HOME_DIR);
        let legacy_home = home.join(LEGACY_EXECUTOR_HOME_DIR);
        fs::create_dir_all(&destination).unwrap();
        fs::create_dir_all(&legacy_home).unwrap();
        fs::write(destination.join("device-config.json"), "current").unwrap();
        fs::write(legacy_home.join("device-config.json"), "legacy").unwrap();

        migrate_legacy_executor_homes(&home).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("device-config.json")).unwrap(),
            "current"
        );
        assert_eq!(
            fs::read_to_string(
                destination
                    .join(LEGACY_MIGRATION_CONFLICTS_DIR)
                    .join(LEGACY_EXECUTOR_HOME_DIR)
                    .join("device-config.json")
            )
            .unwrap(),
            "legacy"
        );
        assert!(!legacy_home.exists());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn ignores_non_directory_legacy_executor_home() {
        let home = import_test_root("non-directory-legacy-executor-home");
        let legacy_home = home.join(LEGACY_EXECUTOR_HOME_DIR);
        fs::create_dir_all(&home).unwrap();
        fs::write(&legacy_home, "not a directory").unwrap();

        migrate_legacy_executor_homes(&home).unwrap();

        assert_eq!(fs::read_to_string(&legacy_home).unwrap(), "not a directory");
        assert!(!home.join(WEWORK_HOME_DIR).exists());
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn migrates_legacy_executor_directory_symlink_into_wework_home() {
        let home = import_test_root("linked-legacy-executor-home");
        let linked_target = import_test_root("linked-legacy-executor-target");
        let legacy_home = home.join(LEGACY_EXECUTOR_HOME_DIR);
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(linked_target.join("workspace/chats")).unwrap();
        fs::write(linked_target.join("workspace/chats/current.md"), "current").unwrap();
        std::os::unix::fs::symlink(&linked_target, &legacy_home).unwrap();

        migrate_legacy_executor_homes(&home).unwrap();

        let destination = home.join(WEWORK_HOME_DIR);
        assert_eq!(
            fs::read_to_string(destination.join("workspace/chats/current.md")).unwrap(),
            "current"
        );
        assert!(fs::symlink_metadata(&destination).unwrap().is_dir());
        assert!(!fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(&legacy_home).is_err());
        assert!(linked_target.is_dir());
        assert!(fs::read_dir(&linked_target).unwrap().next().is_none());
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(linked_target);
    }

    #[cfg(unix)]
    #[test]
    fn default_runtime_home_and_log_paths_follow_build_mode() {
        let _guard = env_lock();
        let previous_home = std::env::var_os("HOME");
        let previous_executor_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
        let previous_log_dir = std::env::var_os(LOCAL_EXECUTOR_LOG_DIR_ENV);
        std::env::set_var("HOME", "/tmp/wework-test-home");
        std::env::remove_var(LOCAL_EXECUTOR_HOME_ENV);
        std::env::remove_var(LOCAL_EXECUTOR_LOG_DIR_ENV);

        let home = local_executor_home_path().expect("executor home should resolve");
        let log = local_executor_log_path().expect("log path should resolve");

        restore_env("HOME", previous_home);
        restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_executor_home);
        restore_env(LOCAL_EXECUTOR_LOG_DIR_ENV, previous_log_dir);

        assert_eq!(
            home,
            default_local_executor_home_path(
                Path::new("/tmp/wework-test-home"),
                LOCAL_EXECUTOR_NAMESPACE,
            )
        );
        if cfg!(debug_assertions) {
            assert_eq!(
                log,
                home.join(LOCAL_EXECUTOR_RUNTIME_DIR_NAME)
                    .join(local_executor_instance_name())
                    .join("logs")
                    .join(LOCAL_EXECUTOR_LOG_FILE_NAME)
            );
        } else {
            assert_eq!(log, home.join("logs").join(LOCAL_EXECUTOR_LOG_FILE_NAME));
        }
    }

    #[test]
    fn read_local_executor_log_tail_limits_content() {
        let dir = std::env::temp_dir().join(format!(
            "wework-local-executor-log-tail-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("logs")).expect("test log dir should be created");
        let log_path = dir.join("logs").join("executor.log");
        fs::write(&log_path, "old log line\nrecent executor failure\n")
            .expect("test log should be written");

        let log = read_local_executor_log_tail(&log_path, 24).expect("log should be read");

        assert!(log.truncated);
        assert_eq!(log.path, log_path.display().to_string());
        assert_eq!(log.content, "recent executor failure\n");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_local_executor_log_tail_limits_to_last_twenty_lines() {
        let dir = std::env::temp_dir().join(format!(
            "wework-local-executor-log-lines-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("logs")).expect("test log dir should be created");
        let log_path = dir.join("logs").join("executor.log");
        let content = (1..=25)
            .map(|line| format!("line-{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&log_path, content).expect("test log should be written");

        let log = read_local_executor_log_tail(&log_path, 200 * 1024).expect("log should be read");

        assert!(log.truncated);
        assert_eq!(log.line_count, 20);
        assert!(log.content.starts_with("line-6\n"));
        assert!(log.content.ends_with("line-25"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_executor_processes_filters_executor_binary() {
        let output = r#"
111 /bin/zsh -c echo wegent-executor
222 /Applications/Wework.app/Contents/MacOS/wegent-executor --app
333 /usr/local/bin/wegent-executor --config /tmp/device-config.json
"#;

        assert_eq!(
            parse_executor_processes(output),
            vec![
                LocalExecutorProcessInfo {
                    pid: 222,
                    path: "/Applications/Wework.app/Contents/MacOS/wegent-executor".to_string(),
                },
                LocalExecutorProcessInfo {
                    pid: 333,
                    path: "/usr/local/bin/wegent-executor".to_string(),
                },
            ]
        );
    }

    #[test]
    fn ready_event_updates_status_device_id() {
        let inner = Arc::new(Mutex::new(LocalExecutorInner::default()));
        let event = ExecutorEvent {
            event: "executor.ready".to_string(),
            payload: json!({
                "device_id": "configured-device",
                "ready": true,
                "version": "1.9.0",
            }),
        };

        let _ = update_ready_event_inner(&inner, &event);

        let status = inner.lock().expect("state should lock");
        assert!(status.running);
        assert!(status.ready);
        assert_eq!(status.device_id.as_deref(), Some("configured-device"));
        assert_eq!(status.version.as_deref(), Some("1.9.0"));
        assert_eq!(status.error, None);
    }

    #[test]
    fn backend_env_marks_current_app_device_without_changing_device_id() {
        let _guard = env_lock();
        let previous_home = std::env::var_os(LOCAL_EXECUTOR_HOME_ENV);
        let previous_codex_home = std::env::var_os(WEGENT_CODEX_HOME_ENV);
        let previous_override = std::env::var_os(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV);
        let previous_shared_home = std::env::var_os(LOCAL_EXECUTOR_SHARED_HOME_ENV);
        let previous_log_dir = std::env::var_os(LOCAL_EXECUTOR_LOG_DIR_ENV);
        std::env::set_var(LOCAL_EXECUTOR_HOME_ENV, "/tmp/wework-instance-executor");
        std::env::remove_var(WEGENT_CODEX_HOME_ENV);
        std::env::remove_var(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV);
        std::env::remove_var(LOCAL_EXECUTOR_SHARED_HOME_ENV);
        std::env::remove_var(LOCAL_EXECUTOR_LOG_DIR_ENV);
        let inner = LocalExecutorInner {
            backend_connection: Some(LocalExecutorBackendConnection {
                backend_url: "https://cloud.example.com".to_string(),
                socket_url: "wss://socket.example.com".to_string(),
                auth_token: "wg-token".to_string(),
                runtime_auth_token: Some("runtime-task-token".to_string()),
            }),
            device_id: Some("local-device-abc".to_string()),
            ..LocalExecutorInner::default()
        };

        let envs = local_executor_backend_env(&inner)
            .into_iter()
            .collect::<HashMap<_, _>>();

        restore_env(LOCAL_EXECUTOR_HOME_ENV, previous_home);
        restore_env(WEGENT_CODEX_HOME_ENV, previous_codex_home);
        restore_env(LOCAL_EXECUTOR_ISOLATION_OVERRIDE_ENV, previous_override);
        restore_env(LOCAL_EXECUTOR_SHARED_HOME_ENV, previous_shared_home);
        restore_env(LOCAL_EXECUTOR_LOG_DIR_ENV, previous_log_dir);

        assert_eq!(
            envs.get("WEGENT_BACKEND_URL").map(String::as_str),
            Some("https://cloud.example.com")
        );
        assert_eq!(
            envs.get("WEGENT_SOCKET_URL").map(String::as_str),
            Some("wss://socket.example.com")
        );
        assert_eq!(
            envs.get("WEGENT_AUTH_TOKEN").map(String::as_str),
            Some("wg-token")
        );
        assert!(!envs.contains_key("WEGENT_RUNTIME_AUTH_TOKEN"));
        assert_eq!(
            envs.get("WEGENT_APP_IPC_DEVICE_ID").map(String::as_str),
            Some("local-device-abc")
        );
        assert_eq!(
            envs.get("DEVICE_ID").map(String::as_str),
            Some("local-device-abc")
        );
        assert_eq!(envs.get("DEVICE_TYPE").map(String::as_str), Some("app"));
        let executor_home_env = envs
            .get(LOCAL_EXECUTOR_HOME_ENV)
            .expect("executor home env should be passed to sidecar");
        let codex_home_env = envs
            .get(CODEX_HOME_ENV)
            .expect("codex home env should be passed to sidecar");
        let log_dir_env = envs
            .get(LOCAL_EXECUTOR_LOG_DIR_ENV)
            .expect("log dir env should be passed to sidecar");
        if cfg!(debug_assertions) {
            assert!(
                executor_home_env.starts_with("/tmp/wework-instance-executor/app-runtime/wework-")
            );
            assert_eq!(codex_home_env, &format!("{executor_home_env}/codex"));
            assert!(log_dir_env.starts_with("/tmp/wework-instance-executor/app-runtime/wework-"));
        } else {
            assert_eq!(executor_home_env, "/tmp/wework-instance-executor");
            assert_eq!(codex_home_env, "/tmp/wework-instance-executor/codex");
            assert_eq!(log_dir_env, "/tmp/wework-instance-executor/logs");
        }
    }

    #[test]
    fn sidecar_env_forces_stdio_and_dynamic_gateway_without_backend_connection() {
        let _guard = env_lock();
        let envs = local_executor_backend_env(&LocalExecutorInner::default())
            .into_iter()
            .collect::<HashMap<_, _>>();

        assert_eq!(
            envs.get(APP_IPC_DEVICE_ID_ENV).map(String::as_str),
            Some(LOCAL_EXECUTOR_DEVICE_ID)
        );
        assert_eq!(
            envs.get("DEVICE_ID").map(String::as_str),
            Some(LOCAL_EXECUTOR_DEVICE_ID)
        );
        assert_eq!(
            envs.get(SESSION_GATEWAY_HOST_ENV).map(String::as_str),
            Some("127.0.0.1")
        );
        assert_eq!(
            envs.get(SESSION_GATEWAY_PORT_ENV).map(String::as_str),
            Some("0")
        );
        assert_eq!(
            envs.get(SESSION_GATEWAY_PUBLIC_BASE_URL_ENV)
                .map(String::as_str),
            Some("")
        );
        assert!(!envs.contains_key("WEGENT_BACKEND_URL"));
        assert!(!envs.contains_key("WEGENT_SOCKET_URL"));
        assert!(!envs.contains_key("WEGENT_AUTH_TOKEN"));
    }

    #[test]
    fn replacing_backend_connection_is_idempotent() {
        let connection = LocalExecutorBackendConnection {
            backend_url: "https://cloud.example.com".to_string(),
            socket_url: "wss://socket.example.com".to_string(),
            auth_token: "wg-token".to_string(),
            runtime_auth_token: Some("runtime-task-token".to_string()),
        };
        let mut inner = LocalExecutorInner::default();

        assert!(replace_backend_connection(
            &mut inner,
            Some(connection.clone())
        ));
        assert!(!replace_backend_connection(
            &mut inner,
            Some(connection.clone())
        ));
        assert!(replace_backend_connection(&mut inner, None));
        assert!(!replace_backend_connection(&mut inner, None));
    }

    #[test]
    fn backend_env_includes_normalized_developer_path() {
        let _guard = env_lock();
        let previous_path = std::env::var_os("PATH");
        let previous_extra = std::env::var_os("WEGENT_EXTRA_PATHS");
        std::env::set_var("PATH", "/usr/bin:/bin");
        std::env::set_var("WEGENT_EXTRA_PATHS", "/custom/bin:/opt/homebrew/bin");

        let envs = local_executor_backend_env(&LocalExecutorInner::default())
            .into_iter()
            .collect::<HashMap<_, _>>();

        restore_env("PATH", previous_path);
        restore_env("WEGENT_EXTRA_PATHS", previous_extra);

        let path = envs.get("PATH").expect("PATH should be present");
        assert!(path.starts_with("/usr/bin:/bin:/custom/bin:/opt/homebrew/bin"));
        assert_eq!(path.matches("/opt/homebrew/bin").count(), 1);
        assert!(path.contains("/opt/homebrew/sbin"));
        assert!(path.contains("/usr/local/bin"));
    }

    #[test]
    fn backend_env_includes_file_edit_hook_command() {
        let _guard = env_lock();
        let previous_hook = std::env::var_os("WEGENT_FILE_EDIT_HOOK_COMMAND");
        std::env::remove_var("WEGENT_FILE_EDIT_HOOK_COMMAND");

        let envs = local_executor_backend_env(&LocalExecutorInner::default())
            .into_iter()
            .collect::<HashMap<_, _>>();

        restore_env("WEGENT_FILE_EDIT_HOOK_COMMAND", previous_hook);

        assert_eq!(
            envs.get("WEGENT_FILE_EDIT_HOOK_COMMAND").map(String::as_str),
            Some(
                "curl -s -X POST http://127.0.0.1:3456/api/file-edit-log -H \"Content-Type: application/json\" -d @-"
            )
        );
    }

    #[test]
    fn backend_env_preserves_custom_file_edit_hook_command() {
        let _guard = env_lock();
        let previous_hook = std::env::var_os("WEGENT_FILE_EDIT_HOOK_COMMAND");
        std::env::set_var(
            "WEGENT_FILE_EDIT_HOOK_COMMAND",
            "custom-file-edit-hook --stdin",
        );

        let envs = local_executor_backend_env(&LocalExecutorInner::default())
            .into_iter()
            .collect::<HashMap<_, _>>();

        restore_env("WEGENT_FILE_EDIT_HOOK_COMMAND", previous_hook);

        assert_eq!(
            envs.get("WEGENT_FILE_EDIT_HOOK_COMMAND")
                .map(String::as_str),
            Some("custom-file-edit-hook --stdin")
        );
    }

    #[test]
    fn backend_env_builds_file_edit_hook_command_from_configured_endpoint() {
        let _guard = env_lock();
        let previous_hook = std::env::var_os("WEGENT_FILE_EDIT_HOOK_COMMAND");
        let previous_endpoint = std::env::var_os("WEWORK_FILE_EDIT_LOG_ENDPOINT");
        std::env::remove_var("WEGENT_FILE_EDIT_HOOK_COMMAND");
        std::env::set_var(
            "WEWORK_FILE_EDIT_LOG_ENDPOINT",
            "http://127.0.0.1:4567/custom-file-edit-log",
        );

        let envs = local_executor_backend_env(&LocalExecutorInner::default())
            .into_iter()
            .collect::<HashMap<_, _>>();

        restore_env("WEGENT_FILE_EDIT_HOOK_COMMAND", previous_hook);
        restore_env("WEWORK_FILE_EDIT_LOG_ENDPOINT", previous_endpoint);

        assert_eq!(
            envs.get("WEGENT_FILE_EDIT_HOOK_COMMAND")
                .map(String::as_str),
            Some(
                "curl -s -X POST http://127.0.0.1:4567/custom-file-edit-log -H \"Content-Type: application/json\" -d @-"
            )
        );
    }

    #[test]
    fn bundled_codex_env_is_added_when_binary_exists() {
        let _guard = env_lock();
        let Some((target, binary)) = bundled_codex_target_layout() else {
            return;
        };
        let previous_binary = std::env::var_os(CODEX_BINARY_PATH_ENV);
        let previous_bin = std::env::var_os(CODEX_BIN_ENV);
        std::env::remove_var(CODEX_BINARY_PATH_ENV);
        std::env::remove_var(CODEX_BIN_ENV);
        let root =
            std::env::temp_dir().join(format!("wework-bundled-codex-env-{}", std::process::id()));
        let binary_path = root
            .join("binaries")
            .join("codex")
            .join(target)
            .join(binary);
        fs::create_dir_all(
            binary_path
                .parent()
                .expect("binary path should have parent"),
        )
        .expect("test binary dir should be created");
        fs::write(&binary_path, b"codex").expect("test binary should be written");

        let mut envs = Vec::new();
        append_bundled_codex_envs_for_root(&mut envs, &root);

        restore_env(CODEX_BINARY_PATH_ENV, previous_binary);
        restore_env(CODEX_BIN_ENV, previous_bin);
        let _ = fs::remove_dir_all(&root);

        let expected_binary = binary_path.display().to_string();
        let expected_package_root = root
            .join("binaries")
            .join("codex")
            .join(target)
            .display()
            .to_string();
        assert_eq!(
            envs.iter()
                .find(|(key, _)| key == CODEX_BINARY_PATH_ENV)
                .map(|(_, value)| value.as_str()),
            Some(expected_binary.as_str())
        );
        assert_eq!(
            envs.iter()
                .find(|(key, _)| key == CODEX_MANAGED_PACKAGE_ROOT_ENV)
                .map(|(_, value)| value.as_str()),
            Some(expected_package_root.as_str())
        );
    }

    #[test]
    fn bundled_codex_env_does_not_override_explicit_binary() {
        let _guard = env_lock();
        let Some((target, binary)) = bundled_codex_target_layout() else {
            return;
        };
        let previous_binary = std::env::var_os(CODEX_BINARY_PATH_ENV);
        let previous_bin = std::env::var_os(CODEX_BIN_ENV);
        std::env::set_var(CODEX_BINARY_PATH_ENV, "/custom/codex");
        std::env::remove_var(CODEX_BIN_ENV);
        let root = std::env::temp_dir().join(format!(
            "wework-bundled-codex-override-{}",
            std::process::id()
        ));
        let binary_path = root
            .join("binaries")
            .join("codex")
            .join(target)
            .join(binary);
        fs::create_dir_all(
            binary_path
                .parent()
                .expect("binary path should have parent"),
        )
        .expect("test binary dir should be created");
        fs::write(&binary_path, b"codex").expect("test binary should be written");

        let mut envs = Vec::new();
        append_bundled_codex_envs_for_root(&mut envs, &root);

        restore_env(CODEX_BINARY_PATH_ENV, previous_binary);
        restore_env(CODEX_BIN_ENV, previous_bin);
        let _ = fs::remove_dir_all(&root);

        assert!(envs.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn configured_sidecar_kill_stops_grandchild_process_group() {
        let dir = std::env::temp_dir().join(format!(
            "wework-local-executor-process-group-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("test dir should be created");
        let pid_path = dir.join("grandchild.pid");
        let script_path = dir.join("sidecar.sh");
        fs::write(
            &script_path,
            format!(
                r#"#!/usr/bin/env bash
set -euo pipefail
(
  trap '' TERM
  while true; do sleep 10; done
) &
echo "$!" > "{}"
wait
"#,
                pid_path.display()
            ),
        )
        .expect("sidecar script should be written");
        let mut permissions = fs::metadata(&script_path)
            .expect("sidecar metadata should be readable")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script_path, permissions)
            .expect("sidecar script should be executable");

        let mut command = Command::new(script_path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_managed_process_group(&mut command);
        let child = command.spawn().expect("sidecar should start");
        let child = LocalExecutorChild::Process(ManagedProcessChild::new(child));
        let grandchild_pid =
            wait_for_pid_file(&pid_path, Duration::from_secs(2)).expect("grandchild pid");
        let _cleanup = ProcessCleanup::new(grandchild_pid);

        child.kill();

        assert!(
            wait_until_dead(grandchild_pid, Duration::from_secs(2)),
            "grandchild process should be stopped when sidecar is killed"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    struct ProcessCleanup {
        pid: u32,
    }

    #[cfg(unix)]
    impl ProcessCleanup {
        fn new(pid: u32) -> Self {
            Self { pid }
        }
    }

    #[cfg(unix)]
    impl Drop for ProcessCleanup {
        fn drop(&mut self) {
            if process_alive(self.pid) {
                let _ = std::process::Command::new("kill")
                    .args(["-KILL", &self.pid.to_string()])
                    .status();
            }
        }
    }

    #[cfg(unix)]
    fn wait_for_pid_file(path: &PathBuf, timeout: Duration) -> Option<u32> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Ok(value) = fs::read_to_string(path) {
                if let Ok(pid) = value.trim().parse::<u32>() {
                    return Some(pid);
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }

    #[cfg(unix)]
    fn wait_until_dead(pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !process_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        !process_alive(pid)
    }

    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}
