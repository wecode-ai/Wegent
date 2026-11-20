// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use sha2::{Digest, Sha256};

impl RuntimeWorkRpcHandler {
    pub(super) async fn launch_fresh_cloud_manager(
        &self,
        command: &CloudCollaborationRoundCommand,
        outcomes: Vec<Value>,
    ) -> Result<(), String> {
        let task_id = &command.manager_runtime_task_id;
        let legacy_task_id = fresh_cloud_manager_task_id(command);
        let turn_id = cloud_manager_round_turn_id(command);
        loop {
            if self
                .local_task_link(&legacy_task_id)
                .is_some_and(|link| fresh_cloud_manager_task_started(&link))
            {
                self.publish_fresh_cloud_manager(command, &legacy_task_id, false)
                    .await?;
                self.clear_cloud_collaboration_round(command);
                return Ok(());
            }

            let Some(source_link) = self.local_task_link(task_id) else {
                return Err("Collaboration manager Runtime task was not found".to_owned());
            };
            if self.manager_round_accepted(&source_link, &turn_id) {
                self.clear_cloud_collaboration_round(command);
                return Ok(());
            }
            let mut payload = self.prepare_fresh_cloud_manager(&source_link, command, &outcomes)?;
            // Publish ownership and transcript access before the next turn can
            // ask a blocking question or submit its next round.
            let profiles = self
                .publish_fresh_cloud_manager(command, task_id, true)
                .await?;
            apply_fresh_cloud_manager_profiles(&mut payload, profiles)?;

            match self.send_message(payload).await {
                Ok(value)
                    if value.get("success").and_then(Value::as_bool) == Some(true)
                        && value.get("accepted").and_then(Value::as_bool) == Some(true) =>
                {
                    self.clear_cloud_collaboration_round(command);
                    log_executor_event(
                        "cloud collaboration manager continuation accepted",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("manager_task_id", task_id.clone()),
                        ],
                    );
                    return Ok(());
                }
                Ok(value) => {
                    log_executor_event(
                        "cloud collaboration manager continuation rejected",
                        &[
                            ("round_id", command.round_id.clone()),
                            ("response", value.to_string()),
                        ],
                    );
                }
                Err(error) => {
                    log_executor_event(
                        "cloud collaboration manager continuation failed",
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

    fn manager_round_accepted(&self, link: &RuntimeTaskLink, turn_id: &str) -> bool {
        crate::runtime_work::runtime_handle_messages::user_message_presentations(link)
            .iter()
            .any(|message| message["clientUserMessageId"] == turn_id)
            || self
                .turn_scheduler
                .lock()
                .expect("turn scheduler poisoned")
                .queued_turns
                .iter()
                .any(|turn| {
                    turn.local_task_id == link.local_task_id
                        && turn.request.extra.get("client_user_message_id") == Some(&json!(turn_id))
                })
    }

    async fn publish_fresh_cloud_manager(
        &self,
        command: &CloudCollaborationRoundCommand,
        task_id: &str,
        refresh_profiles: bool,
    ) -> Result<Value, String> {
        let mut payload = json!({
            "role": "manager",
            "loop_item_id": command.item_id,
            "dispatch_id": command.dispatch_id,
            "round_id": command.round_id,
            "runtime_device_id": self.device_id,
            "runtime_task_id": task_id,
        });
        if refresh_profiles {
            payload["refresh_runtime_profiles"] = json!(true);
        }
        loop {
            match self
                .report_cloud_collaboration_activity(command, &payload)
                .await
            {
                Ok(response) => {
                    if !refresh_profiles {
                        return Ok(Value::Null);
                    }
                    match response.bytes().await {
                        Ok(body) => {
                            let mut envelope: Value =
                                serde_json::from_slice(&body).map_err(|_| {
                                    "Backend returned invalid collaboration Runtime profiles"
                                        .to_owned()
                                })?;
                            return Ok(envelope
                                .get_mut("runtime_profiles")
                                .map(Value::take)
                                .unwrap_or_default());
                        }
                        Err(_) => log_executor_event(
                            "cloud collaboration manager profile response interrupted",
                            &[("manager_task_id", task_id.to_owned())],
                        ),
                    }
                }
                Err(error) => {
                    log_executor_event(
                        "cloud collaboration manager publication failed",
                        &[
                            ("manager_task_id", task_id.to_owned()),
                            ("error", error.message.clone()),
                        ],
                    );
                    if !error.retryable {
                        return Err(error.message);
                    }
                }
            }
            sleep(CLOUD_COLLABORATION_LAUNCH_RETRY_INTERVAL).await;
        }
    }

    pub(super) fn prepare_fresh_cloud_manager(
        &self,
        source: &RuntimeTaskLink,
        command: &CloudCollaborationRoundCommand,
        outcomes: &[Value],
    ) -> Result<Value, String> {
        let (mut request, mut payload) = fresh_cloud_manager_payload(source, command, outcomes)?;
        super::super::project_coordination_execution::restore_identity(
            &mut request,
            &source.runtime_handle,
        )?;
        // Model credentials are fetched when publishing this manager's Issue session.
        request.model_config = json!({});
        self.apply_backend_connection(&mut request);
        payload["executionRequest"] =
            serde_json::to_value(request).map_err(|error| error.to_string())?;
        Ok(payload)
    }
}

pub(super) fn apply_fresh_cloud_manager_profiles(
    payload: &mut Value,
    profiles: Value,
) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    struct RuntimeProfiles {
        manager_model_config: serde_json::Map<String, Value>,
        manager_model_selection: Option<serde_json::Map<String, Value>>,
        member_runtime_profiles: Vec<Value>,
    }
    let profiles: RuntimeProfiles = serde_json::from_value(profiles)
        .map_err(|_| "Backend did not return collaboration Runtime profiles".to_owned())?;
    payload["executionRequest"]["model_config"] = Value::Object(profiles.manager_model_config);
    if let Some(selection) = profiles.manager_model_selection {
        payload["modelSelection"] = Value::Object(selection);
    }
    payload["runtimeHandle"]["collaborationMemberRuntimeProfiles"] =
        Value::Array(profiles.member_runtime_profiles);
    Ok(())
}

pub(super) fn fresh_cloud_manager_task_id(command: &CloudCollaborationRoundCommand) -> String {
    resumed_manager_task_id(&command.manager_runtime_task_id, &command.round_id)
}

fn cloud_manager_round_turn_id(command: &CloudCollaborationRoundCommand) -> String {
    let identity = json!([command.dispatch_id, command.round_id]).to_string();
    format!("{:x}", Sha256::digest(identity.as_bytes()))
}

fn resumed_manager_task_id(manager_task_id: &str, round_id: &str) -> String {
    let candidate = format!("{manager_task_id}-manager-after-{round_id}");
    if candidate.chars().count() <= 255 {
        return candidate;
    }
    let identity = json!([manager_task_id, round_id]).to_string();
    format!(
        "collaboration-manager-{:x}",
        Sha256::digest(identity.as_bytes())
    )
}

pub(super) fn fresh_cloud_manager_task_started(link: &RuntimeTaskLink) -> bool {
    link.thread_id.is_some()
        || link.running
        || link.turn_status.is_some()
        || link
            .runtime_handle
            .get("queuePosition")
            .is_some_and(|value| !value.is_null())
}

pub(super) fn fresh_cloud_manager_payload(
    source_link: &RuntimeTaskLink,
    command: &CloudCollaborationRoundCommand,
    outcomes: &[Value],
) -> Result<(ExecutionRequest, Value), String> {
    let task_id = command.manager_runtime_task_id.clone();
    let turn_id = cloud_manager_round_turn_id(command);
    let manager_context = source_link
        .runtime_handle
        .get(COLLABORATION_MANAGER_CONTEXT_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Collaboration manager context is unavailable".to_owned())?;
    let prompt = format!(
        "{manager_context}\n\n<collaboration_round_results>\n上一轮任务已经全部结束。请读取以下执行结果，综合判断是否需要分配下一轮任务；如 Issue 已达到待确认或完成条件，请显式调用 update_issue_status。不要直接执行成员工作。\n\n{}\n</collaboration_round_results>",
        serde_json::to_string_pretty(outcomes).unwrap_or_else(|_| "[]".to_owned()),
    );
    let mut request = runtime_event_request_from_link(source_link);
    request.task_id = task_id.clone();
    request.subtask_id = turn_id.clone();
    request.prompt = Value::String(prompt.clone());
    request.history.clear();
    request.message_id = None;
    request.new_session = false;
    if let Some(origin) = request
        .extra
        .get_mut("origin")
        .and_then(Value::as_object_mut)
    {
        origin.remove("executionId");
        origin.remove("execution_id");
    }

    let mut payload = json!({
        "schemaVersion": 1,
        "taskId": task_id,
        "clientUserMessageId": turn_id,
        "queueIfBusy": true,
        "runtime": source_link.runtime,
        "collaboration_model": "single",
        "title": source_link.title,
        "message": prompt,
        "workspacePath": source_link.workspace_path,
        "executionRequest": request,
        "runtimeHandle": {
            "collaborationManagerContext": manager_context,
            "collaborationDispatchTaskId": source_link
                .runtime_handle
                .get("collaborationDispatchTaskId")
                .cloned()
                .unwrap_or(Value::Null),
        },
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
    let identity_key = super::super::project_coordination_execution::IDENTITY_KEY;
    if let Some(identity) = source_link.runtime_handle.get(identity_key) {
        payload["runtimeHandle"][identity_key] = identity.clone();
    }
    Ok((request, payload))
}

#[cfg(test)]
mod task_id_tests {
    use super::resumed_manager_task_id;

    #[test]
    fn manager_lineage_stays_within_the_persisted_id_limit() {
        assert_eq!(
            resumed_manager_task_id("manager-task-1", "round-1"),
            "manager-task-1-manager-after-round-1"
        );
        assert_eq!(
            resumed_manager_task_id(&"m".repeat(239), "r"),
            format!("{}-manager-after-r", "m".repeat(239))
        );
        assert_eq!(
            resumed_manager_task_id(&"m".repeat(255), &"r".repeat(128)),
            "collaboration-manager-b3b830da1c050c0d6d371db96a2b2820336ee1574eb99ebd3c9dc86413358186"
        );
        assert_eq!(
            resumed_manager_task_id(&"m".repeat(240), &"澄清".repeat(20)),
            "collaboration-manager-46bd8b428e70c1a5915f224e44ca0ea4cb3ec5ac484d1e3a9c6ed06caf07b0de"
        );
        let unicode = "澄".repeat(200);
        assert_eq!(
            resumed_manager_task_id(&unicode, "r"),
            format!("{unicode}-manager-after-r")
        );
        let mut current = "manager-task-1".to_owned();
        for index in 0..100 {
            current = resumed_manager_task_id(&current, &format!("{index}-{}", "r".repeat(120)));
            assert!(current.chars().count() <= 255);
        }
    }
}
