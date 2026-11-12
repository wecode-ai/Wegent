// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Recipient-scoped delivery intents and receipts live in MySQL, not the
//! evictable session cache. A unique identity survives every event replay.

use anyhow::{Context, Result, ensure};
use brz_mysql::{FromMysqlRow, Json, MysqlService, MysqlTransaction};
use chrono::{Duration, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::runtime_work_im_notifications::PrivateSession;

const LEASE_SECONDS: i64 = 120;

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct Delivery {
    pub session: PrivateSession,
    pub address: Value,
    pub message: String,
}

pub(super) struct ClaimedDelivery {
    pub id: String,
    pub token: String,
    pub attempts: u32,
    pub delivery: Delivery,
    pub provider_result: Option<Value>,
}

pub(super) async fn enqueue(
    mysql: &MysqlService,
    deliveries: Vec<(String, Delivery)>,
) -> Result<()> {
    let rows = deliveries
        .into_iter()
        .map(|(id, delivery)| {
            Ok((
                id,
                delivery.session.user_id,
                Json(serde_json::to_value(delivery)?),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let now = Utc::now().naive_utc();
    mysql
        .with_transaction(async |tx| {
            for (id, user, payload) in rows {
                tx.execute(
                    "INSERT INTO runtime_notification_deliveries \
                 (id,user_id,payload,status,attempts,next_attempt_at,created_at,updated_at) \
                 VALUES (?,?,?,'pending',0,?,?,?) ON DUPLICATE KEY UPDATE id=id",
                    (id, user, payload, now, now, now),
                )
                .await?;
            }
            Ok(())
        })
        .await?;
    Ok(())
}

pub(super) async fn claim(mysql: &MysqlService) -> Result<Option<ClaimedDelivery>> {
    claim_at(mysql, Utc::now().naive_utc()).await
}

async fn claim_at(mysql: &MysqlService, now: NaiveDateTime) -> Result<Option<ClaimedDelivery>> {
    #[derive(FromMysqlRow)]
    struct Row {
        id: String,
        payload: Json<Value>,
        attempts: u32,
        provider_result: Option<Json<Value>>,
    }
    let token = crate::device_identity_lock::lock_token();
    let row: Option<Row> =
        mysql
            .with_transaction(async |tx| {
                let row: Option<Row> = tx.fetch_optional(
            "SELECT id,payload,attempts,provider_result FROM runtime_notification_deliveries \
             WHERE status='pending' AND next_attempt_at<=? \
             ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED", (now,),
        ).await?;
                if let Some(row) = &row {
                    tx.execute(
                "UPDATE runtime_notification_deliveries SET lease_token=?,next_attempt_at=?,\
                 attempts=attempts+1,updated_at=? WHERE id=?",
                (token.as_str(), now + Duration::seconds(LEASE_SECONDS), now, row.id.as_str()),
            ).await?;
                }
                Ok(row)
            })
            .await?;
    row.map(|row| {
        Ok(ClaimedDelivery {
            id: row.id,
            token,
            attempts: row.attempts.saturating_add(1),
            delivery: serde_json::from_value(row.payload.0)
                .context("Invalid notification intent")?,
            provider_result: row.provider_result.map(|value| value.0),
        })
    })
    .transpose()
}

/// Preserve the provider's response before writing any disposable reply cache.
/// A failed reply-cache write can then resume without sending another message.
pub(super) async fn record_result(
    mysql: &MysqlService,
    claimed: &ClaimedDelivery,
    result: &Value,
) -> Result<()> {
    let changed = mysql
        .execute(
            "UPDATE runtime_notification_deliveries SET provider_result=?,updated_at=? \
         WHERE id=? AND status='pending' AND lease_token=?",
            (
                Json(result.clone()),
                Utc::now().naive_utc(),
                claimed.id.as_str(),
                claimed.token.as_str(),
            ),
        )
        .await?;
    ensure!(
        changed.rows_affected == 1,
        "Runtime notification delivery lease was replaced"
    );
    Ok(())
}

pub(super) async fn settle(
    mysql: &MysqlService,
    claimed: &ClaimedDelivery,
    sent: bool,
) -> Result<()> {
    settle_at(mysql, claimed, sent, Utc::now().naive_utc()).await
}

async fn settle_at(
    mysql: &MysqlService,
    claimed: &ClaimedDelivery,
    sent: bool,
    now: NaiveDateTime,
) -> Result<()> {
    let changed = if sent {
        mysql
            .execute(
                "UPDATE runtime_notification_deliveries SET status='sent',lease_token=NULL,\
             payload=JSON_OBJECT(),provider_result=NULL,updated_at=? \
             WHERE id=? AND status='pending' AND lease_token=?",
                (now, claimed.id.as_str(), claimed.token.as_str()),
            )
            .await?
    } else {
        let seconds = (1_i64 << claimed.attempts.saturating_sub(1).min(9)).min(300);
        mysql.execute(
            "UPDATE runtime_notification_deliveries SET lease_token=NULL,next_attempt_at=?,updated_at=? \
             WHERE id=? AND status='pending' AND lease_token=?",
            (now + Duration::seconds(seconds), now, claimed.id.as_str(), claimed.token.as_str()),
        ).await?
    };
    ensure!(
        changed.rows_affected == 1,
        "Runtime notification delivery lease was replaced"
    );
    Ok(())
}

#[cfg(test)]
pub(crate) async fn test_database(
    test: impl AsyncFnOnce(&MysqlService) -> Result<()>,
) -> Result<()> {
    crate::migrations::mysql_tests::isolated(async |mysql| {
        let revision: Value =
            serde_json::from_str(include_str!("../../migrations/revisions/a4d8e2f9c7b1.json"))?;
        mysql
            .execute(revision["upgrade"][0]["sql"][0].as_str().unwrap(), ())
            .await?;
        test(mysql).await
    })
    .await
}

#[cfg(test)]
#[path = "runtime_notification_outbox_tests.rs"]
mod tests;
