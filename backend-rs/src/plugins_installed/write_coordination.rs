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

mod scoped;
pub(crate) use scoped::installation_write_revision;

const LEASE_SECONDS: u64 = 30;
const ACQUIRE_WAIT: Duration = Duration::from_secs(3);
/// redis-py `Lock.acquire`'s default `sleep` (`redis/lock.py`): a blocked
/// acquisition retries one `SET ... NX PX` every 100ms and gives up when the
/// next attempt would pass `blocking_timeout`. The recorded source lease
/// polls at this cadence, so matching it keeps the replayed attempt count and
/// phase identical to the recorded retry loop.
const ACQUIRE_RETRY: Duration = Duration::from_millis(100);
// A bounded operation avoids keeping a renewal task alive after cancellation.
// Business-record revision checks reject conflicting suspended writers.
const OPERATION_BUDGET: Duration = Duration::from_secs(20);
/// redis-py `Lock.release`'s immutable Lua bytes, verbatim from
/// `redis/lock.py` (`LUA_RELEASE_SCRIPT`); the recorded witness runs
/// `EVALSHA c3f8721cbb97f72bc19e972846bd7aaf91901658 1 <key> <token>`.
/// Shared with the DingTalk writer lease so both releases send the same
/// canonical bytes and digest.
pub(crate) const RELEASE_SCRIPT: &str = "\n        local token = redis.call('get', KEYS[1])\n        if not token or token ~= ARGV[1] then\n            return 0\n        end\n        redis.call('del', KEYS[1])\n        return 1\n    ";
/// `sha1(RELEASE_SCRIPT)`.
pub(crate) const RELEASE_SHA: &str = "c3f8721cbb97f72bc19e972846bd7aaf91901658";
const POLICY_QUERY: &str = "SELECT id, json, is_active FROM kinds WHERE user_id = ? AND kind = \
    'ConnectorAuthPolicy' AND namespace = 'plugin-auth' AND name = \
    'account' LIMIT 2";

pub(crate) struct PluginWriteLease<'a, R: Redis> {
    redis: &'a R,
    key: String,
    token: String,
    user_id: i64,
    additional: Vec<(String, String)>,
    installations: Option<Vec<i64>>,
    pub deadline: Instant,
}

#[derive(Debug, FromMysqlRow)]
struct PolicyRow {
    id: i64,
    json: serde_json::Value,
    is_active: Option<bool>,
}

/// The account policy revision only fences authentication decisions made
/// against the global automatic-authentication preference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PluginWriteRevision {
    id: i64,
    revision: i64,
}

pub(crate) fn business_revision(document: &serde_json::Value) -> MysqlResult<i64> {
    match document.get("spec").and_then(|spec| spec.get("revision")) {
        None => Ok(0),
        Some(value) => value
            .as_i64()
            .filter(|revision| *revision >= 0 && *revision < i64::MAX)
            .ok_or_else(|| coordination_error("plugin_write_conflict")),
    }
}

impl<'a, R: Redis> PluginWriteLease<'a, R> {
    #[cfg(test)]
    pub async fn acquire(redis: Option<&'a R>, user_id: i64) -> MysqlResult<Self> {
        let redis = redis.ok_or_else(|| coordination_error("plugin_write_unavailable"))?;
        let mut random = [0_u8; 16];
        getrandom::getrandom(&mut random)
            .map_err(|_| coordination_error("plugin_write_unavailable"))?;
        let token = random.iter().map(|byte| format!("{byte:02x}")).collect();
        Self::acquire_token(redis, user_id, token, ACQUIRE_WAIT).await
    }

    #[cfg(test)]
    async fn acquire_token(
        redis: &'a R,
        user_id: i64,
        token: String,
        wait: Duration,
    ) -> MysqlResult<Self> {
        Self::acquire_named_token(redis, user_id, "@account-policy", token, wait).await
    }

