// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

pub struct BackgroundChat<'a> {
    pub user_id: i64,
    pub title: &'a str,
    pub task_type: &'a str,
    pub summary_type: &'a str,
    pub document_id: Option<i64>,
    pub knowledge_base_id: Option<i64>,
    pub system_prompt: &'a str,
    pub prompt: &'a str,
    pub model_config: Value,
}

pub struct ChatResult {
    pub task_id: i64,
    pub content: String,
    pub parsed: Option<Value>,
}

#[async_trait::async_trait]
pub trait BackgroundChatExecutor: Send + Sync {
    async fn execute(&self, input: BackgroundChat<'_>) -> anyhow::Result<ChatResult>;
    async fn model_config(
        &self,
        spec: &Value,
        user_id: i64,
        user_name: &str,
    ) -> anyhow::Result<Value>;
}
