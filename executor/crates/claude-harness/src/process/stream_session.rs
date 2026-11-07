// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::task::AbortHandle;

use crate::{
    agent_session,
    protocol::{AgentKind, ExecutionRequest},
};

/// Preserve the task/Bot binding before cancellation can discard process output.
#[derive(Clone)]
pub(super) struct SessionRecorder {
    request: Arc<Mutex<Option<ExecutionRequest>>>,
}

impl SessionRecorder {
    pub(super) fn new(request: &ExecutionRequest) -> Self {
        let request =
            (request.resolved_agent_kind() == AgentKind::ClaudeCode).then(|| ExecutionRequest {
                task_id: request.task_id.clone(),
                bot: request.bot.clone(),
                ..ExecutionRequest::default()
            });
        Self {
            request: Arc::new(Mutex::new(request)),
        }
    }

    /// Retries have independent reader lifetimes within the same execution.
    pub(super) fn for_reader(&self) -> Self {
        Self {
            request: Arc::new(Mutex::new(self.request.lock().unwrap().clone())),
        }
    }

    pub(super) fn observe(&self, value: &Value) {
        if value["type"] != "system"
            || value["subtype"] != "init"
            || !value["parent_tool_use_id"].is_null()
        {
            return;
        }
        let Some(id) = value["session_id"].as_str().filter(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        }) else {
            return;
        };
        // Cancellation takes this same lock before releasing the parent task.
        // An old reader can never finish a write after its parent has stopped.
        if let Some(request) = self.request.lock().unwrap().as_ref() {
            agent_session::save_session_id(request, id);
        }
    }

    fn stop(&self) {
        let _ = self.request.lock().unwrap().take();
    }
}

pub(super) struct ReaderGuard {
    reader: AbortHandle,
    session: SessionRecorder,
}

impl ReaderGuard {
    pub(super) fn new(reader: AbortHandle, session: SessionRecorder) -> Self {
        Self { reader, session }
    }
}

impl Drop for ReaderGuard {
    fn drop(&mut self) {
        self.session.stop();
        self.reader.abort();
    }
}

#[cfg(test)]
#[path = "stream_session_tests.rs"]
mod tests;
