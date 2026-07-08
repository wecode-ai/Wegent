// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub mod cli;

use crate::config::device::{load_device_config, DeviceConfig};
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
    Server(String),
    ServerConfig(crate::server::ServerConfigError),
    Upgrade(String),
}

impl AppError {
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Cli(_) => 2,
            Self::Config(_) => 1,
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
pub struct StartupPlan {
    pub http_server: Option<HttpServerPlan>,
    pub socket_sidecar: Option<SocketSidecarPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpServerPlan {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocketSidecarPlan {
    pub backend_enabled: bool,
    pub device_id: String,
}

impl HttpServerPlan {
    pub fn bind_addr(&self) -> Result<SocketAddr, AppError> {
        self.server_config().bind_addr().map_err(AppError::from)
    }

    fn server_config(&self) -> ServerConfig {
        ServerConfig {
            host: self.host.clone(),
            port: self.port,
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
    let plan = startup_plan_for_config(&config)?;

    match (plan.http_server, plan.socket_sidecar) {
        (Some(http_server), None) => server::serve(http_server.server_config())
            .await
            .map_err(AppError::Server),
        (None, Some(socket_sidecar)) => serve_socket_sidecar(config, socket_sidecar)
            .await
            .map_err(AppError::Server),
        (Some(http_server), Some(socket_sidecar)) => {
            let server_config = http_server.server_config();
            let socket_sidecar_future = serve_socket_sidecar(config, socket_sidecar);
            tokio::select! {
                result = server::serve(server_config) => result.map_err(AppError::Server),
                result = socket_sidecar_future => result.map_err(AppError::Server),
            }
        }
        (None, None) => Err(AppError::Server(
            "startup plan has no runtime target".to_owned(),
        )),
    }
}

async fn serve_socket_sidecar(
    config: crate::config::device::DeviceConfig,
    plan: SocketSidecarPlan,
) -> Result<(), String> {
    if plan.backend_enabled {
        serve_local_backend_sidecar(config).await
    } else {
        serve_app_ipc_sidecar(plan.device_id, config.runtime_instance_id).await
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
    if config.runtime_mode() == crate::config::device::RuntimeMode::Docker {
        let server = ServerConfig::from_env()?;
        return Ok(StartupPlan {
            http_server: Some(HttpServerPlan {
                host: server.host,
                port: server.port,
            }),
            socket_sidecar: None,
        });
    }

    Ok(StartupPlan {
        http_server: Some(HttpServerPlan {
            host: "127.0.0.1".to_owned(),
            port: 0,
        }),
        socket_sidecar: Some(SocketSidecarPlan {
            backend_enabled: !config.connection.backend_url.trim().is_empty(),
            device_id: normalize_device_id(config.device_id.clone()),
        }),
    })
}
