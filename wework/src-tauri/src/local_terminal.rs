use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};

use crate::{agent_plugins, normalized_non_empty, process_environment};

const TERMINAL_OUTPUT_EVENT: &str = "local-terminal-output";
const TERMINAL_EXIT_EVENT: &str = "local-terminal-exit";
const DEFAULT_UTF8_LANG: &str = "en_US.UTF-8";
const DEFAULT_UTF8_LC_CTYPE: &str = "UTF-8";
const HARNESS_VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const OPEN_CODE_HARNESS_ID: &str = "opencode";
const CLAUDE_CODE_HARNESS_ID: &str = "claude_code";
const KIMI_CODE_HARNESS_ID: &str = "kimi_code";
const HARNESS_SESSIONS_FILE: &str = "local-harness-sessions.json";
const MAX_TERMINAL_SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;
static HARNESS_SESSION_STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy)]
enum HarnessPromptMode {
    Flag(&'static str),
    Positional,
    TerminalInput,
}

#[derive(Clone, Copy)]
struct LocalHarnessDefinition {
    id: &'static str,
    executable: &'static str,
    version_args: &'static [&'static str],
    home_relative_paths: &'static [&'static str],
    prompt_mode: HarnessPromptMode,
    resume_args: &'static [&'static str],
}

const LOCAL_HARNESSES: [LocalHarnessDefinition; 3] = [
    LocalHarnessDefinition {
        id: OPEN_CODE_HARNESS_ID,
        executable: "opencode",
        version_args: &["--version"],
        home_relative_paths: &[".opencode/bin/opencode"],
        prompt_mode: HarnessPromptMode::Flag("--prompt"),
        resume_args: &["--continue"],
    },
    LocalHarnessDefinition {
        id: CLAUDE_CODE_HARNESS_ID,
        executable: "claude",
        version_args: &["--version"],
        home_relative_paths: &[
            ".local/bin/claude",
            ".claude/local/claude",
            ".claude/bin/claude",
        ],
        prompt_mode: HarnessPromptMode::Positional,
        resume_args: &["--continue"],
    },
    LocalHarnessDefinition {
        id: KIMI_CODE_HARNESS_ID,
        executable: "kimi",
        version_args: &["--version"],
        home_relative_paths: &[".local/bin/kimi", ".kimi-code/bin/kimi"],
        prompt_mode: HarnessPromptMode::TerminalInput,
        resume_args: &["--continue"],
    },
];

#[derive(Serialize)]
pub struct LocalHarnessDescriptor {
    id: String,
    installed: bool,
    executable_path: Option<String>,
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHarnessPluginLocation {
    marketplace_path: String,
    plugin_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLocalHarnessRequest {
    harness_id: String,
    prompt: String,
    is_primary: bool,
    project_id: Option<i64>,
    executable_path: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
    env: Option<HashMap<String, String>>,
    plugin_roots: Option<Vec<String>>,
    proxy_token: Option<String>,
    model_key: Option<String>,
    resume_session_id: Option<String>,
}

struct PtyProcessSpec {
    program: String,
    args: Vec<String>,
}

pub struct LocalTerminalState {
    sessions: Arc<Mutex<HashMap<String, LocalTerminalSession>>>,
    next_id: AtomicU64,
}

struct LocalTerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    child_pid: Option<u32>,
    attach_sender: Option<mpsc::SyncSender<()>>,
    attached: bool,
    initial_input: Option<String>,
    harness: Option<LocalHarnessSessionMetadata>,
    output_sequence: u64,
    scrollback: String,
}

#[derive(Clone)]
struct LocalHarnessSessionMetadata {
    harness_id: String,
    title: String,
    cwd: String,
    created_at: u64,
    is_primary: bool,
    project_id: Option<i64>,
    proxy_token: Option<String>,
    model_key: Option<String>,
    native_session_id: Option<String>,
    plugin_roots: Vec<String>,
}

struct LocalHarnessLaunchMetadata {
    harness_id: String,
    title: String,
    is_primary: bool,
    project_id: Option<i64>,
    proxy_token: Option<String>,
    model_key: Option<String>,
    created_at: u64,
    native_session_id: Option<String>,
    plugin_roots: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LocalHarnessSessionDescriptor {
    session_id: String,
    harness_id: String,
    title: String,
    cwd: String,
    created_at: u64,
    is_primary: bool,
    project_id: Option<i64>,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    model_key: Option<String>,
    #[serde(default)]
    native_session_id: Option<String>,
    #[serde(default)]
    plugin_roots: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_token: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct LocalTerminalSnapshot {
    session_id: String,
    sequence: u64,
    data: String,
}

#[derive(Serialize, Clone)]
struct LocalTerminalOutput {
    session_id: String,
    sequence: u64,
    data: String,
}

#[derive(Serialize, Clone)]
struct LocalTerminalExit {
    session_id: String,
}

impl Default for LocalTerminalState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }
}

impl LocalTerminalState {
    pub fn active_process_ids(&self) -> Result<Vec<u32>, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "Failed to lock local terminal state".to_string())?
            .values()
            .filter_map(|session| session.child_pid)
            .collect())
    }
}

