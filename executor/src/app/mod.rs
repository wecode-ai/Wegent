// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub mod cli;

use crate::config::device::{load_device_config, DeviceConfig, RuntimeMode};
use crate::local::{
    app_ipc::{normalize_device_id, serve_app_ipc_sidecar},
    backend::serve_local_backend_sidecar,
};
use crate::logging::init_executor_logging;
use crate::server::{self, ServerConfig};
use crate::services::updater::UpdaterService;
use crate::version::get_version;
use cli::CliArgs;
use std::env;
use std::fmt;
use std::net::SocketAddr;

#[derive(Debug)]
pub enum AppError {
    Cli(cli::CliError),
    Config(crate::config::device::ConfigError),
    NotImplemented(&'static str),
    Server(String),
    ServerConfig(crate::server::ServerConfigError),
    Upgrade(String),
}

impl AppError {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Cli(_) => 2,
            Self::Config(_) => 1,
            Self::NotImplemented(_) => 2,
            Self::Server(_) => 1,
            Self::ServerConfig(_) => 1,
            Self::Upgrade(_) => 1,
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cli(error) => write!(formatter, "{error}"),
            Self::Config(error) => write!(formatter, "{error}"),
            Self::NotImplemented(feature) => {
                write!(
                    formatter,
                    "{feature} is not implemented in the Rust executor yet"
                )
            }
            Self::Server(error) => write!(formatter, "{error}"),
            Self::ServerConfig(error) => write!(formatter, "{error}"),
            Self::Upgrade(error) => write!(formatter, "{error}"),
        }
    }
}

impl From<cli::CliError> for AppError {
    fn from(error: cli::CliError) -> Self {
        Self::Cli(error)
    }
}

impl From<crate::config::device::ConfigError> for AppError {
    fn from(error: crate::config::device::ConfigError) -> Self {
        Self::Config(error)
    }
}

impl From<crate::server::ServerConfigError> for AppError {
    fn from(error: crate::server::ServerConfigError) -> Self {
        Self::ServerConfig(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupPlan {
    DockerServer {
        host: String,
        port: u16,
    },
    LocalSidecar {
        backend_enabled: bool,
        device_id: String,
    },
}

impl StartupPlan {
    pub fn bind_addr(&self) -> Result<SocketAddr, AppError> {
        self.server_config()?.bind_addr().map_err(AppError::from)
    }

    fn server_config(&self) -> Result<ServerConfig, AppError> {
        match self {
            Self::DockerServer { host, port } => Ok(ServerConfig {
                host: host.clone(),
                port: *port,
            }),
            Self::LocalSidecar { .. } => Err(AppError::NotImplemented("Local sidecar server")),
        }
    }
}

pub async fn run_from_env() -> Result<(), AppError> {
    let args = CliArgs::parse_from(env::args())?;
    run(args).await
}

pub async fn run(args: CliArgs) -> Result<(), AppError> {
    if args.help {
        println!("{}", CliArgs::usage());
        return Ok(());
    }

    if args.version {
        println!("{}", get_version());
        return Ok(());
    }

    if args.upgrade {
        let config = load_device_config(args.config_path.as_deref())?;
        return run_upgrade(config.update, args.yes).await;
    }

    init_executor_logging(&DeviceConfig::default());
    let config = load_device_config(args.config_path.as_deref())?;
    init_executor_logging(&config);
    match startup_plan_for_config(&config)? {
        plan @ StartupPlan::DockerServer { .. } => server::serve(plan.server_config()?)
            .await
            .map_err(AppError::Server),
        StartupPlan::LocalSidecar {
            backend_enabled: true,
            ..
        } => serve_local_backend_sidecar(config)
            .await
            .map_err(AppError::Server),
        StartupPlan::LocalSidecar { device_id, .. } => serve_app_ipc_sidecar(device_id)
            .await
            .map_err(AppError::Server),
    }
}

async fn run_upgrade(
    update_config: crate::config::device::UpdateConfig,
    auto_confirm: bool,
) -> Result<(), AppError> {
    println!("wegent-executor v{}", get_version());
    println!();

    let result = UpdaterService::new(update_config, auto_confirm)
        .check_and_update()
        .await;
    if result.success {
        if result.already_latest {
            println!("Already running the latest version");
        } else {
            println!("Update complete!");
            println!("Please restart the executor:");
            println!("  wegent-executor");
        }
        return Ok(());
    }

    Err(AppError::Upgrade(format!(
        "Update failed: {}",
        result.error.unwrap_or_else(|| "unknown error".to_owned())
    )))
}

pub fn startup_plan(args: CliArgs) -> Result<StartupPlan, AppError> {
    let config = load_device_config(args.config_path.as_deref())?;
    startup_plan_for_config(&config)
}

fn startup_plan_for_config(
    config: &crate::config::device::DeviceConfig,
) -> Result<StartupPlan, AppError> {
    match config.runtime_mode() {
        RuntimeMode::Docker => {
            let server = ServerConfig::from_env()?;
            Ok(StartupPlan::DockerServer {
                host: server.host,
                port: server.port,
            })
        }
        RuntimeMode::Local => Ok(StartupPlan::LocalSidecar {
            backend_enabled: !config.connection.backend_url.trim().is_empty(),
            device_id: normalize_device_id(config.device_id.clone()),
        }),
    }
}
