// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::{
    mcp::{CloudCollaborationRoundCommand, CloudCollaborationRoundDispatcher},
    mcp_http::register_cloud_collaboration_dispatcher,
};

const CLOUD_COLLABORATION_ROUND_KEY: &str = "cloudCollaborationRound";
const TERMINAL_EXECUTION_STATUSES: &[&str] = &["completed", "failed", "cancelled"];
const CLOUD_COLLABORATION_POLL_INTERVAL: Duration = Duration::from_secs(2);
const CLOUD_COLLABORATION_LAUNCH_RETRY_INTERVAL: Duration = Duration::from_secs(1);

impl RuntimeWorkRpcHandler {
    pub(super) fn register_cloud_collaboration_dispatcher(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            log_executor_event(
                "cloud collaboration dispatcher registration skipped",
                &[("reason", "tokio runtime is unavailable".to_owned())],
            );
            return;
        };
        let handler = self.clone();
        let dispatcher = CloudCollaborationRoundDispatcher::new(move |command| {
            handler.persist_cloud_collaboration_round(&command)?;
            let handler = handler.clone();
            runtime.spawn(async move {
                handler.monitor_cloud_collaboration_round(command).await;
            });
            Ok(())
        });
        if let Err(error) = register_cloud_collaboration_dispatcher(dispatcher) {
            log_executor_event(
                "cloud collaboration dispatcher registration failed",
                &[("error", error)],
            );
        }
    }

    pub(super) fn resume_cloud_collaboration_rounds(&self) {
        for link in self.local_task_links(false) {
            let Some(command) = link
                .runtime_handle
                .get(CLOUD_COLLABORATION_ROUND_KEY)
                .cloned()
                .and_then(|value| {
                    serde_json::from_value::<CloudCollaborationRoundCommand>(value).ok()
                })
            else {
                continue;
            };
            let handler = self.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    handler.monitor_cloud_collaboration_round(command).await;
                });
            }
        }
    }

    fn persist_cloud_collaboration_round(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<(), String> {
        if self
            .local_task_link(&command.manager_runtime_task_id)
            .is_none()
        {
            return Err("Collaboration manager Runtime task was not found".to_owned());
        }
        let encoded = serde_json::to_value(command).map_err(|error| error.to_string())?;
        self.store
            .update_task(&command.manager_runtime_task_id, |link| {
                if !link.runtime_handle.is_object() {
                    link.runtime_handle = json!({});
                }
                link.runtime_handle
                    .as_object_mut()
                    .expect("Runtime handle was normalized")
                    .insert(CLOUD_COLLABORATION_ROUND_KEY.to_owned(), encoded);
            });
        Ok(())
    }

    fn clear_cloud_collaboration_round(&self, manager_runtime_task_id: &str) {
        self.store.update_task(manager_runtime_task_id, |link| {
            if let Some(handle) = link.runtime_handle.as_object_mut() {
                handle.remove(CLOUD_COLLABORATION_ROUND_KEY);
            }
        });
    }

    async fn monitor_cloud_collaboration_round(&self, command: CloudCollaborationRoundCommand) {
        let key = format!("{}:{}", command.manager_runtime_task_id, command.round_id);
        {
            let mut active = self
                .active_collaboration_rounds
                .lock()
                .expect("collaboration round registry lock should not be poisoned");
            if !active.insert(key.clone()) {
                return;
            }
        }

        let result = match self.wait_for_cloud_collaboration_round(&command).await {
            Ok(outcomes) => self.launch_fresh_cloud_manager(&command, outcomes).await,
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            log_executor_event(
                "cloud collaboration round failed",
                &[
                    ("dispatch_id", command.dispatch_id.clone()),
                    ("round_id", command.round_id.clone()),
                    ("error", error),
                ],
            );
        }
        self.active_collaboration_rounds
            .lock()
            .expect("collaboration round registry lock should not be poisoned")
            .remove(&key);
    }

    async fn wait_for_cloud_collaboration_round(
        &self,
        command: &CloudCollaborationRoundCommand,
    ) -> Result<Vec<Value>, String> {
        let client = reqwest::Client::new();
        loop {
            let connection = self
                .backend_connection_snapshot()
                .map_err(|error| error.message)?
                .filter(|value| {
                    !value.backend_url.trim().is_empty() && !value.auth_token.trim().is_empty()
                });
            let Some(connection) = connection else {
                sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
                continue;
            };
            let response = match client
                .post(format!(
                    "{}/api/v1/cloud-projects/{}/executions/statuses",
                    connection.backend_url.trim_end_matches('/'),
                    command.project_id
                ))
                .bearer_auth(&connection.auth_token)
                .json(&json!({
                    "loop_item_id": command.item_id,
                    "execution_ids": command.execution_ids,
                    "human_assignment_ids": command.human_assignment_ids,
                }))
                .send()
                .await
            {
                Ok(response) => response,
                Err(error) => {
                    log_executor_event(
                        "cloud collaboration status request failed",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("error", error.to_string()),
                        ],
                    );
                    sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
                    continue;
                }
            };
            if !response.status().is_success() {
                let status = response.status();
                if status.is_server_error() || status.as_u16() == 429 {
                    log_executor_event(
                        "cloud collaboration status request rejected temporarily",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("status", status.to_string()),
                        ],
                    );
                    sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
                    continue;
                }
                return Err(format!("Collaboration status request failed ({status})"));
            }
            let value = match response.json::<Value>().await {
                Ok(value) => value,
                Err(error) => {
                    log_executor_event(
                        "cloud collaboration status response was invalid",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("error", error.to_string()),
                        ],
                    );
                    sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
                    continue;
                }
            };
            let outcomes = value
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| "Collaboration execution status response is invalid".to_owned())?;
            if outcomes.iter().all(|outcome| {
                outcome
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| TERMINAL_EXECUTION_STATUSES.contains(&status))
            }) {
                return Ok(outcomes);
            }
            sleep(CLOUD_COLLABORATION_POLL_INTERVAL).await;
        }
    }

    async fn launch_fresh_cloud_manager(
        &self,
        command: &CloudCollaborationRoundCommand,
        outcomes: Vec<Value>,
    ) -> Result<(), String> {
        let fresh_task_id = fresh_cloud_manager_task_id(command);
        loop {
            if self
                .local_task_link(&fresh_task_id)
                .is_some_and(|link| fresh_cloud_manager_task_started(&link))
            {
                self.clear_cloud_collaboration_round(&command.manager_runtime_task_id);
                return Ok(());
            }

            if self.local_task_link(&fresh_task_id).is_some() {
                self.store.delete_task(&fresh_task_id);
            }

            let Some(source_link) = self.local_task_link(&command.manager_runtime_task_id) else {
                return Err("Collaboration manager Runtime task was not found".to_owned());
            };
            let (mut request, payload) =
                fresh_cloud_manager_payload(&source_link, command, &outcomes);
            self.apply_backend_connection(&mut request);
            let mut payload = payload;
            payload["executionRequest"] =
                serde_json::to_value(request).unwrap_or_else(|_| json!({}));

            match self.create_task(payload).await {
                Ok(value)
                    if value.get("success").and_then(Value::as_bool) == Some(true)
                        && value.get("accepted").and_then(Value::as_bool) == Some(true) =>
                {
                    self.clear_cloud_collaboration_round(&command.manager_runtime_task_id);
                    return Ok(());
                }
                Ok(value) => {
                    log_executor_event(
                        "fresh cloud collaboration manager launch rejected",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("response", value.to_string()),
                        ],
                    );
                }
                Err(error) => {
                    log_executor_event(
                        "fresh cloud collaboration manager launch failed",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("error", error.message),
                        ],
                    );
                }
            }
            sleep(CLOUD_COLLABORATION_LAUNCH_RETRY_INTERVAL).await;
        }
    }
}