fn next_session_id(state: &LocalTerminalState) -> String {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    format!("local-terminal-{id}")
}

fn current_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn new_uuid_v4() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("Failed to generate Harness session UUID: {error}"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    ))
}

fn harness_session_title(id: &str, prompt: &str) -> String {
    let fallback = match id {
        OPEN_CODE_HARNESS_ID => "OpenCode",
        CLAUDE_CODE_HARNESS_ID => "Claude Code",
        KIMI_CODE_HARNESS_ID => "Kimi Code",
        _ => id,
    };
    prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(80).collect())
        .unwrap_or_else(|| fallback.to_string())
}

fn harness_sessions_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(HARNESS_SESSIONS_FILE))
        .map_err(|error| format!("Failed to resolve Harness session storage: {error}"))
}

fn harness_session_store_lock() -> &'static Mutex<()> {
    HARNESS_SESSION_STORE_LOCK.get_or_init(|| Mutex::new(()))
}

fn read_persisted_harness_sessions_unlocked(
    app: &tauri::AppHandle,
) -> Result<Vec<LocalHarnessSessionDescriptor>, String> {
    let path = harness_sessions_path(app)?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content =
        fs::read(&path).map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    serde_json::from_slice(&content).map_err(|error| {
        format!(
            "Invalid Harness session storage {}: {error}",
            path.display()
        )
    })
}

fn read_persisted_harness_sessions(
    app: &tauri::AppHandle,
) -> Result<Vec<LocalHarnessSessionDescriptor>, String> {
    let _guard = harness_session_store_lock()
        .lock()
        .map_err(|_| "Failed to lock Harness session storage".to_string())?;
    read_persisted_harness_sessions_unlocked(app)
}

fn write_persisted_harness_sessions_unlocked(
    app: &tauri::AppHandle,
    sessions: &[LocalHarnessSessionDescriptor],
) -> Result<(), String> {
    let path = harness_sessions_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Harness session storage has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let temporary = parent.join(format!(
        ".{HARNESS_SESSIONS_FILE}.{}.tmp",
        std::process::id()
    ));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(sessions)
            .map_err(|error| format!("Failed to encode Harness sessions: {error}"))?,
    )
    .map_err(|error| format!("Failed to write {}: {error}", temporary.display()))?;
    if cfg!(windows) && path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Failed to replace {}: {error}", path.display()))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Failed to install {}: {error}", path.display()))
}

fn upsert_persisted_harness_session(
    app: &tauri::AppHandle,
    descriptor: LocalHarnessSessionDescriptor,
) -> Result<(), String> {
    let _guard = harness_session_store_lock()
        .lock()
        .map_err(|_| "Failed to lock Harness session storage".to_string())?;
    let mut sessions = read_persisted_harness_sessions_unlocked(app)?;
    sessions.retain(|session| session.session_id != descriptor.session_id);
    sessions.push(LocalHarnessSessionDescriptor {
        active: false,
        proxy_token: None,
        ..descriptor
    });
    sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    write_persisted_harness_sessions_unlocked(app, &sessions)
}

fn remove_persisted_harness_session(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<(), String> {
    let _guard = harness_session_store_lock()
        .lock()
        .map_err(|_| "Failed to lock Harness session storage".to_string())?;
    let mut sessions = read_persisted_harness_sessions_unlocked(app)?;
    let original_len = sessions.len();
    sessions.retain(|session| session.session_id != session_id);
    if sessions.len() == original_len {
        return Ok(());
    }
    write_persisted_harness_sessions_unlocked(app, &sessions)
}

fn new_harness_session_id(state: &LocalTerminalState) -> String {
    format!(
        "local-harness-{}-{}",
        current_timestamp_millis(),
        state.next_id.fetch_add(1, Ordering::Relaxed)
    )
}

fn append_bounded_scrollback(scrollback: &mut String, data: &str) {
    scrollback.push_str(data);
    if scrollback.len() <= MAX_TERMINAL_SCROLLBACK_BYTES {
        return;
    }

    let mut remove_end = scrollback.len() - MAX_TERMINAL_SCROLLBACK_BYTES;
    while !scrollback.is_char_boundary(remove_end) {
        remove_end += 1;
    }
    scrollback.drain(..remove_end);
}

fn local_harness_definition(id: &str) -> Option<LocalHarnessDefinition> {
    LOCAL_HARNESSES
        .iter()
        .copied()
        .find(|definition| definition.id == id)
}

fn executable_candidates(path: PathBuf) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if path.extension().is_some() {
            return vec![path];
        }
        return [".exe", ".cmd", ".bat", ".com"]
            .iter()
            .map(|extension| path.with_extension(&extension[1..]))
            .collect();
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![path]
    }
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn resolve_executable(
    executable: &str,
    search_path: &str,
    home: Option<&Path>,
    home_relative_paths: &[&str],
) -> Option<PathBuf> {
    let path = Path::new(executable);
    if path.components().count() > 1 {
        return is_executable_file(path).then(|| path.to_path_buf());
    }

    std::env::split_paths(search_path)
        .flat_map(|directory| executable_candidates(directory.join(executable)))
        .chain(home.into_iter().flat_map(|directory| {
            home_relative_paths
                .iter()
                .map(move |path| directory.join(path))
        }))
        .find(|candidate| is_executable_file(candidate))
}

