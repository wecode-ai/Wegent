// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared protocol with Python's plugin-write coordinator. The lease only
//! covers this user's plugin writes; it never locks the `users` table.

use std::time::Duration;

use brz_mysql::{Mysql, MysqlError, MysqlResult, MysqlTransaction};
use brz_redis::{Redis, SetExpiration, SetOptions};
use tokio::time::Instant;

use crate::http_compat::FastApiError;

const LEASE_SECONDS: u64 = 30;
const ACQUIRE_WAIT: Duration = Duration::from_secs(3);
// A bounded operation avoids keeping a renewal task alive after cancellation.
// The durable fence also rejects a suspended worker after ownership changes.
const OPERATION_BUDGET: Duration = Duration::from_secs(20);
const RELEASE_SCRIPT: &str = "if redis.call('get', KEYS[1]) == ARGV[1] then \
    return redis.call('del', KEYS[1]) else return 0 end";
const CHECK_SCRIPT: &str = "if redis.call('get', KEYS[1]) == ARGV[1] then \
    return 1 else return 0 end";

pub(super) struct PluginWriteLease<'a, R: Redis> {
    redis: &'a R,
    key: String,
    token: String,
    user_id: i64,
    pub deadline: Instant,
}

impl<'a, R: Redis> PluginWriteLease<'a, R> {
    pub async fn acquire(redis: Option<&'a R>, user_id: i64) -> MysqlResult<Self> {
        let redis = redis.ok_or_else(|| coordination_error("plugin_write_unavailable"))?;
        let mut random = [0_u8; 16];
        getrandom::getrandom(&mut random)
            .map_err(|_| coordination_error("plugin_write_unavailable"))?;
        let token = random.iter().map(|byte| format!("{byte:02x}")).collect();
        Self::acquire_token(redis, user_id, token, ACQUIRE_WAIT).await
    }

    async fn acquire_token(
        redis: &'a R,
        user_id: i64,
        token: String,
        wait: Duration,
    ) -> MysqlResult<Self> {
        let key = format!("wegent:plugin-write:{user_id}");
        let acquire_deadline = Instant::now() + wait;
        loop {
            let result = tokio::time::timeout_at(
                acquire_deadline,
                redis.set_with(
                    key.as_str(),
                    token.as_str(),
                    SetOptions::default()
                        .if_absent()
                        .with_expiration(SetExpiration::Seconds(LEASE_SECONDS)),
                ),
            )
            .await;
            match result {
                Ok(Ok(true)) => {
                    return Ok(Self {
                        redis,
                        key,
                        token,
                        user_id,
                        deadline: Instant::now() + OPERATION_BUDGET,
                    });
                }
                Ok(Ok(false)) => {}
                Ok(Err(_)) => return Err(coordination_error("plugin_write_unavailable")),
                Err(_) => return Err(coordination_error("plugin_write_busy")),
            }
            if Instant::now() >= acquire_deadline {
                return Err(coordination_error("plugin_write_busy"));
            }
            tokio::time::sleep_until(
                (Instant::now() + Duration::from_millis(50)).min(acquire_deadline),
            )
            .await;
        }
    }

    /// Claim in an independent, short transaction before reading installation
    /// state. A new owner invalidates every earlier worker's commit token.
    pub async fn claim_fence<M: Mysql>(&self, mysql: &M) -> MysqlResult<()> {
        tokio::time::timeout(
            ACQUIRE_WAIT,
            mysql.with_transaction(async |transaction| {
                transaction
                    .execute(
                        "INSERT INTO plugin_write_fences (user_id, token) VALUES (?, ?) \
                         ON DUPLICATE KEY UPDATE token = VALUES(token)",
                        (self.user_id, self.token.as_str()),
                    )
                    .await
                    .map(|_| ())
            }),
        )
        .await
        .unwrap_or_else(|_| Err(coordination_error("plugin_write_busy")))
    }

    pub async fn verify_owned(&self) -> MysqlResult<()> {
        if Instant::now() >= self.deadline {
            return Err(coordination_error("plugin_write_lease_lost"));
        }
        let owned: i64 = self
            .redis
            .eval(CHECK_SCRIPT, [self.key.as_str()], [self.token.as_str()])
            .await
            .map_err(|_| coordination_error("plugin_write_unavailable"))?;
        if owned == 1 {
            Ok(())
        } else {
            Err(coordination_error("plugin_write_lease_lost"))
        }
    }

    /// The final statement before COMMIT changes the value, so affected-row
    /// semantics work with both CLIENT_FOUND_ROWS settings and RR snapshots.
    pub async fn fence_commit<T: MysqlTransaction>(&self, transaction: &mut T) -> MysqlResult<()> {
        self.verify_owned().await?;
        let result = transaction
            .execute(
                "UPDATE plugin_write_fences SET token = ? WHERE user_id = ? AND token = ?",
                (
                    format!("{}:committed", self.token),
                    self.user_id,
                    self.token.as_str(),
                ),
            )
            .await?;
        if result.rows_affected == 1 {
            Ok(())
        } else {
            Err(coordination_error("plugin_write_lease_lost"))
        }
    }

    pub async fn release(self) {
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            self.redis.eval::<_, _, _, i64>(
                RELEASE_SCRIPT,
                [self.key.as_str()],
                [self.token.as_str()],
            ),
        )
        .await;
        if !matches!(result, Ok(Ok(_))) {
            // Once committed, unlock failure must not turn success into an
            // error. Redis expiry bounds cleanup after failure/cancellation.
            tracing::warn!(user_id = self.user_id, "plugin write lease cleanup failed");
        }
    }
}

pub(super) fn coordination_error(code: &str) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: code.to_string(),
    }
}

pub(super) fn http_error(error: MysqlError) -> FastApiError {
    if let MysqlError::InvalidQuery { reason } = &error
        && matches!(
            reason.as_str(),
            "plugin_write_busy" | "plugin_write_unavailable" | "plugin_write_lease_lost"
        )
    {
        return FastApiError::detail(brz_http_server::StatusCode::SERVICE_UNAVAILABLE, reason)
            .with_header("cache-control", "no-store".to_string());
    }
    tracing::error!(
        db_errno = error.database_code(),
        "plugin auto update transaction failed"
    );
    FastApiError::internal()
}

#[cfg(test)]
#[path = "write_coordination_tests.rs"]
mod tests;
