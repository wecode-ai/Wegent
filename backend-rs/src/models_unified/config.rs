// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Source-compatible runtime configuration.
//!
//! Recovers the source `Settings` subset required by `GET /api/models/unified`
//! from the application environment. Defaults mirror the source defaults in
//! `app/core/config.py`; the effective deployment values come from the
//! captured source environment and `.env` file mounted at startup.
use std::env;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub redis_url: String,
    pub redis_slave_url: Option<String>,
    pub jwt_key: String,
    pub jwt_legacy_keys: Vec<String>,
    pub algorithm: String,
}

impl AppConfig {
    /// Load from the process environment with source-compatible defaults.
    pub fn from_env() -> Self {
        Self {
            redis_url: env_or("REDIS_URL", "redis://127.0.0.1:6379/0"),
            redis_slave_url: env::var("REDIS_SLAVE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            jwt_key: env_or("SECRET_KEY", "secret-key"),
            jwt_legacy_keys: env::var("JWT_LEGACY_SECRET_KEYS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(ToOwned::to_owned)
                .collect(),
            algorithm: env_or("ALGORITHM", "HS256"),
        }
    }
}

fn env_or(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_string())
}
