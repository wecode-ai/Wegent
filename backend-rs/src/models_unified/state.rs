// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Request dependencies supplied by the application at startup.
use super::config::AppConfig;
use crate::erp_provider::ErpProvider;
use anyhow::{Context as _, Result};
use brz_mysql::Mysql;
use brz_redis::Redis;
use std::sync::Arc;

pub struct AppState<M: Mysql, R: Redis> {
    pub mysql: M,
    pub redis: Option<R>,
    pub erp: Arc<dyn ErpProvider<R> + Send + Sync>,
    pub jwt: JwtConfig,
}

impl<M: Mysql, R: Redis> AppState<M, R> {
    pub fn redis(&self) -> Option<&R> {
        self.redis.as_ref()
    }
}

#[derive(Clone)]
pub struct JwtConfig {
    pub algorithm: jsonwebtoken::Algorithm,
    pub decode_keys: Vec<String>,
}

pub fn build_state<M: Mysql, R: Redis>(
    config: &AppConfig,
    mysql: M,
    redis: Option<R>,
    erp: Arc<dyn ErpProvider<R> + Send + Sync>,
) -> Result<AppState<M, R>> {
    let jwt = build_jwt_config(config)?;
    Ok(AppState {
        mysql,
        redis,
        erp,
        jwt,
    })
}

fn build_jwt_config(config: &AppConfig) -> Result<JwtConfig> {
    let algorithm = config
        .algorithm
        .parse()
        .with_context(|| format!("unsupported JWT algorithm {}", config.algorithm))?;
    let mut decode_keys = vec![config.jwt_key.clone()];
    for legacy in &config.jwt_legacy_keys {
        if !legacy.is_empty() && !decode_keys.contains(legacy) {
            decode_keys.push(legacy.clone());
        }
    }
    Ok(JwtConfig {
        algorithm,
        decode_keys,
    })
}
