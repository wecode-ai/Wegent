// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, fmt, net::SocketAddr};

const DEFAULT_HOST: &str = "0.0.0.0";
const DEFAULT_PORT: u16 = 10001;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

impl ServerConfig {
    pub fn from_env() -> Result<Self, ServerConfigError> {
        Ok(Self {
            host: read_host(),
            port: read_port()?,
        })
    }

    pub fn bind_addr(&self) -> Result<SocketAddr, ServerConfigError> {
        let value = format!("{}:{}", self.host, self.port);
        value
            .parse()
            .map_err(|_| ServerConfigError::InvalidBindAddress { value })
    }
}

#[derive(Debug)]
pub enum ServerConfigError {
    InvalidPort { value: String },
    InvalidBindAddress { value: String },
}

impl fmt::Display for ServerConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPort { value } => write!(formatter, "invalid PORT: {value}"),
            Self::InvalidBindAddress { value } => {
                write!(formatter, "invalid server bind address: {value}")
            }
        }
    }
}

impl std::error::Error for ServerConfigError {}

fn read_host() -> String {
    env::var("HOST")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_HOST.to_owned())
}

fn read_port() -> Result<u16, ServerConfigError> {
    let Some(value) = env::var("PORT").ok().filter(|value| !value.is_empty()) else {
        return Ok(DEFAULT_PORT);
    };

    value
        .parse()
        .map_err(|_| ServerConfigError::InvalidPort { value })
}
