// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Request dependencies supplied by the application at startup.
use super::config::AppConfig;
use anyhow::{Context as _, Result};
use brz_mysql::Mysql;
use brz_redis::Redis;

pub struct AppState<M: Mysql, R: Redis> {
    pub mysql: M,
    pub redis: Option<R>,
    /// Entity-resolver registry used by the shared group-membership batch.
    pub entity_resolvers: crate::permissions::EntityResolvers<R>,
    #[allow(dead_code, reason = "authentication now runs through AppAuthenticator")]
    pub jwt: JwtConfig,
}

impl<M: Mysql, R: Redis> AppState<M, R> {
    pub fn redis(&self) -> Option<&R> {
        self.redis.as_ref()
    }
}

#[derive(Clone)]
#[allow(
    dead_code,
    reason = "retained for source-compatible state construction"
)]
pub struct JwtConfig {
    pub algorithm: jsonwebtoken::Algorithm,
    pub decode_keys: Vec<String>,
}

pub fn build_state<M: Mysql, R: Redis>(
    config: &AppConfig,
    mysql: M,
    redis: Option<R>,
    entity_resolvers: crate::permissions::EntityResolvers<R>,
) -> Result<AppState<M, R>> {
    let jwt = build_jwt_config(config)?;
    Ok(AppState {
        mysql,
        redis,
        entity_resolvers,
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