    async fn acquire_named_token(
        redis: &'a R,
        user_id: i64,
        name: &str,
        token: String,
        wait: Duration,
    ) -> MysqlResult<Self> {
        let key = format!("wegent:plugin-write:{user_id}:{name}");
        let acquire_deadline = Instant::now() + wait;
        let one_attempt = wait.is_zero();
        loop {
            let result = tokio::time::timeout_at(
                if one_attempt {
                    Instant::now() + Duration::from_secs(1)
                } else {
                    acquire_deadline
                },
                redis.set_with(
                    key.as_str(),
                    token.as_str(),
                    SetOptions::default()
                        .if_absent()
                        .with_expiration(SetExpiration::Milliseconds(LEASE_SECONDS * 1000)),
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
                        additional: Vec::new(),
                        installations: None,
                        deadline: Instant::now() + OPERATION_BUDGET,
                    });
                }
                Ok(Ok(false)) => {}
                Ok(Err(_)) => return Err(coordination_error("plugin_write_unavailable")),
                Err(_) => return Err(coordination_error("plugin_write_busy")),
            }
            if one_attempt {
                return Err(coordination_error("plugin_write_busy"));
            }
            // `Lock.acquire` computes `next_try_at` after each failed attempt
            // and stops once that attempt would pass `stop_trying_at`.
            let next_try_at = Instant::now() + ACQUIRE_RETRY;
            if next_try_at > acquire_deadline {
                return Err(coordination_error("plugin_write_busy"));
            }
            tokio::time::sleep_until(next_try_at).await;
        }
    }

    /// Create the policy and claim its unique bootstrap identity together.
    /// The database fence survives lease expiry and uncertain COMMIT.
    pub async fn ensure_policy<M: Mysql>(&self, mysql: &M) -> MysqlResult<()> {
        let ready = tokio::time::timeout_at(
            self.deadline,
            mysql.with_transaction(async |tx| {
                Ok(load_policy(tx, self.user_id)
                    .await?
                    .is_some_and(|row| row.is_active == Some(true)))
            }),
        )
        .await
        .map_err(|_| coordination_error("plugin_write_busy"))??;
        if ready {
            return self.verify_owned().await;
        }
        let deadline = (Instant::now() + ACQUIRE_WAIT).min(self.deadline);
        let Ok(result) = tokio::time::timeout_at(deadline, async {
            self.verify_owned().await?;
            mysql
                .with_transaction(async |transaction| {
                    ensure_policy_in(transaction, self.user_id).await?;
                    self.verify_owned().await
                })
                .await
        })
        .await
        else {
            // The unique bootstrap row remains protected by MySQL until the
            // uncertain transaction commits or its connection rolls back.
            return Err(coordination_error("plugin_write_busy"));
        };
        result
    }

    /// Read before any installation state. An ordinary read creates no row
    /// lock; the final atomic update validates this transaction's snapshot.
    pub async fn read_revision<T: MysqlTransaction>(
        &self,
        transaction: &mut T,
    ) -> MysqlResult<PluginWriteRevision> {
        let row = load_policy(transaction, self.user_id)
            .await?
            .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
        if row.is_active != Some(true) {
            return Err(coordination_error("plugin_write_conflict"));
        }
        Ok(PluginWriteRevision {
            id: row.id,
            revision: business_revision(&row.json)?,
        })
    }

    pub(crate) async fn validate_policy_revision<T: MysqlTransaction>(
        &self,
        transaction: &mut T,
        expected: PluginWriteRevision,
    ) -> MysqlResult<()> {
        transaction.execute(
            "UPDATE kinds SET json=json WHERE id=? AND user_id=? AND kind='ConnectorAuthPolicy' AND namespace='plugin-auth' AND name='account' AND is_active=1 AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.revision')) AS SIGNED),0)=?",
            (expected.id, self.user_id, expected.revision),
        ).await?;
        let current = self.read_revision(transaction).await?;
        if current != expected {
            return Err(coordination_error("plugin_write_conflict"));
        }
        self.verify_owned().await
    }

    pub async fn verify_owned(&self) -> MysqlResult<()> {
        if Instant::now() >= self.deadline {
            return Err(coordination_error("plugin_write_lease_lost"));
        }
        // Generic commands default to the primary. The typed GET reads a
        // replica, which can lag behind the SET that acquired this lease.
        for (key, token) in std::iter::once((&self.key, &self.token))
            .chain(self.additional.iter().map(|(key, token)| (key, token)))
        {
            let mut get = brz_redis::cmd("GET");
            get.arg(key.as_str());
            let current: Option<brz_redis::RedisBytes> = self
                .redis
                .command(get)
                .await
                .map_err(|_| coordination_error("plugin_write_unavailable"))?;
            if current.is_none_or(|value| value.as_ref() != token.as_bytes()) {
                return Err(coordination_error("plugin_write_lease_lost"));
            }
        }
        Ok(())
    }

    pub async fn release(mut self) {
        let keys = std::iter::once((self.key.clone(), self.token.clone()))
            .chain(self.additional.drain(..))
            .collect::<Vec<_>>();
        for (key, token) in keys {
            self.release_key(&key, &token).await;
        }
    }

    async fn release_key(&self, key: &str, token: &str) {
        // redis-py `Script.__call__`: EVALSHA first, then load the same
        // canonical bytes with `SCRIPT LOAD` on NOSCRIPT and retry.
        let result = tokio::time::timeout(Duration::from_millis(500), async {
            let first = self
                .redis
                .evalsha::<_, _, _, i64>(RELEASE_SHA, [key], [token])
                .await;
            // redis-py only loads the script on NOSCRIPT; transport, NOAUTH,
            // BUSY and ordinary errors must not add commands.
            if first
                .as_ref()
                .err()
                .is_none_or(|error| error.kind() != brz_redis::ErrorKind::NoScript)
            {
                return first;
            }
            let mut load = brz_redis::cmd("SCRIPT");
            load.arg("LOAD").arg(RELEASE_SCRIPT);
            // Wait for the load reply before retrying; a lazy pipe would let
            // the retry race the load.
            if self
                .redis
                .command::<brz_redis::RedisBytes>(load)
                .await
                .is_err()
            {
                return first;
            }
            self.redis
                .evalsha::<_, _, _, i64>(RELEASE_SHA, [key], [token])
                .await
        })
        .await;
        if !matches!(result, Ok(Ok(_))) {
            // Once committed, unlock failure must not turn success into an
            // error. Redis expiry bounds cleanup after failure/cancellation.
            tracing::warn!(user_id = self.user_id, "plugin write lease cleanup failed");
        }
    }
}

