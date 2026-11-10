// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use brz_redis::{Redis, SetExpiration, SetOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::background_jobs::project::notifications::telegram_message;
use crate::state::AppState;

use super::ExecutionEvent;

const MESSAGE_LIMIT: usize = 4096;

#[derive(Default, Serialize, Deserialize)]
struct Reply {
    message_id: Option<i64>,
    content: String,
    #[serde(default)]
    reasoning: String,
    finished: bool,
    last_edit_at: i64,
}

pub(super) async fn stream(
    state: &AppState,
    redis: &impl Redis,
    task_key: &str,
    subtask_id: i64,
    info: &Value,
    event: &ExecutionEvent,
) -> bool {
    let (text, thinking) = match event.event_type.as_str() {
        "start" => ("", false),
        "chunk" if !event.content.is_empty() => (event.content.as_str(), false),
        "thinking" if !event.content.is_empty() => (event.content.as_str(), true),
        _ => return false,
    };
    deliver(
        state,
        redis,
        task_key,
        subtask_id,
        info,
        Update::Progress(text, thinking),
    )
    .await
}

pub(super) async fn finish(
    state: &AppState,
    redis: &impl Redis,
    task_key: &str,
    subtask_id: i64,
    info: &Value,
    text: &str,
    status: &str,
) -> bool {
    deliver(
        state,
        redis,
        task_key,
        subtask_id,
        info,
        Update::Terminal(text, status),
    )
    .await
}

enum Update<'a> {
    Progress(&'a str, bool),
    Terminal(&'a str, &'a str),
}

async fn deliver(
    state: &AppState,
    redis: &impl Redis,
    task_key: &str,
    subtask_id: i64,
    info: &Value,
    update: Update<'_>,
) -> bool {
    let result = deliver_reply(state, redis, task_key, subtask_id, info, update).await;
    if let Err(error) = &result {
        tracing::warn!(%error, task_key, subtask_id, "Telegram Runtime reply delivery failed");
    }
    result.is_ok()
}

