//! Expire offline registrations without deleting tasks, histories or cloud infrastructure.
use anyhow::{Context, Result};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use chrono::{DateTime, TimeDelta, Utc};
use serde_json::{Value, json};

use super::*;

const RETENTION: TimeDelta = TimeDelta::days(7);

#[derive(FromMysqlRow)]
struct Candidate {
    id: i64,
    user_id: i64,
}

fn expired(document: &Value, now: DateTime<Utc>) -> bool {
    ["lastSeenAt", "offlineSince"]
        .into_iter()
        .filter_map(|key| document["status"][key].as_str())
        .filter_map(crate::device_presence::parse_observed_time)
        .max()
        .is_some_and(|last| last < now - RETENTION)
}

pub(crate) async fn prune(
    state: &AppState,
    context: &crate::background_jobs::JobContext,
) -> Result<usize> {
    let redis = state
        .redis
        .as_ref()
        .context("Device retention requires authoritative online state")?;
    let tables = state.task_store.subtask_tables();
    let mut cursor = 0;
    let mut removed = 0;
    loop {
        let candidates: Vec<Candidate> = state.mysql.fetch_all(
            "SELECT id,user_id FROM kinds WHERE kind='Device' AND namespace='default' AND is_active=true AND id>? ORDER BY id LIMIT 200", (cursor,)
        ).await?;
        if candidates.is_empty() {
            break;
        }
        for candidate in candidates {
            if context.cancellation.is_cancelled() {
                anyhow::bail!("Device retention cancelled");
            }
            cursor = candidate.id;
            let Some(lock) = IdentityLock::acquire(redis, candidate.user_id).await? else {
                continue;
            };
            let result = tokio::time::timeout(
                IDENTITY_LOCK_BODY_TIMEOUT,
                state.mysql.with_transaction(async |tx| {
                    prune_record(
                        tx,
                        redis,
                        candidate.user_id,
                        candidate.id,
                        &tables,
                        Utc::now(),
                    )
                    .await
                }),
            )
            .await;
            lock.release().await?;
            removed += usize::from(result.context("Device retention transaction timed out")??);
        }
    }
    Ok(removed)
}

async fn prune_record<T: MysqlTransaction, R: Redis>(
    tx: &mut T,
    redis: &R,
    user_id: i64,
    record_id: i64,
    tables: &[String],
    now: DateTime<Utc>,
) -> Result<bool, MysqlError> {
    lock_device_owner(tx, user_id).await?;
    let Some(device): Option<DeviceKindRow> = tx
        .fetch_optional(DEVICE_RECORD_FOR_UPDATE_QUERY, (record_id, user_id))
        .await?
    else {
        return Ok(false);
    };
    // Cloud records own provider-managed sandboxes and must retain their management path.
    if device.json["spec"]["deviceType"].as_str() == Some(CLOUD_DEVICE_TYPE) {
        return Ok(false);
    }
    if !matches!(
        require_offline_and_idle(tx, redis, user_id, &device, tables).await?,
        GuardDecision::Offline
    ) || has_active_project_execution(tx, user_id, &device).await?
    {
        return Ok(false);
    }
    if expired(&device.json, now) {
        tx.execute(UPDATE_DEVICE_INACTIVE_QUERY, (now.naive_utc(), record_id))
            .await?;
        return Ok(true);
    }
    if device.json["status"]["lastSeenAt"]
        .as_str()
        .and_then(crate::device_presence::parse_observed_time)
        .is_none()
        && device.json["status"]["offlineSince"]
            .as_str()
            .and_then(crate::device_presence::parse_observed_time)
            .is_none()
    {
        let mut document = device.json;
        if !document["status"].is_object() {
            document["status"] = json!({});
        }
        document["status"]["offlineSince"] = json!(now.to_rfc3339());
        tx.execute("UPDATE kinds SET json=? WHERE id=? AND user_id=? AND kind='Device' AND namespace='default' AND is_active=true", (Json(document),record_id,user_id)).await?;
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retention_requires_more_than_seven_days_and_never_guesses_unknown_presence() {
        let now = "2026-11-16T00:00:00Z".parse().unwrap();
        assert!(!expired(&json!({}), now));
        assert!(!expired(&json!({"status":{"lastSeenAt":"invalid"}}), now));
        assert!(!expired(
            &json!({"status":{"lastSeenAt":"2026-11-09T00:00:00Z"}}),
            now
        ));
        assert!(expired(
            &json!({"status":{"lastSeenAt":"2026-11-08T23:59:59Z"}}),
            now
        ));
        assert!(expired(
            &json!({"status":{"offlineSince":"2026-11-08T23:59:59Z"}}),
            now
        ));
        assert!(!expired(
            &json!({"status":{"offlineSince":"2026-11-01T00:00:00Z","lastSeenAt":"2026-11-15T00:00:00Z"}}),
            now
        ));
    }
}

#[cfg(test)]
#[path = "retention_mysql_tests.rs"]
mod mysql_tests;
