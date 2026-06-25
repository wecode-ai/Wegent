// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};
use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

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
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionConfig {
    #[serde(default)]
    pub backend_url: String,
    #[serde(default)]
    pub auth_token: String,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateConfig {
    #[serde(default, alias = "url")]
    pub registry: String,
    #[serde(default, alias = "token")]
    pub registry_token: String,
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
    pub device_name: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default = "default_max_concurrent_tasks")]
    pub max_concurrent_tasks: u32,
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
            device_name: String::new(),
            capabilities: Vec::new(),
            max_concurrent_tasks: default_max_concurrent_tasks(),
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
        if self.mode.trim().eq_ignore_ascii_case("docker") {
            RuntimeMode::Docker
        } else {
            RuntimeMode::Local
        }
    }

    fn apply_env_overrides(&mut self) {
        set_from_env(&mut self.mode, "EXECUTOR_MODE");
        set_from_env(&mut self.connection.backend_url, "WEGENT_BACKEND_URL");
        set_from_env(&mut self.connection.auth_token, "WEGENT_AUTH_TOKEN");
        set_from_env(&mut self.device_id, "DEVICE_ID");
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
}

pub fn load_device_config(config_path: Option<&str>) -> Result<DeviceConfig, ConfigError> {
    let mut config = if let Some(path) = config_path {
        read_config_path(Path::new(path))?.unwrap_or_default()
    } else {
        let path = default_config_path();
        read_config_path(&path)?.unwrap_or_default()
    };

    if config.executor_home.as_os_str().is_empty() {
        config.executor_home = default_executor_home();
    }
    if config.local_workspace_root.as_os_str().is_empty() {
        config.local_workspace_root = config.executor_home.join("workspace");
    }

    config.apply_env_overrides();
    Ok(config)
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
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
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

fn default_max_concurrent_tasks() -> u32 {
    5
}