fn resolve_local_harness_executable(
    definition: LocalHarnessDefinition,
    executable_override: Option<&str>,
) -> Option<PathBuf> {
    let search_path = process_environment::normalized_current_path();
    let home = preferred_home_directory(std::env::var_os("HOME"), dirs::home_dir());
    let executable = executable_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(definition.executable);
    resolve_executable(
        executable,
        &search_path,
        home.as_deref(),
        if executable_override.is_some() {
            &[]
        } else {
            definition.home_relative_paths
        },
    )
}

fn preferred_home_directory(
    environment_home: Option<std::ffi::OsString>,
    fallback_home: Option<PathBuf>,
) -> Option<PathBuf> {
    environment_home
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or(fallback_home)
}

fn read_command_version(path: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + HARNESS_VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut version = String::new();
                child.stdout.take()?.read_to_string(&mut version).ok()?;
                return version
                    .lines()
                    .next()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned);
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }
}

fn harness_launch_args(
    definition: LocalHarnessDefinition,
    configured_args: Option<Vec<String>>,
    prompt: &str,
) -> Vec<String> {
    let mut args = configured_args.unwrap_or_default();
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return args;
    }
    match definition.prompt_mode {
        HarnessPromptMode::Flag(flag) => {
            args.push(flag.to_string());
            args.push(prompt.to_string());
        }
        HarnessPromptMode::Positional => args.push(prompt.to_string()),
        HarnessPromptMode::TerminalInput => {}
    }
    args
}

fn harness_initial_terminal_input(
    definition: LocalHarnessDefinition,
    prompt: &str,
) -> Option<String> {
    if !matches!(definition.prompt_mode, HarnessPromptMode::TerminalInput) {
        return None;
    }
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return None;
    }
    Some(format!("\u{1b}[200~{prompt}\u{1b}[201~\r"))
}

#[tauri::command]
pub async fn list_local_harnesses(
    executable_overrides: Option<HashMap<String, Option<String>>>,
) -> Result<Vec<LocalHarnessDescriptor>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        LOCAL_HARNESSES
            .iter()
            .map(|definition| {
                let executable_override = executable_overrides
                    .as_ref()
                    .and_then(|overrides| overrides.get(definition.id))
                    .and_then(|value| value.as_deref());
                let executable_path =
                    resolve_local_harness_executable(*definition, executable_override);
                let version = executable_path
                    .as_deref()
                    .and_then(|path| read_command_version(path, definition.version_args));
                LocalHarnessDescriptor {
                    id: definition.id.to_string(),
                    installed: executable_path.is_some(),
                    executable_path: executable_path.map(|path| path.display().to_string()),
                    version,
                }
            })
            .collect()
    })
    .await
    .map_err(|error| format!("Failed to detect local harnesses: {error}"))
}

#[tauri::command]
pub fn resolve_local_harness_plugin_roots(
    locations: Vec<LocalHarnessPluginLocation>,
) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    locations
        .into_iter()
        .filter_map(|location| {
            let marketplace_path = PathBuf::from(location.marketplace_path.trim());
            let plugin_name = location.plugin_name.trim();
            if marketplace_path.as_os_str().is_empty() || plugin_name.is_empty() {
                return None;
            }
            let (_, root) =
                crate::local_executor::resolve_local_plugin_root(&marketplace_path, plugin_name)
                    .ok()?;
            let root = root.display().to_string();
            seen.insert(root.clone()).then_some(root)
        })
        .collect()
}

#[tauri::command]
pub fn list_local_harness_sessions(
    app: tauri::AppHandle,
    state: State<'_, LocalTerminalState>,
) -> Result<Vec<LocalHarnessSessionDescriptor>, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Failed to lock local terminal state".to_string())?;
    let active_descriptors = sessions
        .iter()
        .filter_map(|(session_id, session)| {
            let harness = session.harness.as_ref()?;
            Some(LocalHarnessSessionDescriptor {
                session_id: session_id.clone(),
                harness_id: harness.harness_id.clone(),
                title: harness.title.clone(),
                cwd: harness.cwd.clone(),
                created_at: harness.created_at,
                is_primary: harness.is_primary,
                project_id: harness.project_id,
                active: true,
                model_key: harness.model_key.clone(),
                native_session_id: harness.native_session_id.clone(),
                plugin_roots: harness.plugin_roots.clone(),
                proxy_token: harness.proxy_token.clone(),
            })
        })
        .collect::<Vec<_>>();
    drop(sessions);

    let mut descriptors = read_persisted_harness_sessions(&app)?;
    for active in active_descriptors {
        if let Some(existing) = descriptors
            .iter_mut()
            .find(|descriptor| descriptor.session_id == active.session_id)
        {
            *existing = active;
        } else {
            descriptors.push(active);
        }
    }
    descriptors.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(descriptors)
}

