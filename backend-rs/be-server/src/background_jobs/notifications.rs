// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Group notification business rules with deployment-owned recipient delivery.
#[path = "notify_delivery.rs"]
pub mod delivery;
#[path = "notify_group.rs"]
mod group;
#[path = "notify_unread.rs"]
mod unread;

use crate::AppState;
use anyhow::Result;
use async_trait::async_trait;
use brz_mysql::{FromMysqlRow, Json, MysqlRow};
use serde::Serialize;
use serde_json::Value;

pub use group::daily_summary;
pub use unread::hourly_unread;

#[derive(Clone, Debug, Serialize)]
pub struct GroupSummary {
    pub task_id: i64,
    pub title: String,
    pub conversation: Vec<Message>,
    pub summary: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Message {
    pub role: String,
    pub username: String,
    pub content: String,
}

/// Internal address conventions and external transports are selected by the
/// embedding application. The core contains no organization-specific domains.
#[async_trait]
pub trait NotificationDelivery: Send + Sync {
    fn recipient(&self, username: &str, email: Option<&str>) -> String;
    async fn markdown(&self, email: &str, title: &str, content: &str) -> Result<bool>;
    async fn group_email(
        &self,
        email: &str,
        username: &str,
        groups: &[GroupSummary],
        frontend: &str,
        hours: i64,
    ) -> Result<bool>;
}

#[derive(Debug, FromMysqlRow)]
struct User {
    user_name: String,
    email: Option<String>,
}
async fn user(state: &AppState, id: i64) -> Result<Option<User>> {
    Ok(state
        .mysql
        .fetch_optional(
            "SELECT user_name,email FROM users WHERE id=? LIMIT 1",
            (id,),
        )
        .await?)
}

#[derive(Debug)]
struct Task {
    id: i64,
    user_id: i64,
    name: String,
    json: Value,
}
fn task(row: &MysqlRow) -> Result<Task> {
    // Existing store projections can label columns for ORM compatibility.
    fn value<T: brz_mysql::FromMysqlCol>(row: &MysqlRow, name: &str) -> brz_mysql::MysqlResult<T> {
        row.get_at(crate::task_store::task_column_index(name).expect("known task column"))
    }
    Ok(Task {
        id: value(row, "id")?,
        user_id: value(row, "user_id")?,
        name: value(row, "name")?,
        json: value::<Json<Value>>(row, "json")?.0,
    })
}
fn title(task: &Task) -> String {
    task.json["spec"]["title"]
        .as_str()
        .filter(|v| !v.is_empty())
        .or_else(|| (!task.name.is_empty()).then_some(task.name.as_str()))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("群聊 {}", task.id))
}
