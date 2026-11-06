//! Rebuild the source chat-history cache only when a reused Task has none.
use crate::AppState;
use anyhow::{Context, Result};
use brz_mysql::{FromMysqlCol, Json, MysqlRow};
use brz_redis::{Redis, RedisBytes, SetExpiration, SetOptions};
use serde_json::{Value, json};

pub(super) async fn initialize(app: &AppState, task: i64, user: i64, before: i64) -> Result<()> {
    let redis = app
        .redis
        .as_ref()
        .context("Subscription history requires Redis")?;
    let key = format!("chat:history:{task}");
    if let Some(cached) = redis.get::<_, RedisBytes>(&key).await?
        && serde_json::from_slice::<Vec<Value>>(cached.as_ref())
            .is_ok_and(|history| !history.is_empty())
    {
        return Ok(());
    }
    let rows = app
        .task_store
        .list_subtasks_by_task_unfiltered(task, Some(user))
        .await?;
    let mut entries: Vec<_> = rows
        .iter()
        .filter_map(|row| {
            let message = column::<i64>(row, "message_id")?;
            if message >= before {
                return None;
            }
            Some((
                message,
                column::<String>(row, "status")?,
                column::<String>(row, "role")?,
                column::<String>(row, "prompt").unwrap_or_default(),
                column::<Json<Value>>(row, "result")
                    .map(|v| v.0)
                    .unwrap_or(Value::Null),
            ))
        })
        .collect();
    entries.sort_by_key(|entry| entry.0);
    let messages = rebuild(
        entries,
        super::model::setting("CHAT_HISTORY_MAX_MESSAGES", 50) as usize,
    );
    if !messages.is_empty() {
        redis
            .set_with(
                &key,
                serde_json::to_string(&messages)?,
                SetOptions::default().with_expiration(SetExpiration::Seconds(
                    super::model::setting("CHAT_HISTORY_EXPIRE_SECONDS", 7200),
                )),
            )
            .await?;
    }
    Ok(())
}
fn column<T: FromMysqlCol>(row: &MysqlRow, name: &str) -> Option<T> {
    row.get_at::<T>(crate::task_store::subtask_column_index(name)?)
        .ok()
}
type Entry = (i64, String, String, String, Value);
fn rebuild(entries: Vec<Entry>, limit: usize) -> Vec<Value> {
    let mut messages: Vec<_> = entries
        .into_iter()
        .filter_map(|(_, status, role, prompt, result)| {
            if status != "COMPLETED" {
                return None;
            }
            match role.as_str() {
                "USER" if !prompt.is_empty() => Some(json!({"role":"user","content":prompt})),
                "ASSISTANT" => result["value"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|content| json!({"role":"assistant","content":content})),
                _ => None,
            }
        })
        .collect();
    if limit > 0 && messages.len() > limit {
        messages.drain(..messages.len() - limit);
    }
    messages
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_completed_content_is_rebuilt_and_recent_messages_are_retained() {
        let entries = vec![
            (
                1,
                "COMPLETED".into(),
                "USER".into(),
                "old".into(),
                Value::Null,
            ),
            (
                2,
                "COMPLETED".into(),
                "ASSISTANT".into(),
                String::new(),
                json!({"value":"answer"}),
            ),
            (
                3,
                "FAILED".into(),
                "ASSISTANT".into(),
                String::new(),
                json!({"value":"partial"}),
            ),
            (
                4,
                "COMPLETED".into(),
                "USER".into(),
                "recent".into(),
                Value::Null,
            ),
        ];
        assert_eq!(
            rebuild(entries, 2),
            vec![
                json!({"role":"assistant","content":"answer"}),
                json!({"role":"user","content":"recent"})
            ]
        );
    }
}