#[tauri::command]
pub fn update_local_harness_session_title(
    app: tauri::AppHandle,
    state: State<'_, LocalTerminalState>,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let normalized = title.trim().chars().take(80).collect::<String>();
    if normalized.is_empty() {
        return Ok(());
    }
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Failed to lock local terminal state".to_string())?;
    if let Some(harness) = sessions
        .get_mut(&session_id)
        .and_then(|session| session.harness.as_mut())
    {
        harness.title = normalized.clone();
    }
    drop(sessions);

    let _store_guard = harness_session_store_lock()
        .lock()
        .map_err(|_| "Failed to lock Harness session storage".to_string())?;
    let mut persisted = read_persisted_harness_sessions_unlocked(&app)?;
    let session = persisted
        .iter_mut()
        .find(|session| session.session_id == session_id)
        .ok_or_else(|| format!("Harness session not found: {session_id}"))?;
    session.title = normalized;
    write_persisted_harness_sessions_unlocked(&app, &persisted)
}

#[tauri::command]
pub fn get_local_terminal_snapshot(
    state: State<'_, LocalTerminalState>,
    session_id: String,
) -> Result<LocalTerminalSnapshot, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Failed to lock local terminal state".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Local terminal session not found: {session_id}"))?;
    Ok(LocalTerminalSnapshot {
        session_id,
        sequence: session.output_sequence,
        data: session.scrollback.clone(),
    })
}

fn normalized_cwd(cwd: Option<String>) -> Result<Option<String>, String> {
    let Some(cwd) = cwd else {
        return Ok(None);
    };
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Ok(None);
    }
    if !std::path::Path::new(cwd).exists() {
        return Err(format!("Terminal cwd does not exist: {cwd}"));
    }

    Ok(Some(cwd.to_string()))
}

fn normalized_extra_env(env: Option<HashMap<String, String>>) -> HashMap<String, String> {
    env.unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| {
            let key = key.trim();
            if key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0') {
                return None;
            }

            Some((key.to_string(), value))
        })
        .collect()
}

fn decode_pty_output_chunk(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    let mut bytes = std::mem::take(pending);
    bytes.extend_from_slice(chunk);

    let mut output = String::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        match std::str::from_utf8(&bytes[cursor..]) {
            Ok(text) => {
                output.push_str(text);
                return output;
            }
            Err(error) => {
                let valid_end = cursor + error.valid_up_to();
                if valid_end > cursor {
                    output.push_str(
                        std::str::from_utf8(&bytes[cursor..valid_end])
                            .expect("valid_up_to marks a valid UTF-8 prefix"),
                    );
                }

                match error.error_len() {
                    Some(error_len) => {
                        output.push('\u{FFFD}');
                        cursor = valid_end + error_len;
                    }
                    None => {
                        pending.extend_from_slice(&bytes[valid_end..]);
                        return output;
                    }
                }
            }
        }
    }

    output
}

fn is_utf8_locale_value(value: &str) -> bool {
    let value = value.to_ascii_uppercase();
    value.contains("UTF-8") || value.contains("UTF8")
}

fn resolve_utf8_locale_value(value: Option<&str>, default: &str) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && is_utf8_locale_value(value))
        .unwrap_or(default)
        .to_string()
}

fn process_utf8_locale_value(name: &str, default: &str) -> String {
    resolve_utf8_locale_value(std::env::var(name).ok().as_deref(), default)
}

fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("PATH", process_environment::normalized_current_path());
    command.env("LANG", process_utf8_locale_value("LANG", DEFAULT_UTF8_LANG));
    command.env(
        "LC_CTYPE",
        process_utf8_locale_value("LC_CTYPE", DEFAULT_UTF8_LC_CTYPE),
    );
}

fn configure_terminal_extra_environment(
    command: &mut CommandBuilder,
    env: HashMap<String, String>,
) {
    for (key, value) in env {
        command.env(key, value);
    }
}

#[tauri::command]
pub fn start_local_terminal(
    app: tauri::AppHandle,
    state: State<'_, LocalTerminalState>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
    env: Option<HashMap<String, String>>,
    task_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<String, String> {
    log::info!(
        "Tauri local terminal start requested: host_pid={}, task_id={:?}, workspace_path={:?}, cwd={:?}",
        std::process::id(),
        task_id,
        workspace_path,
        cwd
    );
    #[cfg(target_os = "macos")]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        start_pty_shell(
            app,
            &state,
            cwd,
            rows,
            cols,
            env,
            shell,
            task_id,
            workspace_path,
        )
    }

    #[cfg(target_os = "windows")]
    {
        let shell = resolve_windows_shell();
        start_pty_shell(
            app,
            &state,
            cwd,
            rows,
            cols,
            env,
            shell,
            task_id,
            workspace_path,
        )
    }

    #[cfg(target_os = "linux")]
    {
        if std::env::var("VITE_WEWORK_E2E").as_deref() != Ok("true") {
            return Err("Local terminal is supported only on macOS and Windows".to_string());
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        start_pty_shell(
            app,
            &state,
            cwd,
            rows,
            cols,
            env,
            shell,
            task_id,
            workspace_path,
        )
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = app;
        let _ = state;
        let _ = cwd;
        let _ = rows;
        let _ = cols;
        let _ = env;
        let _ = task_id;
        let _ = workspace_path;
        Err("Local terminal is supported only on macOS and Windows".to_string())
    }
}

