// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application-owned Redis configuration and process-lifetime services.
use crate::config::RedisConfig;
use brz_redis::{RedisResult, RedisService, RedisServiceOptions};
use std::time::Duration;

pub async fn shared(config: &RedisConfig) -> RedisResult<RedisService> {
    let options = RedisServiceOptions::default()
        .with_password(config.password.clone())
        .with_timeout(Duration::from_secs(5));
    let endpoint = format!("{}:{}:{}", config.host, config.port, config.db);
    RedisService::noshard_with_options(endpoint.clone(), [endpoint], options).await
}
