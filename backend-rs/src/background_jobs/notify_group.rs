// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Summarize each active group once and distribute it to approved members.
use super::{GroupSummary, Message, NotificationDelivery, Task, task, title, user};
use crate::{AppState, config::env_or_dotenv};
use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json};
use chrono::{Duration, Local, NaiveDateTime};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(FromMysqlRow)]
struct Member {
    resource_id: i64,
    user_id: i64,
}

#[tracing::instrument(name="notifications.group_summary",skip_all,fields(hours_back=hours))]
pub async fn daily_summary(
    state: &AppState,
    delivery: &dyn NotificationDelivery,
    hours: i64,
) -> Result<usize> {
    let since = Local::now().naive_local() - Duration::hours(hours);
    let tasks = state
        .task_store
        .scan_recent_group_chats(since)
        .await?
        .iter()
        .map(task)
        .collect::<Result<Vec<_>>>()?;
    if tasks.is_empty() {
        return Ok(0);
    }
    let mut members: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
    let mut groups = BTreeMap::new();
    for task in &tasks {
        let rows:Vec<Member>=state.mysql.fetch_all("SELECT resource_id, CAST(entity_id AS SIGNED) AS user_id FROM resource_members WHERE resource_type='Task' AND resource_id=? AND entity_type='user' AND status='approved' AND CAST(entity_id AS SIGNED)>0",(task.id,)).await?;
        for member in rows {
            members
                .entry(member.user_id)
                .or_default()
                .insert(member.resource_id);
        }
        if task.user_id > 0 {
            members.entry(task.user_id).or_default().insert(task.id);
        }
        let conversation = conversation(state, task.id, since).await?;
        if conversation.is_empty() {
            continue;
        }
        let title = title(task);
        let summary = summarize(state, task, &conversation, &title, hours).await;
        if summary.trim().chars().count() < 20 {
            continue;
        }
        groups.insert(
            task.id,
            GroupSummary {
                task_id: task.id,
                title,
                conversation,
                summary,
            },
        );
    }
    let frontend = env_or_dotenv("FRONTEND_URL").unwrap_or_else(|| "http://localhost:3000".into());
    let mut sent = 0;
    for (user_id, ids) in members {
        let outcome: Result<bool> = async {
            let summaries = ids
                .into_iter()
                .filter_map(|id| groups.get(&id).cloned())
                .collect::<Vec<_>>();
            if summaries.is_empty() {
                return Ok(false);
            }
            let Some(user) = user(state, user_id).await? else {
                return Ok(false);
            };
            delivery
                .group_email(
                    &delivery.recipient(&user.user_name, user.email.as_deref()),
                    &user.user_name,
                    &summaries,
                    &frontend,
                    hours,
                )
                .await
        }
        .await;
        match outcome {
            Ok(true) => sent += 1,
            Ok(false) => {}
            Err(error) => tracing::error!(user_id,%error,"Group summary email failed"),
        }
    }
    Ok(sent)
}

async fn conversation(
    state: &AppState,
    task_id: i64,
    since: NaiveDateTime,
) -> Result<Vec<Message>> {
    let rows = state.task_store.list_subtasks_by_task(task_id).await?;
    let mut rows = rows
        .iter()
        .map(|row| {
            Ok((
                row.get_required::<i64>("message_id")?,
                row.get_required::<NaiveDateTime>("created_at")?,
                row,
            ))
        })
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;
    rows.sort_by_key(|(id, created, _)| (*created, *id));
    let mut users = BTreeMap::new();
    let mut conversation = Vec::new();
    for (_, created, row) in rows {
        if created <= since {
            continue;
        }
        let role: String = row.get_required("role")?;
        let (role, username, content) = if role == "USER" {
            let sender: i64 = row.get_required("sender_user_id")?;
            let username = if sender <= 0 {
                "未知用户".into()
            } else {
                if let std::collections::btree_map::Entry::Vacant(entry) = users.entry(sender) {
                    entry.insert(
                        user(state, sender)
                            .await?
                            .map(|u| u.user_name)
                            .unwrap_or_else(|| format!("用户{sender}")),
                    );
                }
                users[&sender].clone()
            };
            (
                "user",
                username,
                row.get::<String>("prompt")?.unwrap_or_default(),
            )
        } else if role == "ASSISTANT" {
            let result: Option<Json<Value>> = row.get("result")?;
            let content = result.map(|v| result_content(&v.0)).unwrap_or_default();
            ("assistant", "AI".into(), content)
        } else {
            continue;
        };
        if !content.is_empty() {
            conversation.push(Message {
                role: role.into(),
                username,
                content,
            });
        }
    }
    Ok(conversation)
}

fn result_content(value: &Value) -> String {
    value
        .as_str()
        .or_else(|| value["value"].as_str().filter(|v| !v.is_empty()))
        .or_else(|| value["content"].as_str())
        .unwrap_or("")
        .into()
}
fn count_summary(conversation: &[Message]) -> String {
    let users = conversation.iter().filter(|m| m.role == "user").count();
    format!(
        "共 {users} 条用户消息，{} 条 AI 回复",
        conversation.len() - users
    )
}

async fn summarize(
    state: &AppState,
    task: &Task,
    conversation: &[Message],
    title: &str,
    hours: i64,
) -> String {
    let model = env_or_dotenv("DAILY_SUMMARY_MODEL_CONFIG")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|v| {
            ["model", "api_key", "base_url", "model_id"]
                .iter()
                .all(|key| v.get(*key).is_some())
        });
    let Some(model) = model else {
        return count_summary(conversation);
    };
    let system = include_str!("notify_group_prompt.md")
        .replace("{{GROUP_NAME}}", title)
        .replace("{{HOURS_BACK}}", &hours.to_string());
    let transcript = conversation
        .iter()
        .map(|m| {
            format!(
                "{}: {}\n",
                if m.role == "assistant" {
                    "AI"
                } else {
                    m.username.as_str()
                },
                m.content
            )
        })
        .collect::<String>();
    let prompt = format!("以下是群聊【{title}】过去{hours}小时内的聊天记录：\n\n{transcript}");
    let input = super::super::execution::BackgroundChat {
        user_id: task.user_id,
        title,
        task_type: "group_summary",
        summary_type: "group_chat",
        document_id: None,
        knowledge_base_id: None,
        system_prompt: &system,
        prompt: &prompt,
        model_config: model,
    };
    match super::super::execution::execute(state, input).await {
        Ok(result) => result.content.trim().into(),
        Err(error) => {
            tracing::error!(task_id=task.id,%error,"Group summary generation failed");
            count_summary(conversation)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn assistant_results_use_value_then_content() {
        assert_eq!(
            result_content(&json!({"value":"","content":"content"})),
            "content"
        );
        assert_eq!(result_content(&json!("text")), "text");
    }
}
