// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::env;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

static EFFECTIVE_DEVICE_TYPE: OnceLock<RwLock<String>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeMode {
    Local,
    Docker,
}

#[derive(Debug)]
pub enum ConfigError {
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, source } => {
                write!(
                    formatter,
                    "failed to read config {}: {source}",
                    path.display()
                )
            }
            Self::Parse { path, source } => {
                write!(
                    formatter,
                    "failed to parse config {}: {source}",
                    path.display()
                )
            }
            Self::Write { path, source } => {
                write!(
                    formatter,
                    "failed to write config {}: {source}",
                    path.display()
                )
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionConfig {
    #[serde(default)]
    pub backend_url: String,
    #[serde(default)]
    pub socket_url: String,
    #[serde(default)]
    pub auth_token: String,
    #[serde(default)]
    pub runtime_auth_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LoggingConfig {
    #[serde(default = "default_log_level")]
    pub level: String,
    #[serde(default = "default_log_max_size")]
    pub max_size_mb: u32,
    #[serde(default = "default_log_backup_count")]
    pub backup_count: u32,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: default_log_level(),
            max_size_mb: default_log_max_size(),
            backup_count: default_log_backup_count(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct UpdateConfig {
    pub registry: String,
    pub registry_token: String,
}

impl<'de> Deserialize<'de> for UpdateConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Default, Deserialize)]
        struct RawUpdateConfig {
            #[serde(default)]
            registry: Option<String>,
            #[serde(default)]
            url: Option<String>,
            #[serde(default)]
            registry_token: Option<String>,
            #[serde(default)]
            token: Option<String>,
        }

        let raw = RawUpdateConfig::deserialize(deserializer)?;
        Ok(Self {
            registry: raw.registry.or(raw.url).unwrap_or_default(),
            registry_token: raw.registry_token.or(raw.token).unwrap_or_default(),
        })
    }
}

impl UpdateConfig {
    pub fn is_registry(&self) -> bool {
        !self.registry.trim().is_empty()
    }

    pub fn registry_url(&self) -> Option<&str> {
        non_empty_str(&self.registry)
    }

    pub fn token(&self) -> Option<&str> {
        non_empty_str(&self.registry_token)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceConfig {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_device_type")]
    pub device_type: String,
    #[serde(default = "default_bind_shell")]
    pub bind_shell: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub runtime_instance_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub connection: ConnectionConfig,
    #[serde(default)]
    pub logging: LoggingConfig,
    #[serde(default)]
    pub update: UpdateConfig,
    #[serde(skip)]
    pub executor_home: PathBuf,
    #[serde(skip)]
    pub local_workspace_root: PathBuf,
}

impl Default for DeviceConfig {
    fn default() -> Self {
        let executor_home = default_executor_home();
        Self {
            mode: default_mode(),
            device_type: default_device_type(),
            bind_shell: default_bind_shell(),
            device_id: String::new(),
            runtime_instance_id: String::new(),
            device_name: String::new(),
            capabilities: Vec::new(),
            connection: ConnectionConfig::default(),
            logging: LoggingConfig::default(),
            update: UpdateConfig::default(),
            local_workspace_root: executor_home.join("workspace"),
            executor_home,
        }
    }
}

impl DeviceConfig {
    pub fn runtime_mode(&self) -> RuntimeMode {
        match self.mode.trim().to_ascii_lowercase().as_str() {
            "docker" => RuntimeMode::Docker,
            _ => RuntimeMode::Local,
        }
    }

    fn apply_env_overrides(&mut self) {
        set_from_env(&mut self.mode, "EXECUTOR_MODE");
        set_from_env(&mut self.connection.backend_url, "WEGENT_BACKEND_URL");
        set_from_env(&mut self.connection.socket_url, "WEGENT_SOCKET_URL");
        set_from_env(&mut self.connection.auth_token, "WEGENT_AUTH_TOKEN");
        set_from_env(&mut self.device_id, "DEVICE_ID");
        set_from_env(&mut self.runtime_instance_id, "WEGENT_RUNTIME_INSTANCE_ID");
        set_from_env(&mut self.device_name, "DEVICE_NAME");
        set_from_env(&mut self.device_type, "DEVICE_TYPE");
        set_from_env(&mut self.bind_shell, "BIND_SHELL");

        if let Ok(value) = env::var("WEGENT_EXECUTOR_HOME") {
            if !value.trim().is_empty() {
                self.executor_home = PathBuf::from(value.trim());
            }
        }
        if let Ok(value) = env::var("LOCAL_WORKSPACE_ROOT") {
            if !value.trim().is_empty() {
                self.local_workspace_root = PathBuf::from(value.trim());
            }
        } else if self.local_workspace_root.as_os_str().is_empty() {
            self.local_workspace_root = self.executor_home.join("workspace");
        }
    }

    /// Heal configs whose backend URL points at the device's own loopback.
    ///
    /// Startup commands generated before the backend public URL was configured
    /// bake in `http://localhost:8000`, which is unreachable from a remote
    /// device. The Socket.IO URL provably works (the device is connected), so
    /// reuse its origin for HTTP callbacks and cloud model proxy calls.
    fn derive_backend_url_from_socket(&mut self) {
        let backend_url = self.connection.backend_url.trim();
        if backend_url.is_empty() || !url_host_is_loopback(backend_url) {
            return;
        }
        let socket_url = self.connection.socket_url.trim();
        if socket_url.is_empty() || url_host_is_loopback(socket_url) {
            return;
        }
        if let Some(origin) = http_origin_from_socket(socket_url) {
            eprintln!(
                "[device-config] backend_url {backend_url} is loopback; \
                 deriving {origin} from socket_url"
            );
            self.connection.backend_url = origin;
        }
    }
}

fn url_host_is_loopback(raw: &str) -> bool {
    url::Url::parse(raw)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
        })
}