fn fresh_cloud_manager_task_id(command: &CloudCollaborationRoundCommand) -> String {
    format!(
        "{}-manager-after-{}",
        command.manager_runtime_task_id, command.round_id
    )
}

fn fresh_cloud_manager_task_started(link: &RuntimeTaskLink) -> bool {
    link.thread_id.is_some()
        || link.running
        || link.turn_status.is_some()
        || link
            .runtime_handle
            .get("queuePosition")
            .is_some_and(|value| !value.is_null())
}

fn fresh_cloud_manager_payload(
    source_link: &RuntimeTaskLink,
    command: &CloudCollaborationRoundCommand,
    outcomes: &[Value],
) -> (ExecutionRequest, Value) {
    let task_id = fresh_cloud_manager_task_id(command);
    let prompt = format!(
        "上一轮任务已经全部结束。请读取以下执行结果，综合判断是否需要分配下一轮任务；如 Issue 已达到待确认或完成条件，请显式调用 update_issue_status。不要直接执行成员工作。\n\n{}",
        serde_json::to_string_pretty(outcomes).unwrap_or_else(|_| "[]".to_owned()),
    );
    let mut request = runtime_event_request_from_link(source_link);
    request.task_id = task_id.clone();
    request.subtask_id = format!("{task_id}-initial");
    request.prompt = Value::String(prompt.clone());
    request.history.clear();
    request.message_id = None;
    request.new_session = true;

    let mut payload = json!({
        "schemaVersion": 1,
        "taskId": task_id,
        "runtime": source_link.runtime,
        "title": source_link.title,
        "message": prompt,
        "workspacePath": source_link.workspace_path,
        "executionRequest": request,
    });
    if let Some(model_selection) = source_link
        .runtime_handle
        .get("modelSelection")
        .or_else(|| source_link.runtime_handle.get("model_selection"))
    {
        payload["modelSelection"] = model_selection.clone();
    }
    if let Some(origin) = request.extra.get("origin") {
        payload["origin"] = origin.clone();
    }
    (request, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> CloudCollaborationRoundCommand {
        CloudCollaborationRoundCommand {
            manager_runtime_task_id: "manager-task-1".to_owned(),
            project_id: "7".to_owned(),
            item_id: "issue-1".to_owned(),
            dispatch_id: "dispatch-1".to_owned(),
            round_id: "round-1".to_owned(),
            execution_ids: vec![1],
            human_assignment_ids: vec!["human-assignment-1".to_owned()],
        }
    }

    fn source_link() -> RuntimeTaskLink {
        let mut link = RuntimeTaskLink::new_pending_with_runtime(
            "manager-task-1".to_owned(),
            "/tmp/project".to_owned(),
            "Issue manager".to_owned(),
            "codex",
        );
        link.runtime_handle = json!({
            "modelSelection": {
                "modelName": "gpt-6-sol",
                "modelType": "runtime",
            },
            "executionRequest": {
                "system_prompt": "manager system instructions",
                "mcp_servers": [{"name": "wework_space"}],
                "extra": {
                    "origin": {
                        "cloudProjectId": 7,
                        "loopItemId": "issue-1",
                        "dispatchId": "dispatch-1",
                        "dispatchRole": "manager",
                        "managerAgentId": "agent-1"
                    }
                }
            },
            "origin": {
                "cloudProjectId": 7,
                "loopItemId": "issue-1",
                "dispatchId": "dispatch-1",
                "dispatchRole": "manager",
                "managerAgentId": "agent-1"
            }
        });
        link
    }

    #[test]
    fn fresh_cloud_manager_payload_starts_new_session() {
        let command = command();
        let source = source_link();
        let outcomes = vec![json!({
            "execution_id": "execution-1",
            "status": "completed",
            "result": "done",
        })];

        let (request, payload) = fresh_cloud_manager_payload(&source, &command, &outcomes);

        assert_eq!(request.task_id, "manager-task-1-manager-after-round-1");
        assert_eq!(
            request.subtask_id,
            "manager-task-1-manager-after-round-1-initial"
        );
        assert!(request.new_session);
        assert!(request.history.is_empty());
        assert_eq!(request.message_id, None);
        assert_eq!(request.system_prompt, "manager system instructions");
        assert_eq!(request.mcp_servers, vec![json!({"name": "wework_space"})]);
        assert_eq!(
            request.extra["origin"]["dispatchRole"],
            Value::String("manager".to_owned())
        );
        assert!(request
            .prompt
            .as_str()
            .is_some_and(|prompt| prompt.contains("\"result\": \"done\"")));
        assert_eq!(payload["runtime"], "codex");
        assert_eq!(payload["workspacePath"], "/tmp/project");
        assert_eq!(
            payload["modelSelection"]["modelName"],
            Value::String("gpt-6-sol".to_owned())
        );
        assert_eq!(
            payload["origin"]["managerAgentId"],
            Value::String("agent-1".to_owned())
        );
    }

    #[test]
    fn fresh_cloud_manager_identity_is_stable_per_round() {
        let command = command();

        assert_eq!(
            fresh_cloud_manager_task_id(&command),
            fresh_cloud_manager_task_id(&command)
        );
        assert_ne!(
            fresh_cloud_manager_task_id(&command),
            command.manager_runtime_task_id
        );
    }

    #[test]
    fn fresh_cloud_manager_is_started_only_after_runtime_acceptance() {
        let pending = RuntimeTaskLink::new_pending(
            "manager-task-1-manager-after-round-1".to_owned(),
            "/tmp/project".to_owned(),
            "Issue manager".to_owned(),
        );
        assert!(!fresh_cloud_manager_task_started(&pending));

        let mut started = pending;
        started.thread_id = Some("thread-1".to_owned());
        assert!(fresh_cloud_manager_task_started(&started));
    }
}
