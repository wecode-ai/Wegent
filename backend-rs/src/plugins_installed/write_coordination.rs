// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared protocol with Python's plugin-write coordinator. The lease only
//! covers this user's plugin writes; it never locks the `users` table.

use std::time::Duration;

use brz_mysql::{FromMysqlRow, Mysql, MysqlError, MysqlResult, MysqlTransaction};
use brz_redis::{Redis, SetExpiration, SetOptions};
use tokio::time::Instant;

use crate::http_compat::FastApiError;

const LEASE_SECONDS: u64 = 30;
const ACQUIRE_WAIT: Duration = Duration::from_secs(3);
// A bounded operation avoids keeping a renewal task alive after cancellation.
// Business-record revision checks reject conflicting suspended writers.
const OPERATION_BUDGET: Duration = Duration::from_secs(20);
const RELEASE_SCRIPT: &str = "if redis.call('get', KEYS[1]) == ARGV[1] then \
    return redis.call('del', KEYS[1]) else return 0 end";
const CHECK_SCRIPT: &str = "if redis.call('get', KEYS[1]) == ARGV[1] then \
    return 1 else return 0 end";
const POLICY_QUERY: &str = "SELECT id, json, is_active FROM kinds WHERE user_id = ? AND kind = \
    'ConnectorAuthPolicy' AND namespace = 'plugin-auth' AND name = \
    'account'";

pub(super) struct PluginWriteLease<'a, R: Redis> {
    redis: &'a R,
    key: String,
    token: String,
    user_id: i64,
    pub deadline: Instant,
}

#[derive(Debug, FromMysqlRow)]
struct PolicyRow {
    id: i64,
    json: serde_json::Value,
    is_active: bool,
}

/// The existing account policy is the shared parent of this user's plugin
/// writes. Its revision protects decisions spanning multiple business rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PluginWriteRevision {
    id: i64,
    revision: i64,
}

pub(super) fn business_revision(document: &serde_json::Value) -> MysqlResult<i64> {
    match document.get("spec").and_then(|spec| spec.get("revision")) {
        None => Ok(0),
        Some(value) => value
            .as_i64()
            .filter(|revision| *revision >= 0 && *revision < i64::MAX)
            .ok_or_else(|| coordination_error("plugin_write_conflict")),
    }
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

    /// Lazily create the existing account policy without changing an existing
    /// opt-out or revision. The plugin identity's unique index makes initial
    /// creation safe even when an expired lease overlaps its successor.
    pub async fn ensure_policy<M: Mysql>(&self, mysql: &M) -> MysqlResult<()> {
        tokio::time::timeout(
            ACQUIRE_WAIT,
            mysql.with_transaction(async |transaction| {
                let existing: Option<PolicyRow> = transaction
                    .fetch_optional(POLICY_QUERY, (self.user_id,))
                    .await?;
                if let Some(row) = existing {
                    if row.is_active {
                        return Ok(());
                    }
                    // A deactivated policy row keeps the user's stored
                    // preference; only restore the row's active flag.
                    return transaction
                        .execute(
                            "UPDATE kinds SET is_active = true, updated_at = NOW() \
                             WHERE id = ? AND is_active IS false",
                            (row.id,),
                        )
                        .await
                        .map(|_| ());
                }
                transaction
                    .execute(
                        "INSERT INTO kinds (user_id, kind, namespace, name, json, is_active, \
                         created_at, updated_at) VALUES (?, 'ConnectorAuthPolicy', \
                         'plugin-auth', 'account', \
                         '{\"spec\":{\"enabled\":true,\"revision\":0}}', \
                         true, NOW(), NOW()) ON DUPLICATE KEY UPDATE id = id",
                        (self.user_id,),
                    )
                    .await
                    .map(|_| ())
            }),
        )
        .await
        .unwrap_or_else(|_| Err(coordination_error("plugin_write_busy")))
    }

    /// Read before any installation state. An ordinary read creates no row
    /// lock; the final atomic update validates this transaction's snapshot.
    pub async fn read_revision<T: MysqlTransaction>(
        &self,
        transaction: &mut T,
    ) -> MysqlResult<PluginWriteRevision> {
        let row: PolicyRow = transaction
            .fetch_optional(POLICY_QUERY, (self.user_id,))
            .await?
            .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
        if !row.is_active
            || !row
                .json
                .get("spec")
                .is_some_and(serde_json::Value::is_object)
        {
            return Err(coordination_error("plugin_write_conflict"));
        }
        Ok(PluginWriteRevision {
            id: row.id,
            revision: business_revision(&row.json)?,
        })
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

    /// Validate the shared business parent as the final statement before
    /// COMMIT. A changed revision rolls back every write in the transaction.
    pub async fn commit_revision<T: MysqlTransaction>(
        &self,
        transaction: &mut T,
        expected: PluginWriteRevision,
    ) -> MysqlResult<()> {
        self.verify_owned().await?;
        let result = transaction
            .execute(
                "UPDATE kinds SET json = JSON_SET(json, '$.spec.revision', ?), \
                 updated_at = NOW() WHERE id = ? AND user_id = ? AND kind = \
                 'ConnectorAuthPolicy' AND namespace = 'plugin-auth' AND name = \
                 'account' AND is_active IS true AND \
                 COALESCE(JSON_EXTRACT(json, '$.spec.revision'), 0) = ?",
                (
                    expected.revision + 1,
                    expected.id,
                    self.user_id,
                    expected.revision,
                ),
            )
            .await?;
        if result.rows_affected == 1 {
            Ok(())
        } else {
            Err(coordination_error("plugin_write_conflict"))
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
            "plugin_write_busy"
                | "plugin_write_unavailable"
                | "plugin_write_lease_lost"
                | "plugin_write_conflict"
        )
    {
        return FastApiError::detail(brz_http_server::StatusCode::SERVICE_UNAVAILABLE, reason)
            .with_header("cache-control", "no-store".to_string());
    }
    tracing::error!(
        db_errno = error.database_code(),
        "plugin auto update transaction failed"
    );
    FastApiError::unhandled()
}

#[cfg(test)]
#[path = "write_coordination_tests.rs"]
mod tests;
