// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Source-compatible configuration loading from the application environment.

use std::env;

use anyhow::{Context as _, Result};

/// The application-owned variables the implemented endpoints require. Values
/// come from the normal environment (source snapshot plus target overrides);
/// none are read from traffic artifacts.
#[derive(Debug, Clone)]
pub struct AppConfig {
    pub redis_cache_url: String,
    pub redis_slave_url: Option<String>,
    pub executor_manager_url: String,
    pub jwt_algorithm: String,
    pub jwt_zinfoid_05q_key: String,
    pub jwt_legacy_zinfoid_05q_keys: Vec<String>,
}

impl AppConfig {
    pub fn from_env() -> Result<Self> {
        let redis_cache_url =
            env::var("REDIS_URL").context("REDIS_URL is required for kind/user caches")?;
        let redis_slave_url = env::var("REDIS_SLAVE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let executor_manager_url = env::var("EXECUTOR_MANAGER_URL")
            .context("EXECUTOR_MANAGER_URL is required for sandbox status queries")?;
        let jwt_algorithm = env::var("ALGORITHM").unwrap_or_else(|_| "HS256".to_string());
        let jwt_zinfoid_05q_key =
            env::var("SECRET_KEY").context("SECRET_KEY is required to verify session tokens")?;
        let jwt_legacy_zinfoid_05q_keys = env::var("JWT_LEGACY_SECRET_KEYS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(ToOwned::to_owned)
            .collect();

        Ok(Self {
            redis_cache_url,
            redis_slave_url,
            executor_manager_url,
            jwt_algorithm,
            jwt_zinfoid_05q_key,
            jwt_legacy_zinfoid_05q_keys,
        })
    }
}