fn unique_policy(mut rows: Vec<PolicyRow>) -> MysqlResult<Option<PolicyRow>> {
    if rows.len() > 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    let row = rows.pop();
    if let Some(row) = &row {
        if !row
            .json
            .get("spec")
            .is_some_and(serde_json::Value::is_object)
        {
            return Err(coordination_error("plugin_write_conflict"));
        }
        business_revision(&row.json)?;
    }
    Ok(row)
}

async fn load_policy<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
) -> MysqlResult<Option<PolicyRow>> {
    let result = unique_policy(transaction.fetch_all(POLICY_QUERY, (user_id,)).await?);
    if result.is_err() {
        tracing::warn!(user_id, "plugin write policy is invalid or duplicated");
    }
    result
}

async fn restore_policy<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    row: PolicyRow,
) -> MysqlResult<()> {
    if row.is_active == Some(true) {
        return Ok(());
    }
    let revision = business_revision(&row.json)?;
    let result = transaction
        .execute(
            "UPDATE kinds SET json = JSON_SET(json, '$.spec.revision', ?), \
             is_active = true, updated_at = NOW() WHERE id = ? AND user_id = ? \
             AND kind = 'ConnectorAuthPolicy' AND namespace = 'plugin-auth' \
             AND name = 'account' AND is_active IS false AND \
             COALESCE(JSON_EXTRACT(json, '$.spec.revision'), 0) = ?",
            (revision + 1, row.id, user_id, revision),
        )
        .await?;
    if result.rows_affected != 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    Ok(())
}

async fn ensure_policy_in<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
) -> MysqlResult<()> {
    transaction.execute("INSERT INTO plugin_states (user_id,plugin_key,json) VALUES (?,'@account-policy',?) ON DUPLICATE KEY UPDATE plugin_key=plugin_states.plugin_key", (user_id,super::state_store::initial_document("@account-policy"))).await?;
    if let Some(row) = load_policy(transaction, user_id).await? {
        return restore_policy(transaction, user_id, row).await;
    }
    transaction
        .execute(
            "INSERT INTO kinds (user_id, kind, namespace, name, json, is_active, \
             created_at, updated_at) VALUES (?, 'ConnectorAuthPolicy', \
             'plugin-auth', 'account', \
             '{\"spec\":{\"enabled\":true,\"revision\":0}}', true, NOW(), NOW())",
            (user_id,),
        )
        .await
        .map(|_| ())
}

pub(crate) fn coordination_error(code: &str) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: code.to_string(),
    }
}

/// Whether one error is the source's `PluginWriteError` category.
///
/// `_prepare_plugins_for_registered_device` treats that category as a deferred
/// plugin sync and falls back to Skills/MCP-only desired state; every other
/// failure aborts the best-effort follow-up.
pub(crate) fn is_plugin_write_error(error: &MysqlError) -> bool {
    plugin_write_error_code(error).is_some()
}

pub(crate) fn plugin_write_error_code(error: &MysqlError) -> Option<&'static str> {
    let MysqlError::InvalidQuery { reason } = error else {
        return None;
    };
    match reason.as_str() {
        "plugin_write_busy" => Some("plugin_write_busy"),
        "plugin_write_unavailable" => Some("plugin_write_unavailable"),
        "plugin_write_lease_lost" => Some("plugin_write_lease_lost"),
        "plugin_write_conflict" => Some("plugin_write_conflict"),
        _ => None,
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

impl<'a, R: Redis + Sync> crate::device_identity::LeaseCheck for PluginWriteLease<'a, R> {
    fn check<'b>(
        &'b self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = MysqlResult<()>> + Send + 'b>> {
        Box::pin(self.verify_owned())
    }
}

#[cfg(test)]
#[path = "write_coordination_tests.rs"]
mod tests;

#[cfg(test)]
mod release_script_tests {
    use super::*;
    use sha1::{Digest as _, Sha1};

    #[test]
    fn the_release_script_is_the_source_redis_py_bytes() {
        let digest = Sha1::digest(RELEASE_SCRIPT.as_bytes());
        let hex = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(hex, RELEASE_SHA);
    }
}
