// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;
use tokio::sync::mpsc;

use super::{
    host::HookService,
    model::{HookEventName, LifecycleInput},
};

/// Small metadata only. Dropping the publisher lets accepted events drain.
pub struct LifecycleHooks {
    sender: mpsc::UnboundedSender<LifecycleInput>,
    context: LifecycleInput,
    active: Option<(String, String)>,
    last_completed: Option<(String, String)>,
    finished: bool,
}

impl LifecycleHooks {
    pub fn new(service: HookService, context: LifecycleInput) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(input) = receiver.recv().await {
                service.dispatch_lifecycle(input).await;
            }
        });
        let mut hooks = Self {
            sender,
            context,
            active: None,
            last_completed: None,
            finished: false,
        };
        hooks.emit(HookEventName::TurnStarted, "started");
        hooks
    }

    pub fn started(&mut self, session_id: &str, turn_id: &str) {
        if self.finished {
            return;
        }
        self.active = Some((session_id.into(), turn_id.into()));
    }

    pub fn observe_codex(&mut self, root_thread_id: &str, message: &Value) {
        if self.finished {
            return;
        }
        let params = &message["params"];
        let thread = params["threadId"]
            .as_str()
            .or_else(|| params["thread_id"].as_str());
        let agent = params["turn"]["agentPath"]
            .as_str()
            .or_else(|| params["turn"]["agent_path"].as_str())
            .or_else(|| params["agentPath"].as_str())
            .or_else(|| params["agent_path"].as_str());
        if thread != Some(root_thread_id) || agent.is_some_and(|path| path != "/root") {
            return;
        }
        let Some(turn_id) = params["turn"]["id"].as_str() else {
            return;
        };
        match message["method"].as_str() {
            Some("turn/started") => self.started(root_thread_id, turn_id),
            Some("turn/completed") => {
                let turn = (root_thread_id.to_owned(), turn_id.to_owned());
                if self.last_completed.as_ref() != Some(&turn) {
                    self.active = Some(turn.clone());
                    self.emit(
                        HookEventName::TurnCompleted,
                        params["turn"]["status"].as_str().unwrap_or("completed"),
                    );
                    self.active = None;
                    self.last_completed = Some(turn);
                }
            }
            _ => {}
        }
    }

    pub fn finish(&mut self, status: &str) {
        if self.finished {
            return;
        }
        if self.active.is_some() && self.active != self.last_completed {
            self.emit(HookEventName::TurnCompleted, status);
        }
        self.emit(HookEventName::ExecutionCompleted, status);
        self.active = None;
        self.finished = true;
    }

    fn emit(&mut self, event: HookEventName, status: &str) {
        let mut input = self.context.clone();
        input.emitted_at_ms = chrono::Utc::now().timestamp_millis();
        input.event_id = format!("{}:{}", input.execution_id, input.sequence);
        input.hook_event_name = event;
        input.status = status.into();
        if let Some((session, turn)) = self.active.as_ref().or(self.last_completed.as_ref()) {
            input.session_id = Some(session.clone());
            input.turn_id = Some(turn.clone());
        }
        // The receiver runs scripts independently; no process or file I/O here.
        if self.sender.send(input).is_err() {
            eprintln!("Lifecycle Hook consumer stopped unexpectedly");
        }
        self.context.sequence += 1;
    }
}

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod tests;
