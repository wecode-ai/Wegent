// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Internal execution event model and its source-compatible JSON shape.
//!
//! Mirrors `shared/models/execution.py`. `ExecutionEvent.to_dict()` is
//! `dataclasses.asdict`, so the field order below is the wire order used by
//! `publish_callback_event`, and the callback-channel payload must preserve it
//! exactly.
use serde_json::{Map, Value, json};

/// `EventType` values used by the callback pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EventType {
    Start,
    Chunk,
    Thinking,
    Tool,
    ToolStart,
    ToolArgumentDelta,
    ToolArgumentDone,
    ToolResult,
    BlockCreated,
    BlockUpdated,
    StatusUpdated,
    Done,
    Error,
    Cancelled,
}

impl EventType {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Chunk => "chunk",
            Self::Thinking => "thinking",
            Self::Tool => "tool",
            Self::ToolStart => "tool_start",
            Self::ToolArgumentDelta => "tool_argument_delta",
            Self::ToolArgumentDone => "tool_argument_done",
            Self::ToolResult => "tool_result",
            Self::BlockCreated => "block_created",
            Self::BlockUpdated => "block_updated",
            Self::StatusUpdated => "status_updated",
            Self::Done => "done",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}

/// One internal execution event (`ExecutionEvent`).
#[derive(Debug, Clone, Default)]
pub(crate) struct ExecutionEvent {
    pub event_type: String,
    pub task_id: i64,
    pub subtask_id: i64,
    pub content: String,
    pub offset: i64,
    pub result: Option<Value>,
    pub progress: i64,
    pub status: String,
    pub error: Option<String>,
    pub error_code: Option<String>,
    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
    pub tool_input: Option<Value>,
    pub tool_output: Option<Value>,
    pub message_id: Option<i64>,
    pub executor_name: Option<String>,
    pub executor_namespace: Option<String>,
    pub timestamp: Option<String>,
    pub data: Map<String, Value>,
}

impl ExecutionEvent {
    pub(crate) fn new(event_type: EventType, task_id: i64, subtask_id: i64) -> Self {
        Self {
            event_type: event_type.as_str().to_string(),
            task_id,
            subtask_id,
            ..Self::default()
        }
    }

    /// `ExecutionEvent.to_dict()` with `asdict` field order.
    pub(crate) fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("type".into(), Value::String(self.event_type.clone()));
        map.insert("task_id".into(), json!(self.task_id));
        map.insert("subtask_id".into(), json!(self.subtask_id));
        map.insert("content".into(), Value::String(self.content.clone()));
        map.insert("offset".into(), json!(self.offset));
        map.insert("result".into(), self.result.clone().unwrap_or(Value::Null));
        map.insert("progress".into(), json!(self.progress));
        map.insert("status".into(), Value::String(self.status.clone()));
        map.insert(
            "error".into(),
            self.error.clone().map_or(Value::Null, Value::String),
        );
        map.insert(
            "error_code".into(),
            self.error_code.clone().map_or(Value::Null, Value::String),
        );
        map.insert(
            "tool_name".into(),
            self.tool_name.clone().map_or(Value::Null, Value::String),
        );
        map.insert(
            "tool_use_id".into(),
            self.tool_use_id.clone().map_or(Value::Null, Value::String),
        );
        map.insert(
            "tool_input".into(),
            self.tool_input.clone().unwrap_or(Value::Null),
        );
        map.insert(
            "tool_output".into(),
            self.tool_output.clone().unwrap_or(Value::Null),
        );
        map.insert(
            "message_id".into(),
            self.message_id.map_or(Value::Null, |value| json!(value)),
        );
        map.insert(
            "executor_name".into(),
            self.executor_name
                .clone()
                .map_or(Value::Null, Value::String),
        );
        map.insert(
            "executor_namespace".into(),
            self.executor_namespace
                .clone()
                .map_or(Value::Null, Value::String),
        );
        map.insert(
            "timestamp".into(),
            self.timestamp.clone().map_or(Value::Null, Value::String),
        );
        map.insert("data".into(), Value::Object(self.data.clone()));
        Value::Object(map)
    }
}