fn http_origin_from_socket(raw: &str) -> Option<String> {
    let mut parsed = url::Url::parse(raw).ok()?;
    match parsed.scheme() {
        "ws" => parsed.set_scheme("http").ok()?,
        "wss" => parsed.set_scheme("https").ok()?,
        "http" | "https" => {}
        _ => return None,
    }
    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.to_string().trim_end_matches('/').to_owned())
}

pub(crate) fn worktree_persistent_storage_verified() -> bool {
    let device_type = EFFECTIVE_DEVICE_TYPE
        .get()
        .and_then(|device_type| device_type.read().ok().map(|value| value.clone()))
        .unwrap_or_else(|| env::var("DEVICE_TYPE").unwrap_or_else(|_| default_device_type()));
    let verification = env::var("WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED").ok();
    worktree_persistent_storage_verified_for(&device_type, verification.as_deref())
}

fn worktree_persistent_storage_verified_for(device_type: &str, verification: Option<&str>) -> bool {
    match device_type.trim().to_ascii_lowercase().as_str() {
        "local" | "app" | "" => true,
        "cloud" | "remote" => verification
            .map(str::trim)
            .is_some_and(|value| value.eq_ignore_ascii_case("true")),
        _ => false,
    }
}

pub fn load_device_config(config_path: Option<&str>) -> Result<DeviceConfig, ConfigError> {
    let path = config_path
        .map(PathBuf::from)
        .unwrap_or_else(default_config_path);
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|source| ConfigError::Write {
        path: path.clone(),
        source,
    })?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("json.lock"))
        .map_err(|source| ConfigError::Write {
            path: path.clone(),
            source,
        })?;
    lock.lock_exclusive().map_err(|source| ConfigError::Write {
        path: path.clone(),
        source,
    })?;
    let (mut config, mut should_save) = if let Some(config) = read_config_path(&path)? {
        (config, false)
    } else {
        (DeviceConfig::default(), true)
    };

    if config.executor_home.as_os_str().is_empty() {
        config.executor_home = default_executor_home();
    }
    if config.local_workspace_root.as_os_str().is_empty() {
        config.local_workspace_root = config.executor_home.join("workspace");
    }

    config.apply_env_overrides();
    config.derive_backend_url_from_socket();
    remember_effective_device_type(&config.device_type);
    should_save |= ensure_stable_identity(&mut config);

    if should_save {
        save_config_path(&path, &config)?;
    }

    Ok(config)
}

fn remember_effective_device_type(device_type: &str) {
    let effective = EFFECTIVE_DEVICE_TYPE.get_or_init(|| RwLock::new(default_device_type()));
    if let Ok(mut value) = effective.write() {
        *value = device_type.trim().to_owned();
    }
}

fn read_config_path(path: &Path) -> Result<Option<DeviceConfig>, ConfigError> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|source| ConfigError::Read {
        path: path.to_owned(),
        source,
    })?;
    let config = serde_json::from_str(&content).map_err(|source| ConfigError::Parse {
        path: path.to_owned(),
        source,
    })?;
    Ok(Some(config))
}

fn set_from_env(target: &mut String, name: &str) {
    if let Ok(value) = env::var(name) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            *target = trimmed.to_owned();
        }
    }
}

fn ensure_stable_identity(config: &mut DeviceConfig) -> bool {
    let mut changed = false;
    if config.device_id.trim().is_empty() {
        config.device_id = if config.device_type == "app"
            || env::var("WEGENT_APP_IPC_DEVICE_ID").is_ok_and(|id| !id.trim().is_empty())
        {
            uuid::Uuid::new_v4().to_string()
        } else {
            generate_prefixed_id("device")
        };
        changed = true;
    }
    if config.runtime_instance_id.trim().is_empty() {
        config.runtime_instance_id = generate_prefixed_id("runtime");
        changed = true;
    }
    if config.device_name.trim().is_empty() {
        config.device_name = default_device_name(&config.device_id);
        changed = true;
    }
    changed
}

