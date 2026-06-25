// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub event_type: String,
    pub task_id: i64,
    pub subtask_id: i64,
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_namespace: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResponsesEventBuilder {
    task_id: i64,
    subtask_id: i64,
    model: String,
    response_id: String,
    item_id: String,
    created_at: i64,
    message_id: Option<i64>,
    executor_name: Option<String>,
    executor_namespace: Option<String>,
}

impl ResponsesEventBuilder {
    pub fn new(task_id: i64, subtask_id: i64, model: impl Into<String>) -> Self {
        Self {
            task_id,
            subtask_id,
            model: model.into(),
            response_id: default_response_id(),
            item_id: format!("msg_{subtask_id}"),
            created_at: current_epoch_seconds(),
            message_id: None,
            executor_name: None,
            executor_namespace: None,
        }
    }

    pub fn with_response_id(mut self, response_id: impl Into<String>) -> Self {
        self.response_id = response_id.into();
        self
    }

    pub fn with_message_id(mut self, message_id: Option<i64>) -> Self {
        self.message_id = message_id;
        self
    }

    pub fn with_executor_info(
        mut self,
        executor_name: Option<&str>,
        executor_namespace: Option<&str>,
    ) -> Self {
        self.executor_name = executor_name.map(ToOwned::to_owned);
        self.executor_namespace = executor_namespace.map(ToOwned::to_owned);
        self
    }

    pub fn response_created(&self, shell_type: Option<&str>) -> EventEnvelope {
        let mut data = json!({
            "type": "response.created",
            "response": self.response_payload("in_progress", json!([])),
        });
        if let Some(shell_type) = shell_type {
            data["shell_type"] = json!(shell_type);
        }
        self.envelope("response.created", data)
    }

    pub fn response_completed(&self, content: &str) -> EventEnvelope {
        let output = json!([{
            "type": "message",
            "id": self.item_id,
            "status": "completed",
            "role": "assistant",
            "content": [{
                "type": "output_text",
                "text": content,
                "annotations": []
            }]
        }]);
        let mut response = self.response_payload("completed", output);
        response["usage"] = Value::Null;
        response["stop_reason"] = json!("end_turn");
        self.envelope(
            "response.completed",
            json!({"type": "response.completed", "response": response}),
        )
    }

    pub fn error(&self, message: &str, code: &str) -> EventEnvelope {
        self.envelope(
            "error",
            json!({"type": "error", "code": code, "message": message}),
        )
    }

    fn envelope(&self, event_type: &str, data: Value) -> EventEnvelope {
        EventEnvelope {
            event_type: event_type.to_owned(),
            task_id: self.task_id,
            subtask_id: self.subtask_id,
            data,
            message_id: self.message_id,
            executor_name: self.executor_name.clone(),
            executor_namespace: self.executor_namespace.clone(),
        }
    }

    fn response_payload(&self, status: &str, output: Value) -> Value {
        json!({
            "id": self.response_id,
            "object": "response",
            "created_at": self.created_at,
            "model": self.model,
            "status": status,
            "output": output
        })
    }
}

fn default_response_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("resp_{nanos:024x}")
}

fn current_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}