async fn deliver_reply(
    state: &AppState,
    redis: &impl Redis,
    task_key: &str,
    subtask_id: i64,
    info: &Value,
    update: Update<'_>,
) -> anyhow::Result<()> {
    use anyhow::Context;
    let channel = info["channel_id"]
        .as_i64()
        .context("Missing Telegram callback channel")?;
    let chat = info["chat_id"]
        .as_i64()
        .context("Missing Telegram callback chat")?;
    let key = format!("channel:runtime_telegram_reply:{task_key}:{subtask_id}:{channel}:{chat}");
    // The preceding chunk may have saved the new message id on the writer.
    let stored: Option<String> = redis
        .eval(
            "return redis.call('get', KEYS[1])",
            [key.as_str()],
            [] as [&str; 0],
        )
        .await?;
    let mut reply = stored
        .and_then(|value| serde_json::from_str::<Reply>(&value).ok())
        .unwrap_or_else(|| Reply {
            message_id: info["message_id"].as_i64(),
            ..Reply::default()
        });
    if reply.finished {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp_millis();
    let terminal = matches!(update, Update::Terminal(..));
    let content = reply.render(update);
    if !content.is_empty()
        && (terminal || reply.message_id.is_none() || now - reply.last_edit_at >= 1000)
    {
        let result = telegram_message(state, channel, chat, reply.message_id, &content).await?;
        reply.message_id = result["message_id"].as_i64().or(reply.message_id);
        reply.last_edit_at = now;
    }
    reply.finished = terminal;
    redis
        .set_with(
            &key,
            serde_json::to_string(&reply)?,
            SetOptions::default().with_expiration(SetExpiration::Seconds(24 * 60 * 60)),
        )
        .await?;
    Ok(())
}

impl Reply {
    fn render(&mut self, update: Update<'_>) -> String {
        let answer = match update {
            Update::Progress(text, true) => {
                self.reasoning.extend(
                    text.chars()
                        .take(2048_usize.saturating_sub(self.reasoning.chars().count())),
                );
                self.content.clone()
            }
            Update::Progress(text, false) => {
                self.content.extend(
                    text.chars()
                        .take(MESSAGE_LIMIT.saturating_sub(self.content.chars().count())),
                );
                self.content.clone()
            }
            Update::Terminal(text, "COMPLETED") if !text.trim().is_empty() => text.to_owned(),
            Update::Terminal(text, _) if text.trim().is_empty() => self.content.clone(),
            Update::Terminal(text, _) if self.content.is_empty() => text.to_owned(),
            Update::Terminal(text, _) => format!("{}\n\n{text}", self.content),
        };
        let reasoning = self.reasoning.trim();
        match (reasoning.is_empty(), answer.trim().is_empty(), update) {
            (false, false, _) => answer_with_reasoning(&answer, reasoning),
            (false, true, _) => format!("💭 思考摘要\n{reasoning}"),
            (true, false, _) => answer.chars().take(MESSAGE_LIMIT).collect(),
            (true, true, Update::Progress(..)) => "⏳ 处理中...".to_owned(),
            (true, true, Update::Terminal(..)) => "✅ 已完成".to_owned(),
        }
    }
}

fn answer_with_reasoning(answer: &str, reasoning: &str) -> String {
    const REASONING_HEADER: &str = "💭 思考摘要\n";
    const ANSWER_HEADER: &str = "\n\n回复\n";
    let overhead = REASONING_HEADER.chars().count() + ANSWER_HEADER.chars().count();
    let reasoning_budget = MESSAGE_LIMIT.saturating_sub(answer.chars().count() + overhead);
    let summary: String = reasoning.chars().take(reasoning_budget).collect();
    let summary = summary.trim_end();
    if summary.is_empty() {
        return answer.chars().take(MESSAGE_LIMIT).collect();
    }
    format!("{REASONING_HEADER}{summary}{ANSWER_HEADER}{answer}")
}

pub(super) fn terminal_text(status: &str, result: Option<&Value>, error: Option<&str>) -> String {
    match status {
        "FAILED" => format!("❌ 错误: {}", error.unwrap_or("Unknown error")),
        "CANCELLED" | "CANCELED" => "⚠️ 任务已取消".to_owned(),
        _ => result
            .and_then(|result| {
                ["value", "output"]
                    .into_iter()
                    .filter_map(|key| result.get(key))
                    .find(|value| crate::json_compat::python_truthy(value))
            })
            .map(crate::json_compat::python_str)
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_is_retained_in_both_terminal_renderings() {
        let mut reply: Reply = serde_json::from_value(serde_json::json!({
            "message_id": 7, "content": "", "finished": false, "last_edit_at": 0
        }))
        .unwrap();
        assert_eq!(
            reply.render(Update::Progress("先检查", true)),
            "💭 思考摘要\n先检查"
        );
        assert_eq!(
            reply.render(Update::Terminal("", "COMPLETED")),
            "💭 思考摘要\n先检查"
        );
        reply.render(Update::Progress("draft", false));
        assert_eq!(
            reply.render(Update::Terminal("final", "COMPLETED")),
            "💭 思考摘要\n先检查\n\n回复\nfinal"
        );
        assert_eq!(
            Reply::default().render(Update::Terminal("", "COMPLETED")),
            "✅ 已完成"
        );
    }
    #[test]
    fn final_answer_keeps_its_full_budget_before_reasoning() {
        let mut reply = Reply::default();
        reply.render(Update::Progress(&"思".repeat(2048), true));
        for size in [3000, MESSAGE_LIMIT - 1, MESSAGE_LIMIT, MESSAGE_LIMIT + 1] {
            let answer = "答".repeat(size);
            let rendered = reply.render(Update::Terminal(&answer, "COMPLETED"));
            assert!(rendered.chars().count() <= MESSAGE_LIMIT);
            assert!(rendered.ends_with(&"答".repeat(size.min(MESSAGE_LIMIT))));
            if size >= MESSAGE_LIMIT - 1 {
                assert!(!rendered.contains("思考摘要"));
            }
        }
    }
}
