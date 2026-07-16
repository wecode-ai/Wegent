// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub event_type: String,
    pub task_id: String,
    pub subtask_id: String,
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
    task_id: String,
    subtask_id: String,
    model: String,
    response_id: String,
    item_id: String,
    created_at: i64,
    message_id: Option<i64>,
    executor_name: Option<String>,
    executor_namespace: Option<String>,
}

impl ResponsesEventBuilder {
    pub fn new(
        task_id: impl Into<String>,
        subtask_id: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        let task_id = task_id.into();
        let subtask_id = subtask_id.into();
        Self {
            task_id,
            subtask_id: subtask_id.clone(),
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

    pub fn response_text_delta(&self, delta: &str, offset: usize) -> EventEnvelope {
        self.envelope(
            "response.output_text.delta",
            json!({
                "type": "response.output_text.delta",
                "item_id": self.item_id,
                "output_index": 0,
                "content_index": 0,
                "delta": delta,
                "offset": offset
            }),
        )
    }

    pub fn response_reasoning_delta(&self, delta: &str) -> EventEnvelope {
        self.envelope(
            "response.reasoning_summary_text.delta",
            json!({
                "type": "response.reasoning_summary_text.delta",
                "item_id": self.item_id,
                "output_index": 0,
                "content_index": 0,
                "delta": delta
            }),
        )
    }

    pub fn response_function_call_added(
        &self,
        call_id: &str,
        name: &str,
        arguments: &Value,
    ) -> EventEnvelope {
        let arguments_text = serialize_json(arguments);
        self.envelope(
            "response.output_item.added",
            json!({
                "type": "response.output_item.added",
                "response_id": self.response_id,
                "output_index": 0,
                "item": {
                    "type": "function_call",
                    "id": call_id,
                    "call_id": call_id,
                    "name": name,
                    "arguments": arguments_text
                },
                "display_name": name,
                "argument_status": "done",
                "arguments_summary": arguments
            }),
        )
    }

    pub fn response_function_call_arguments_done(
        &self,
        call_id: &str,
        arguments: &Value,
    ) -> EventEnvelope {
        self.envelope(
            "response.function_call_arguments.done",
            json!({
                "type": "response.function_call_arguments.done",
                "response_id": self.response_id,
                "item_id": call_id,
                "call_id": call_id,
                "output_index": 0,
                "arguments": serialize_json(arguments),
                "arguments_summary": arguments
            }),
        )
    }

    pub fn response_function_call_done(
        &self,
        call_id: &str,
        name: &str,
        arguments: &Value,
        output: Option<&str>,
        is_error: bool,
    ) -> EventEnvelope {
        self.envelope(
            "response.output_item.done",
            json!({
                "type": "response.output_item.done",
                "response_id": self.response_id,
                "output_index": 0,
                "item": {
                    "type": "function_call",
                    "id": call_id,
                    "call_id": call_id,
                    "name": name,
                    "arguments": serialize_json(arguments),
                    "status": if is_error { "failed" } else { "completed" },
                    "output": output
                }
            }),
        )
    }

    pub fn response_tool_block_created(
        &self,
        tool_use_id: &str,
        name: &str,
        input: &Value,
        parent_tool_use_id: Option<&str>,
    ) -> EventEnvelope {
        let mut block = json!({
            "id": tool_use_id,
            "type": "tool",
            "tool_use_id": tool_use_id,
            "tool_name": name,
            "tool_input": input,
            "status": "pending",
            "timestamp": current_epoch_millis()
        });
        if let Some(parent_tool_use_id) = parent_tool_use_id {
            block["parent_tool_use_id"] = json!(parent_tool_use_id);
        }
        self.envelope(
            "response.block.created",
            json!({
                "type": "response.block.created",
                "block": block
            }),
        )
    }

    pub fn response_subagent_block_created(
        &self,
        tool_use_id: &str,
        name: &str,
        input: &Value,
        parent_tool_use_id: Option<&str>,
    ) -> EventEnvelope {
        let title = input.get("description").and_then(Value::as_str);
        let agent_type = input
            .get("subagent_type")
            .or_else(|| input.get("agent_type"))
            .and_then(Value::as_str);
        let mut block = json!({
            "id": tool_use_id,
            "type": "subagent",
            "tool_use_id": tool_use_id,
            "tool_name": name,
            "tool_input": input,
            "title": title,
            "description": input.get("description").and_then(Value::as_str),
            "agent_type": agent_type,
            "status": "queued",
            "timestamp": current_epoch_millis(),
            "children": []
        });
        if let Some(parent_tool_use_id) = parent_tool_use_id {
            block["parent_tool_use_id"] = json!(parent_tool_use_id);
        }
        self.envelope(
            "response.block.created",
            json!({
                "type": "response.block.created",
                "block": block
            }),
        )
    }

    pub fn response_child_block_created(
        &self,
        block_id: &str,
        block_type: &str,
        parent_tool_use_id: &str,
        content: &str,
    ) -> EventEnvelope {
        self.envelope(
            "response.block.created",
            json!({
                "type": "response.block.created",
                "block": {
                    "id": block_id,
                    "type": block_type,
                    "parent_tool_use_id": parent_tool_use_id,
                    "content": content,
                    "status": "done",
                    "timestamp": current_epoch_millis()
                }
            }),
        )
    }

    pub fn response_tool_block_updated(
        &self,
        tool_use_id: &str,
        input: &Value,
        output: Option<&str>,
        is_error: bool,
        parent_tool_use_id: Option<&str>,
    ) -> EventEnvelope {
        let mut updates = json!({
            "tool_input": input,
            "tool_output": output,
            "status": if is_error { "error" } else { "done" }
        });
        if let Some(parent_tool_use_id) = parent_tool_use_id {
            updates["parent_tool_use_id"] = json!(parent_tool_use_id);
        }
        self.envelope(
            "response.block.updated",
            json!({
                "type": "response.block.updated",
                "block_id": tool_use_id,
                "updates": updates
            }),
        )
    }

    pub fn response_subagent_block_updated(
        &self,
        tool_use_id: &str,
        status: Option<&str>,
        output: Option<&str>,
        summary: Option<&str>,
        parent_tool_use_id: Option<&str>,
    ) -> EventEnvelope {
        let mut updates = json!({});
        if let Some(status) = status {
            updates["status"] = json!(status);
        }
        if let Some(output) = output {
            updates["output"] = json!(output);
        }
        if let Some(summary) = summary {
            updates["summary"] = json!(summary);
        }
        if let Some(parent_tool_use_id) = parent_tool_use_id {
            updates["parent_tool_use_id"] = json!(parent_tool_use_id);
        }
        self.envelope(
            "response.block.updated",
            json!({
                "type": "response.block.updated",
                "block_id": tool_use_id,
                "updates": updates
            }),
        )
    }

    pub fn response_waiting_for_user_input(&self, stop_reason: &str) -> EventEnvelope {
        let stop_reason = stop_reason.trim();
        let mut response = self.response_payload("completed", json!([]));
        response["usage"] = Value::Null;
        response["stop_reason"] = json!(if stop_reason.is_empty() {
            "tool_deferred"
        } else {
            stop_reason
        });
        response["silent_exit"] = json!(true);
        response["silent_exit_reason"] = json!("waiting_for_user_input");
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
            task_id: self.task_id.clone(),
            subtask_id: self.subtask_id.clone(),
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

fn current_epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn serialize_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned())
}