fn save_config_path(path: &Path, config: &DeviceConfig) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| ConfigError::Write {
            path: path.to_owned(),
            source,
        })?;
    }
    let content = serde_json::to_string_pretty(config).map_err(|source| ConfigError::Parse {
        path: path.to_owned(),
        source,
    })?;
    let write = || -> std::io::Result<()> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        writeln!(temporary, "{content}")?;
        temporary.as_file().sync_all()?;
        temporary.persist(path).map_err(|error| error.error)?;
        Ok(())
    };
    write().map_err(|source| ConfigError::Write {
        path: path.to_owned(),
        source,
    })
}

fn generate_prefixed_id(prefix: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let host = env::var("HOSTNAME")
        .or_else(|_| env::var("COMPUTERNAME"))
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(now.to_string().as_bytes());
    hasher.update(std::process::id().to_string().as_bytes());
    hasher.update(host.as_bytes());
    let digest = hasher.finalize();
    let mut suffix = String::with_capacity(24);
    for byte in digest.iter().take(12) {
        suffix.push_str(&format!("{byte:02x}"));
    }
    format!("{prefix}-{suffix}")
}

fn default_device_name(device_id: &str) -> String {
    let os_name = match env::consts::OS {
        "macos" => "macOS",
        "linux" => "Linux",
        "windows" => "Windows",
        other => other,
    };
    let suffix = last_chars(device_id, 12);
    format!("{os_name}-Device-{suffix}")
}

fn last_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars().rev().take(max_chars).collect::<Vec<_>>();
    chars.reverse();
    chars.into_iter().collect()
}

fn non_empty_str(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn default_config_path() -> PathBuf {
    default_executor_home().join("device-config.json")
}

fn default_executor_home() -> PathBuf {
    env::var("WEGENT_EXECUTOR_HOME")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".wegent-executor"))
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn default_mode() -> String {
    "local".to_owned()
}

fn default_device_type() -> String {
    "local".to_owned()
}

fn default_bind_shell() -> String {
    "claudecode".to_owned()
}

fn default_log_level() -> String {
    "info".to_owned()
}

fn default_log_max_size() -> u32 {
    10
}

fn default_log_backup_count() -> u32 {
    5
}

#[cfg(test)]
mod tests {
    use super::{
        worktree_persistent_storage_verified_for, DeviceConfig,
    };

    #[test]
    fn local_and_app_worktrees_default_to_verified_storage() {
        assert!(worktree_persistent_storage_verified_for("local", None));
        assert!(worktree_persistent_storage_verified_for(
            "APP",
            Some("false")
        ));
    }

    #[test]
    fn cloud_and_remote_worktrees_require_explicit_true_verification() {
        for device_type in ["cloud", "remote"] {
            assert!(!worktree_persistent_storage_verified_for(device_type, None));
            assert!(!worktree_persistent_storage_verified_for(
                device_type,
                Some("false")
            ));
            assert!(!worktree_persistent_storage_verified_for(
                device_type,
                Some("1")
            ));
            assert!(worktree_persistent_storage_verified_for(
                device_type,
                Some(" TRUE ")
            ));
        }
    }

    #[test]
    fn unknown_device_types_fail_closed() {
        assert!(!worktree_persistent_storage_verified_for(
            "future-device",
            Some("true")
        ));
    }

    fn config_with_urls(backend: &str, socket: &str) -> DeviceConfig {
        let mut config = DeviceConfig::default();
        config.connection.backend_url = backend.to_owned();
        config.connection.socket_url = socket.to_owned();
        config
    }

    #[test]
    fn loopback_backend_url_is_derived_from_remote_socket_url() {
        let mut config =
            config_with_urls("http://localhost:8000", "wss://backend.example.com/ws");
        config.derive_backend_url_from_socket();
        assert_eq!(config.connection.backend_url, "https://backend.example.com");
    }

    #[test]
    fn loopback_backend_url_keeps_socket_port() {
        let mut config =
            config_with_urls("http://127.0.0.1:8000", "ws://lan-backend.internal:9000");
        config.derive_backend_url_from_socket();
        assert_eq!(
            config.connection.backend_url,
            "http://lan-backend.internal:9000"
        );
    }

    #[test]
    fn non_loopback_backend_url_is_never_rewritten() {
        let mut config =
            config_with_urls("https://api.internal", "wss://socket.other.example");
        config.derive_backend_url_from_socket();
        assert_eq!(config.connection.backend_url, "https://api.internal");
    }

    #[test]
    fn loopback_backend_url_stays_when_socket_is_also_loopback() {
        let mut config = config_with_urls("http://localhost:8000", "ws://localhost:8000");
        config.derive_backend_url_from_socket();
        assert_eq!(config.connection.backend_url, "http://localhost:8000");
    }

    #[test]
    fn empty_backend_url_is_not_invented() {
        let mut config = config_with_urls("", "wss://backend.example.com");
        config.derive_backend_url_from_socket();
        assert_eq!(config.connection.backend_url, "");
    }
}