#[tauri::command]
pub fn start_local_harness(
    app: tauri::AppHandle,
    state: State<'_, LocalTerminalState>,
    request: StartLocalHarnessRequest,
) -> Result<String, String> {
    let resume_record = request
        .resume_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|session_id| {
            read_persisted_harness_sessions(&app)?
                .into_iter()
                .find(|session| session.session_id == session_id)
                .ok_or_else(|| format!("Harness session not found: {session_id}"))
        })
        .transpose()?;
    let harness_id = resume_record
        .as_ref()
        .map(|record| record.harness_id.as_str())
        .unwrap_or_else(|| request.harness_id.trim());
    let definition = local_harness_definition(harness_id)
        .ok_or_else(|| format!("Unsupported local harness: {}", request.harness_id))?;
    let executable =
        resolve_local_harness_executable(definition, request.executable_path.as_deref())
            .ok_or_else(|| {
                format!(
                    "{} is not installed or is unavailable on PATH",
                    definition.executable
                )
            })?;
    let session_id = resume_record
        .as_ref()
        .map(|record| record.session_id.clone())
        .unwrap_or_else(|| new_harness_session_id(&state));
    let native_session_id = match definition.id {
        CLAUDE_CODE_HARNESS_ID => resume_record
            .as_ref()
            .and_then(|record| record.native_session_id.clone())
            .map(Ok)
            .unwrap_or_else(new_uuid_v4)?,
        _ => String::new(),
    };
    let cwd = request
        .cwd
        .clone()
        .or_else(|| resume_record.as_ref().map(|record| record.cwd.clone()));
    let mut env = request.env.unwrap_or_default();
    let mut configured_args = request.args.unwrap_or_default();
    let plugin_roots = request
        .plugin_roots
        .filter(|roots| !roots.is_empty())
        .or_else(|| {
            resume_record
                .as_ref()
                .map(|record| record.plugin_roots.clone())
        })
        .unwrap_or_default();
    let accept_bypass_permissions = definition.id == CLAUDE_CODE_HARNESS_ID
        && (configured_args
            .iter()
            .any(|arg| arg == "--dangerously-skip-permissions")
            || configured_args
                .windows(2)
                .any(|args| args[0] == "--permission-mode" && args[1] == "bypassPermissions"));
    let plugin_adapter = agent_plugins::prepare_harness_plugin_adapter(
        &app,
        definition.id,
        &session_id,
        cwd.as_deref(),
        &plugin_roots,
        &env,
        accept_bypass_permissions,
    )?;
    env.extend(plugin_adapter.env);
    configured_args.extend(plugin_adapter.args);
    if resume_record.is_some() {
        if definition.id == CLAUDE_CODE_HARNESS_ID {
            configured_args.extend(["--resume".to_string(), native_session_id.clone()]);
        } else {
            configured_args.extend(definition.resume_args.iter().map(|value| value.to_string()));
        }
    } else if definition.id == CLAUDE_CODE_HARNESS_ID {
        configured_args.extend(["--session-id".to_string(), native_session_id.clone()]);
    }
    let args = harness_launch_args(
        definition,
        Some(configured_args),
        resume_record
            .as_ref()
            .map_or(request.prompt.as_str(), |_| ""),
    );
    let initial_input = harness_initial_terminal_input(
        definition,
        resume_record
            .as_ref()
            .map_or(request.prompt.as_str(), |_| ""),
    );
    let title = resume_record
        .as_ref()
        .map(|record| record.title.clone())
        .unwrap_or_else(|| harness_session_title(definition.id, &request.prompt));
    let created_at = resume_record
        .as_ref()
        .map(|record| record.created_at)
        .unwrap_or_else(current_timestamp_millis);
    let is_primary = resume_record
        .as_ref()
        .map(|record| record.is_primary)
        .unwrap_or(request.is_primary);
    let project_id = resume_record
        .as_ref()
        .and_then(|record| record.project_id)
        .or(request.project_id);
    let model_key = request
        .model_key
        .and_then(normalized_non_empty)
        .or_else(|| {
            resume_record
                .as_ref()
                .and_then(|record| record.model_key.clone())
        });
    let proxy_token = request.proxy_token.and_then(normalized_non_empty);
    let result = start_pty_process(
        app.clone(),
        &state,
        cwd.clone(),
        request.rows,
        request.cols,
        (!env.is_empty()).then_some(env),
        PtyProcessSpec {
            program: executable.display().to_string(),
            args,
        },
        Some(LocalHarnessLaunchMetadata {
            harness_id: definition.id.to_string(),
            title: title.clone(),
            is_primary,
            project_id,
            proxy_token: proxy_token.clone(),
            model_key: model_key.clone(),
            created_at,
            native_session_id: (!native_session_id.is_empty()).then_some(native_session_id.clone()),
            plugin_roots: plugin_roots.clone(),
        }),
        None,
        None,
        Some(session_id.clone()),
        initial_input,
    );
    let started_session_id = result?;
    let persisted = LocalHarnessSessionDescriptor {
        session_id: started_session_id.clone(),
        harness_id: definition.id.to_string(),
        title,
        cwd: normalized_cwd(cwd)?.unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .display()
                .to_string()
        }),
        created_at,
        is_primary,
        project_id,
        active: false,
        model_key,
        native_session_id: (!native_session_id.is_empty()).then_some(native_session_id),
        plugin_roots,
        proxy_token: None,
    };
    if let Err(error) = upsert_persisted_harness_session(&app, persisted) {
        if let Ok(mut sessions) = state.sessions.lock() {
            if let Some(mut session) = sessions.remove(&started_session_id) {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }
        return Err(error);
    }
    Ok(started_session_id)
}

