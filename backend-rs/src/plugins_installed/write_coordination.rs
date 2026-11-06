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
/// redis-py `Lock.release`'s immutable Lua bytes, verbatim from
/// `redis/lock.py` (`LUA_RELEASE_SCRIPT`); the recorded witness runs
/// `EVALSHA c3f8721cbb97f72bc19e972846bd7aaf91901658 1 <key> <token>`.
const RELEASE_SCRIPT: &str = "\n        local token = redis.call('get', KEYS[1])\n        if not token or token ~= ARGV[1] then\n            return 0\n        end\n        redis.call('del', KEYS[1])\n        return 1\n    ";
/// `sha1(RELEASE_SCRIPT)`.
const RELEASE_SHA: &str = "c3f8721cbb97f72bc19e972846bd7aaf91901658";
const POLICY_QUERY: &str = "SELECT id, json, is_active FROM kinds WHERE user_id = ? AND kind = \
    'ConnectorAuthPolicy' AND namespace = 'plugin-auth' AND name = \
    'account' LIMIT 2";

pub(crate) struct PluginWriteLease<'a, R: Redis> {
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
    is_active: Option<bool>,
}

/// The existing account policy is the shared parent of this user's plugin
/// writes. Its revision protects decisions spanning multiple business rows.
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
            if Instant::now() >= acquire_deadline {
                return Err(coordination_error("plugin_write_busy"));
            }
            let result = tokio::time::timeout_at(
                acquire_deadline,
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
                        deadline: Instant::now() + OPERATION_BUDGET,
                    });
                }
                Ok(Ok(false)) => {}
                Ok(Err(_)) => return Err(coordination_error("plugin_write_unavailable")),
                Err(_) => return Err(coordination_error("plugin_write_busy")),
            }
            tokio::time::sleep_until(
                (Instant::now() + Duration::from_millis(50)).min(acquire_deadline),
            )
            .await;
        }
    }

    /// Create the real account policy in a short transaction under the lease.
    /// First creation has no database uniqueness guarantee if leases overlap;
    /// later reads reject duplicates instead of choosing an arbitrary parent.
    pub async fn ensure_policy<M: Mysql>(&self, mysql: &M) -> MysqlResult<()> {
        let deadline = (Instant::now() + ACQUIRE_WAIT).min(self.deadline);
        tokio::time::timeout_at(deadline, async {
            self.verify_owned().await?;
            mysql
                .with_transaction(async |transaction| {
                    ensure_policy_in(transaction, self.user_id).await?;
                    self.verify_owned().await
                })
                .await
        })
        .await
        .unwrap_or_else(|_| Err(coordination_error("plugin_write_busy")))
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

    /// One policy read for callers that need both the gate and the revision.
    ///
    /// The source's `reconcile` reads the account policy once and derives both
    /// the enabled gate and the parent revision from that row, so this keeps
    /// the recorded single `ConnectorAuthPolicy` read.
    pub(crate) async fn read_policy_snapshot<T: MysqlTransaction>(
        &self,
        transaction: &mut T,
    ) -> MysqlResult<(Option<serde_json::Value>, Option<PluginWriteRevision>)> {
        let rows: Vec<PolicyRow> = transaction.fetch_all(POLICY_QUERY, (self.user_id,)).await?;
        let Ok(Some(row)) = unique_policy(rows) else {
            return Ok((None, None));
        };
        let document = Some(row.json.clone());
        if row.is_active != Some(true) {
            return Ok((document, None));
        }
        let revision = business_revision(&row.json)?;
        Ok((
            document,
            Some(PluginWriteRevision {
                id: row.id,
                revision,
            }),
        ))
    }

    pub async fn verify_owned(&self) -> MysqlResult<()> {
        if Instant::now() >= self.deadline {
            return Err(coordination_error("plugin_write_lease_lost"));
        }
        // Generic commands default to the primary. The typed GET reads a
        // replica, which can lag behind the SET that acquired this lease.
        let mut get = brz_redis::cmd("GET");
        get.arg(self.key.as_str());
        let current: Option<brz_redis::RedisBytes> = self
            .redis
            .command(get)
            .await
            .map_err(|_| coordination_error("plugin_write_unavailable"))?;
        if current.is_some_and(|value| value.as_ref() == self.token.as_bytes()) {
            Ok(())
        } else {
            Err(coordination_error("plugin_write_lease_lost"))
        }
    }

    /// `read_policy_revision` on a fresh pooled read.
    ///
    /// The source configures READ COMMITTED so this read sees committed state;
    /// a pooled autocommit read is equivalent without leaking a session
    /// isolation level onto later transactions. A missing, duplicated,
    /// malformed or inactive policy yields `None` (the caller skips the
    /// revision CAS); transport failures stay errors.
    pub async fn read_policy_revision<T: MysqlTransaction>(
        &self,
        transaction: &mut T,
    ) -> MysqlResult<Option<PluginWriteRevision>> {
        // Read on the write transaction's primary connection: a pooled read can
        // land on a replica whose lag would make the revision CAS conflict and
        // degrade the registration snapshot.
        let rows: Vec<PolicyRow> = transaction.fetch_all(POLICY_QUERY, (self.user_id,)).await?;
        let row = match unique_policy(rows) {
            Ok(row) => row,
            Err(error) => {
                tracing::warn!(user_id = self.user_id, "plugin write policy is invalid");
                let _ = error;
                return Ok(None);
            }
        };
        let Some(row) = row else {
            return Ok(None);
        };
        if row.is_active != Some(true) {
            tracing::warn!(user_id = self.user_id, "plugin write policy is inactive");
            return Ok(None);
        }
        match business_revision(&row.json) {
            Ok(revision) => Ok(Some(PluginWriteRevision {
                id: row.id,
                revision,
            })),
            Err(error) => {
                let _ = error;
                Ok(None)
            }
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
        // `advance_policy_revision` keeps every predicate (`_identity` includes
        // user_id/kind/namespace/name, plus `is_active IS true`) and compares
        // `Kind.json["spec"]["revision"].as_integer()`, which SQLAlchemy renders
        // as a nested `json_extract` with a `CASE ... CAST ... AS SIGNED`
        // normalization before `coalesce`. Values stay bound parameters.
        let statement = "UPDATE kinds SET json=json_set(kinds.json, '$.spec.revision', ?), \
             updated_at=now() WHERE kinds.id = ? AND kinds.user_id = ? AND \
             kinds.kind = 'ConnectorAuthPolicy' AND kinds.namespace = \
             'plugin-auth' AND kinds.name = 'account' AND kinds.is_active IS true \
             AND coalesce(CASE JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
             '$.\"revision\"') WHEN 'null' THEN NULL ELSE \
             CAST(JSON_EXTRACT(JSON_EXTRACT(kinds.json, '$.\"spec\"'), \
             '$.\"revision\"') AS SIGNED INTEGER) END, 0) = ?";
        let result = transaction
            .execute(
                statement,
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
        // redis-py `Script.__call__`: EVALSHA first, then load the same
        // canonical bytes with `SCRIPT LOAD` on NOSCRIPT and retry.
        let result = tokio::time::timeout(Duration::from_millis(500), async {
            let first = self
                .redis
                .evalsha::<_, _, _, i64>(RELEASE_SHA, [self.key.as_str()], [self.token.as_str()])
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
                .evalsha::<_, _, _, i64>(RELEASE_SHA, [self.key.as_str()], [self.token.as_str()])
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
    matches!(
        error,
        MysqlError::InvalidQuery { reason }
            if matches!(
                reason.as_str(),
                "plugin_write_busy"
                    | "plugin_write_unavailable"
                    | "plugin_write_lease_lost"
                    | "plugin_write_conflict"
            )
    )
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
