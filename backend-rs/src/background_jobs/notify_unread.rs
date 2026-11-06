// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Read the external unread hash without clearing counters owned by its writer.
use super::{NotificationDelivery, task, title, user};
use crate::{AppState, config::env_or_dotenv};
use anyhow::{Context, Result};
use brz_redis::{Redis, cmd};
use chrono::{Duration, Local, Timelike};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

pub(super) fn counts(payload: &Value, hour: u32) -> BTreeMap<i64, i64> {
    payload
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(id, hours)| {
            let count = hours[hour.to_string()].as_i64()?;
            (count > 0)
                .then(|| id.parse().ok().map(|id| (id, count)))
                .flatten()
        })
        .collect()
}

#[tracing::instrument(name = "notifications.hourly_unread", skip_all)]
pub async fn hourly_unread(state: &AppState, delivery: &dyn NotificationDelivery) -> Result<usize> {
    let now = Local::now();
    let previous = now - Duration::hours(1);
    let key = format!("unread:{}", previous.format("%Y%m%d"));
    let redis = state
        .redis
        .as_ref()
        .context("Unread notifications require Redis")?;
    let unread: HashMap<String, String> = redis
        .command({
            let mut c = cmd("HGETALL");
            c.arg(key.as_str());
            c
        })
        .await?;
    let frontend = env_or_dotenv("FRONTEND_URL").unwrap_or_else(|| "http://localhost:3000".into());
    let mut sent = 0;
    for (id, raw) in unread {
        let user_id = id.parse::<i64>()?;
        let outcome: Result<bool> = async {
            let Some(user) = user(state, user_id).await? else {
                return Ok(false);
            };
            let Ok(payload) = serde_json::from_str::<Value>(&raw) else {
                return Ok(false);
            };
            let counts = counts(&payload, previous.hour());
            if counts.is_empty() {
                return Ok(false);
            }
            let ids = counts.keys().copied().collect::<Vec<_>>();
            let titles = state
                .task_store
                .list_tasks_by_ids(&ids)
                .await?
                .iter()
                .map(task)
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .map(|task| (task.id, title(&task)))
                .collect::<BTreeMap<_, _>>();
            let names = ids
                .iter()
                .map(|id| {
                    titles
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| format!("群聊{id}"))
                })
                .collect::<Vec<_>>();
            let content = unread_message(&names, counts.values().sum(), &frontend);
            delivery
                .markdown(
                    &delivery.recipient(&user.user_name, user.email.as_deref()),
                    "Wegent 新消息提醒",
                    &content,
                )
                .await
        }
        .await;
        match outcome {
            Ok(true) => sent += 1,
            Ok(false) => {}
            Err(error) => tracing::error!(user_id,%error,"Unread notification failed"),
        }
    }
    Ok(sent)
}

pub(super) fn unread_message(names: &[String], count: i64, frontend: &str) -> String {
    let mut groups = names.iter().take(5).cloned().collect::<Vec<_>>().join("、");
    if names.len() > 5 {
        groups.push_str(&format!(" 等{}个群", names.len()));
    }
    format!(
        "### Wegent 新消息提醒\n\n您所在的 **{groups}** 群里收到了 **{count}** 条消息\n\n[点击查看详情]({frontend})"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn selects_only_positive_counts_in_the_requested_hour() {
        assert_eq!(
            counts(
                &json!({"42":{"14":5,"15":2},"43":{"14":0},"bad":{"14":1}}),
                14
            ),
            BTreeMap::from([(42, 5)])
        );
    }
    #[test]
    fn bounds_names_but_retains_the_total_group_count() {
        let content = unread_message(
            &(1..=6).map(|n| format!("group{n}")).collect::<Vec<_>>(),
            50,
            "https://example.invalid",
        );
        assert!(content.contains("等6个群"));
        assert!(!content.contains("group6"));
        assert!(content.contains("**50**"));
    }
}