fn start_pty_shell(
    app: tauri::AppHandle,
    state: &LocalTerminalState,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
    env: Option<HashMap<String, String>>,
    shell: String,
    task_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<String, String> {
    start_pty_process(
        app,
        state,
        cwd,
        rows,
        cols,
        env,
        PtyProcessSpec {
            program: shell,
            args: Vec::new(),
        },
        None,
        task_id,
        workspace_path,
        None,
        None,
    )
}

fn start_pty_process(
    app: tauri::AppHandle,
    state: &LocalTerminalState,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
    env: Option<HashMap<String, String>>,
    process: PtyProcessSpec,
    harness: Option<LocalHarnessLaunchMetadata>,
    task_id: Option<String>,
    workspace_path: Option<String>,
    session_id_override: Option<String>,
    initial_input: Option<String>,
) -> Result<String, String> {
    let cwd = normalized_cwd(cwd)?;
    let diagnostic_cwd = cwd.clone();
    let effective_cwd = cwd.clone().unwrap_or_else(|| {
        std::env::current_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_default()
    });
    let size = PtySize {
        rows: rows.unwrap_or(24).max(1),
        cols: cols.unwrap_or(80).max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("Failed to create PTY: {error}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to create PTY reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to create PTY writer: {error}"))?;
    let mut command = CommandBuilder::new(process.program);
    for arg in process.args {
        command.arg(arg);
    }
    configure_terminal_environment(&mut command);
    if harness
        .as_ref()
        .is_some_and(|metadata| metadata.harness_id == CLAUDE_CODE_HARNESS_ID)
    {
        command.env_remove("ANTHROPIC_AUTH_TOKEN");
    }
    configure_terminal_extra_environment(&mut command, normalized_extra_env(env));
    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to spawn shell: {error}"))?;
    let child_pid = child.process_id();
    drop(pair.slave);

    let (attach_sender, attach_receiver) = mpsc::sync_channel(1);
    let session_id = session_id_override.unwrap_or_else(|| next_session_id(state));
    let session = LocalTerminalSession {
        master: pair.master,
        writer,
        child_pid,
        child,
        attach_sender: Some(attach_sender),
        attached: false,
        initial_input,
        harness: harness.map(|metadata| LocalHarnessSessionMetadata {
            harness_id: metadata.harness_id,
            title: metadata.title,
            cwd: effective_cwd,
            created_at: metadata.created_at,
            is_primary: metadata.is_primary,
            project_id: metadata.project_id,
            proxy_token: metadata.proxy_token,
            model_key: metadata.model_key,
            native_session_id: metadata.native_session_id,
            plugin_roots: metadata.plugin_roots,
        }),
        output_sequence: 0,
        scrollback: String::new(),
    };
    state
        .sessions
        .lock()
        .map_err(|_| "Failed to lock local terminal state".to_string())?
        .insert(session_id.clone(), session);
    log::info!(
        "Tauri local terminal start succeeded: host_pid={}, child_pid={:?}, session_id={}, task_id={:?}, workspace_path={:?}, cwd={:?}",
        std::process::id(),
        child_pid,
        session_id,
        task_id,
        workspace_path,
        diagnostic_cwd
    );

    let sessions = Arc::clone(&state.sessions);
    let output_session_id = session_id.clone();
    let exit_session_id = session_id.clone();
    std::thread::spawn(move || {
        if attach_receiver.recv().is_err() {
            return;
        }
        let mut buffer = [0_u8; 8192];
        let mut pending_utf8 = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = decode_pty_output_chunk(&mut pending_utf8, &buffer[..size]);
                    if data.is_empty() {
                        continue;
                    }
                    let sequence = match sessions.lock() {
                        Ok(mut sessions) => {
                            let Some(session) = sessions.get_mut(&output_session_id) else {
                                break;
                            };
                            session.output_sequence += 1;
                            append_bounded_scrollback(&mut session.scrollback, &data);
                            session.output_sequence
                        }
                        Err(_) => break,
                    };
                    let _ = app.emit(
                        TERMINAL_OUTPUT_EVENT,
                        LocalTerminalOutput {
                            session_id: output_session_id.clone(),
                            sequence,
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let removed = sessions
            .lock()
            .map(|mut sessions| sessions.remove(&exit_session_id).is_some())
            .unwrap_or(false);
        if removed {
            let _ = app.emit(
                TERMINAL_EXIT_EVENT,
                LocalTerminalExit {
                    session_id: exit_session_id,
                },
            );
        }
    });

    Ok(session_id)
}

#[tauri::command]
pub fn attach_local_terminal(
    state: State<'_, LocalTerminalState>,
    session_id: String,
    task_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    log::info!(
        "Tauri local terminal attach requested: host_pid={}, session_id={}, task_id={:?}, workspace_path={:?}",
        std::process::id(),
        session_id,
        task_id,
        workspace_path
    );
    let mut sessions = state.sessions.lock().map_err(|_| {
        log::warn!(
            "Tauri local terminal attach failed: reason=state_lock, host_pid={}, session_id={}, task_id={:?}, workspace_path={:?}",
            std::process::id(),
            session_id,
            task_id,
            workspace_path
        );
        "Failed to lock local terminal state".to_string()
    })?;
    let Some(session) = sessions.get_mut(&session_id) else {
        log::warn!(
            "Tauri local terminal attach failed: reason=session_not_found, host_pid={}, session_id={}, task_id={:?}, workspace_path={:?}",
            std::process::id(),
            session_id,
            task_id,
            workspace_path
        );
        return Err(format!("Local terminal session not found: {session_id}"));
    };
    if session.attached {
        log::info!(
            "Tauri local terminal attach skipped: reason=already_attached, host_pid={}, session_id={}, task_id={:?}, workspace_path={:?}",
            std::process::id(),
            session_id,
            task_id,
            workspace_path
        );
        return Ok(());
    }
    let Some(attach_sender) = session.attach_sender.take() else {
        log::warn!(
            "Tauri local terminal attach failed: reason=attach_sender_missing, host_pid={}, session_id={}, task_id={:?}, workspace_path={:?}",
            std::process::id(),
            session_id,
            task_id,
            workspace_path
        );
        return Err(format!(
            "Local terminal session cannot be attached: {session_id}"
        ));
    };

    if let Some(initial_input) = session.initial_input.as_deref() {
        session
            .writer
            .write_all(initial_input.as_bytes())
            .map_err(|error| format!("Failed to write initial terminal input: {error}"))?;
        session
            .writer
            .flush()
            .map_err(|error| format!("Failed to flush initial terminal input: {error}"))?;
        session.initial_input = None;
    }
    if attach_sender.send(()).is_err() {
        log::warn!(
            "Tauri local terminal attach failed: reason=attach_receiver_closed, host_pid={}, session_id={}, task_id={:?}, workspace_path={:?}",
            std::process::id(),
            session_id,
            task_id,
            workspace_path
        );
        return Err(format!(
            "Failed to attach local terminal session: {session_id}"
        ));
    }
    session.attached = true;
    log::info!(
        "Tauri local terminal attach succeeded: host_pid={}, session_id={}, task_id={:?}, workspace_path={:?}",
        std::process::id(),
        session_id,
        task_id,
        workspace_path
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn resolve_windows_shell() -> String {
    if which_shell("pwsh.exe") {
        return "pwsh.exe".to_string();
    }
    if which_shell("powershell.exe") {
        return "powershell.exe".to_string();
    }
    "powershell.exe".to_string()
}

#[cfg(target_os = "windows")]
fn which_shell(name: &str) -> bool {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    std::process::Command::new("where")
        .arg(name)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn write_local_terminal(
    state: State<'_, LocalTerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Failed to lock local terminal state".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Local terminal session not found: {session_id}"))?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("Failed to write to terminal: {error}"))?;
    session
        .writer
        .flush()
        .map_err(|error| format!("Failed to flush terminal input: {error}"))
}

#[tauri::command]
pub fn resize_local_terminal(
    state: State<'_, LocalTerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Failed to lock local terminal state".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Local terminal session not found: {session_id}"))?;

    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to resize terminal: {error}"))
}

#[tauri::command]
pub fn close_local_terminal(
    app: tauri::AppHandle,
    state: State<'_, LocalTerminalState>,
    session_id: String,
    task_id: Option<String>,
    workspace_path: Option<String>,
    reason: Option<String>,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Failed to lock local terminal state".to_string())?;
    let mut remove_persisted = false;
    if let Some(mut session) = sessions.remove(&session_id) {
        remove_persisted = session.harness.is_some();
        log::info!(
            "Tauri local terminal close requested: host_pid={}, session_id={}, task_id={:?}, workspace_path={:?}, reason={:?}",
            std::process::id(),
            session_id,
            task_id,
            workspace_path,
            reason
        );
        if let Err(error) = session.child.kill() {
            log::warn!(
                "Tauri local terminal kill failed: host_pid={}, session_id={}, task_id={:?}, workspace_path={:?}, reason={:?}, error={error}",
                std::process::id(),
                session_id,
                task_id,
                workspace_path,
                reason
            );
        }
    } else {
        log::warn!(
            "Tauri local terminal close skipped: reason=session_not_found, host_pid={}, session_id={}, task_id={:?}, workspace_path={:?}, close_reason={:?}",
            std::process::id(),
            session_id,
            task_id,
            workspace_path,
            reason
        );
    }
    drop(sessions);
    if remove_persisted
        || read_persisted_harness_sessions(&app)?
            .iter()
            .any(|session| session.session_id == session_id)
    {
        remove_persisted_harness_session(&app, &session_id)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_output_across_read_boundaries() {
        let mut pending = Vec::new();
        let mut output = String::new();
        let bytes = "修复".as_bytes();

        output.push_str(&decode_pty_output_chunk(&mut pending, &bytes[..2]));
        output.push_str(&decode_pty_output_chunk(&mut pending, &bytes[2..]));

        assert_eq!(output, "修复");
        assert!(pending.is_empty());
    }

    #[test]
    fn resolves_utf8_locale_for_terminal_processes() {
        assert_eq!(
            resolve_utf8_locale_value(None, "en_US.UTF-8"),
            "en_US.UTF-8"
        );
        assert_eq!(
            resolve_utf8_locale_value(Some("C"), "en_US.UTF-8"),
            "en_US.UTF-8"
        );
        assert_eq!(
            resolve_utf8_locale_value(Some("zh_CN.UTF-8"), "en_US.UTF-8"),
            "zh_CN.UTF-8"
        );
    }

    #[test]
    fn keeps_harness_prompt_in_one_argument() {
        let prompt = "fix '$HOME' `whoami`\nthen explain";

        assert_eq!(
            harness_launch_args(
                local_harness_definition(OPEN_CODE_HARNESS_ID).unwrap(),
                None,
                prompt
            ),
            vec!["--prompt", prompt]
        );
    }

    #[test]
    fn launches_claude_code_with_a_positional_prompt() {
        let prompt = "fix the tests";

        assert_eq!(
            harness_launch_args(
                local_harness_definition(CLAUDE_CODE_HARNESS_ID).unwrap(),
                Some(vec!["--permission-mode".into(), "plan".into()]),
                prompt
            ),
            vec!["--permission-mode", "plan", prompt]
        );
    }

    #[test]
    fn launches_kimi_code_interactively_without_the_prompt_flag() {
        let prompt = "verify Wework plugins";

        assert_eq!(
            harness_launch_args(
                local_harness_definition(KIMI_CODE_HARNESS_ID).unwrap(),
                Some(vec![
                    "--model".into(),
                    "__kimi_env_model__".into(),
                    "--auto".into(),
                ]),
                prompt
            ),
            vec!["--model", "__kimi_env_model__", "--auto"]
        );
        assert_eq!(
            harness_initial_terminal_input(
                local_harness_definition(KIMI_CODE_HARNESS_ID).unwrap(),
                prompt
            ),
            Some(format!("\u{1b}[200~{prompt}\u{1b}[201~\r"))
        );
    }

    #[test]
    fn does_not_inject_terminal_input_for_argument_based_harnesses() {
        assert_eq!(
            harness_initial_terminal_input(
                local_harness_definition(OPEN_CODE_HARNESS_ID).unwrap(),
                "inspect the project"
            ),
            None
        );
        assert_eq!(
            harness_initial_terminal_input(
                local_harness_definition(CLAUDE_CODE_HARNESS_ID).unwrap(),
                "inspect the project"
            ),
            None
        );
    }

    #[test]
    fn prefers_explicit_home_for_harness_detection() {
        let environment_home = PathBuf::from("/explicit/home");
        let fallback_home = PathBuf::from("/fallback/home");

        assert_eq!(
            preferred_home_directory(
                Some(environment_home.clone().into_os_string()),
                Some(fallback_home)
            ),
            Some(environment_home)
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_harness_from_home_install_directory() {
        use std::os::unix::fs::PermissionsExt;

        let test_home =
            std::env::temp_dir().join(format!("wework-opencode-home-{}", std::process::id()));
        let executable = test_home.join(".opencode/bin/opencode");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, "#!/bin/sh\n").unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let resolved = resolve_executable(
            "opencode",
            "",
            Some(&test_home),
            &[".opencode/bin/opencode"],
        );

        assert_eq!(resolved, Some(executable));
        std::fs::remove_dir_all(test_home).unwrap();
    }
}
