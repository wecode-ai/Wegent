//! Only completed public messages from the owning Issue conversation become comments.
use super::stand_in::settings_error;
use super::*;
use sha2::{Digest, Sha256};

fn is_cloud_collaboration_issue_origin(origin: &Value) -> bool {
    matches!(
        origin["type"].as_str(),
        Some("board_task" | "board_comment" | "issue_dispatch" | "project_automation")
    ) && matches!(origin["dispatchRole"].as_str(), Some("manager" | "member"))
        && origin["initiatedBy"] != "stand_in"
        && origin["projectStore"] != "local"
        && origin["dispatchId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        && ["cloudProjectId", "loopItemId"]
            .into_iter()
            .all(|key| id_field(origin, key).is_some_and(|id| !id.is_empty()))
}

fn is_public_issue_origin(origin: &Value) -> bool {
    (origin["type"] == "issue_dispatch" && origin["initiatedBy"] == "stand_in")
        || is_cloud_collaboration_issue_origin(origin)
}

fn issue_reply_role<'a>(roles: &'a [Value], origin: &Value) -> Option<&'a Value> {
    roles.iter().find(|role| role["id"] == origin["standInId"])
}

impl RuntimeWorkRpcHandler {
    pub(super) fn set_public_issue_guidance_target(
        &self,
        task: &str,
        turn: &str,
        comment: &str,
        pending: bool,
    ) {
        self.store.update_task(task, |link| {
            let public_turn = &mut link.runtime_handle["standInPublicTurn"];
            if public_turn["turn"] != turn
                || !is_cloud_collaboration_issue_origin(&public_turn["origin"])
            {
                return;
            }
            if !public_turn["guidanceCommentIds"].is_array() {
                public_turn["guidanceCommentIds"] = json!([]);
            }
            let targets = public_turn["guidanceCommentIds"].as_array_mut().unwrap();
            if pending {
                if !targets.iter().any(|target| target == comment) {
                    targets.push(json!(comment));
                }
            } else {
                targets.retain(|target| target != comment);
            }
        });
    }

    pub(super) async fn read_stand_in_issue(
        &self,
        store: &LocalTaskStore,
        user: i64,
        origin: &Value,
    ) -> Result<Value, AppIpcError> {
        let project = origin["cloudProjectId"].as_str().unwrap_or_default();
        let issue_id = origin["loopItemId"].as_str().unwrap_or_default();
        if origin["projectStore"] == super::stand_in_personal_issues::INDEPENDENT {
            return self
                .current_personal_issue(
                    user,
                    issue_id,
                    origin["assignmentId"].as_str().unwrap_or_default(),
                )
                .await;
        }
        let issue = if origin["projectStore"] == "local" {
            serde_json::to_value(store.get_task(project, issue_id).map_err(settings_error)?)
                .unwrap()
        } else {
            let path = super::stand_in_issue_training::issue_path(&["v1", "loop-items", issue_id])?;
            let response = self.get_cloud_issue_as(user, &path).await?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Err(AppIpcError::new(
                    "not_found",
                    "Issue is no longer available",
                ));
            }
            Self::read_runtime_response(reqwest::Method::GET, &path, response).await?
        };
        if issue["cloud_project_id"] != project {
            return Err(AppIpcError::new(
                "permission_denied",
                "Issue does not belong to this project",
            ));
        }
        Ok(issue)
    }

    pub(super) async fn get_cloud_issue_as(
        &self,
        user: i64,
        path: &str,
    ) -> Result<reqwest::Response, AppIpcError> {
        let connection = self.require_runtime_connection()?;
        if Self::connected_runtime_user(&connection).await? != user {
            return Err(AppIpcError::new(
                "permission_denied",
                "Issue account changed",
            ));
        }
        let response =
            Self::runtime_request_on(&connection, reqwest::Method::GET, path, None).await?;
        let current = self.require_runtime_connection()?;
        if connection.authenticated_user_id != current.authenticated_user_id
            || connection.backend_url != current.backend_url
            || connection.auth_token != current.auth_token
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Issue connection changed",
            ));
        }
        Ok(response)
    }

    pub(super) async fn validate_stand_in_issue_request(
        &self,
        request: &ExecutionRequest,
    ) -> Result<(), String> {
        let Some(origin) = request
            .extra
            .get("origin")
            .filter(|origin| origin["publicConversation"] == true)
        else {
            return Ok(());
        };
        let task = origin["runtimeTaskId"]
            .as_str()
            .ok_or("Missing Issue conversation")?;
        let user = origin["userId"]
            .as_i64()
            .ok_or("Missing Issue conversation owner")?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(|error| error.to_string())?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(|error| error.to_string())?;
        let roles = crate::task_runtime::personal_stand_in::stand_in_identities(&settings);
        let link = self
            .local_task_link(task)
            .ok_or("Issue conversation is unavailable")?;
        if [
            "type",
            "initiatedBy",
            "userId",
            "standInId",
            "projectStore",
            "cloudProjectId",
            "loopItemId",
            "trigger",
            "humanAssignmentId",
            "triggerCommentId",
        ]
        .iter()
        .any(|key| link.runtime_handle["origin"][key] != origin[key])
        {
            return Err("Issue conversation owner does not match".into());
        }
        let role = issue_reply_role(&roles, origin).ok_or("Issue stand-in is unavailable")?;
        let issue = self
            .read_stand_in_issue(&store, user, origin)
            .await
            .map_err(|error| error.message)?;
        if origin["projectStore"] == super::stand_in_personal_issues::INDEPENDENT {
            let config = super::stand_in_personal_issues::personal_issue_role(role, user)
                .ok_or("Independent Issues are no longer connected to this assistant")?;
            if !settings["lifecycle"]["status"].is_null()
                || !self.stand_in_role_runs_here(&config)
                || !super::stand_in_personal_issues::personal_assignment_after_enable(
                    &issue, &config,
                )
            {
                return Err("Independent Issue execution permission is unavailable".into());
            }
        } else if origin["projectStore"] != "local" && issue["permissions"]["execute"] != true {
            return Err("Issue execution permission is unavailable".into());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn persist_public_issue_reply(&self, task: &str, message: &CodexNotification) {
        self.persist_public_issue_reply_for_request(task, message, None)
    }

    pub(super) fn persist_public_issue_reply_for_request(
        &self,
        task: &str,
        message: &CodexNotification,
        request: Option<&ExecutionRequest>,
    ) {
        let notification = codex_notification(message);
        if notification.method != "turn/started" && notification.method != "item/completed" {
            return;
        }
        if self.store.read_task(task, |link| {
            is_public_issue_origin(&link.runtime_handle["origin"])
                && !super::super::util::is_private_discussion(&runtime_event_request_from_link(
                    link,
                ))
                && crate::runtime_work::lifecycle::native_execution_state(link).map_or(
                    true,
                    |state| {
                        state.latest_turn_id == codex_notification_turn_id(message)
                            && state.process_generation == Some(message.process_generation())
                            && (notification.method != "turn/started"
                                || state.native_sequence == message.sequence())
                    },
                )
        }) != Some(true)
        {
            return;
        }
        if notification.method == "turn/started" {
            let trigger_comment_id = self
                .active_local_executions
                .lock()
                .expect("active local execution map lock should not be poisoned")
                .get(task)
                .and_then(|execution| execution.request.as_ref())
                .and_then(|request| request.extra.get("issue_comment_trigger_id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let result = self.store.try_update_task(task, |link| {
                if is_public_issue_origin(&link.runtime_handle["origin"])
                    && codex_notification_thread_id(message).as_deref() == link.thread_id.as_deref()
                {
                    link.runtime_handle["standInPublicTurn"] = json!({
                        "thread":codex_notification_thread_id(message),
                        "turn":codex_notification_turn_id(message),
                        "generation":message.process_generation(),
                        "origin":link.runtime_handle["origin"],
                        "triggerCommentId":trigger_comment_id
                    });
                    if trigger_comment_id.is_none()
                        && is_cloud_collaboration_issue_origin(&link.runtime_handle["origin"])
                    {
                        if let Some(turn) = codex_notification_turn_id(message) {
                            let public_turn = link.runtime_handle["standInPublicTurn"].clone();
                            queue_public_issue_reply(
                                link,
                                &turn,
                                "开始处理",
                                &public_turn,
                                Some("start"),
                                message,
                            );
                        }
                    }
                }
            });
            if let Err(error) = result {
                log_executor_event(
                    "Issue public turn persistence failed",
                    &[("error", error.to_string())],
                );
            } else {
                self.sync_public_issue_replies(task);
            }
            return;
        }
        let item = &notification.params["item"];
        if notification.method != "item/completed"
            || item["type"] != "agentMessage"
            || !matches!(
                item["phase"].as_str(),
                None | Some("commentary" | "final_answer")
            )
        {
            return;
        }
        let Some((item_id, text)) = item["id"].as_str().zip(item["text"].as_str()) else {
            return;
        };
        let Some((thread, turn)) =
            codex_notification_thread_id(message).zip(codex_notification_turn_id(message))
        else {
            return;
        };
        if text.trim().is_empty() {
            return;
        }
        let key = format!(
            "{:x}",
            Sha256::digest(json!([thread, turn, item_id]).to_string().as_bytes())
        );
        let result = self.store.try_update_task(task, |link| {
            let public_turn = &link.runtime_handle["standInPublicTurn"];
            let origin = &public_turn["origin"];
            if !is_public_issue_origin(origin)
                || !is_public_issue_origin(&link.runtime_handle["origin"])
                || link.thread_id.as_deref() != Some(&thread)
                || link.runtime_handle["lastTurnId"].as_str() != Some(&turn)
                || public_turn["thread"] != thread
                || public_turn["turn"] != turn
                || public_turn["generation"] != message.process_generation()
            {
                return;
            }
            let autonomous_collaboration = is_cloud_collaboration_issue_origin(origin)
                && public_turn["triggerCommentId"].is_null();
            if autonomous_collaboration && item["phase"] == "commentary" {
                return;
            }
            let mut public_turn = public_turn.clone();
            if item["phase"] == "final_answer" {
                if let Some(delivery) = request.and_then(|request| {
                    super::stand_in_issue_training::issue_delivery_at_completion(
                        link,
                        &public_turn,
                        request,
                    )
                }) {
                    public_turn["trainingDelivery"] = delivery;
                }
            }
            queue_public_issue_reply(
                link,
                &key,
                text,
                &public_turn,
                autonomous_collaboration.then_some("output"),
                message,
            );
        });
        if let Err(error) = result {
            log_executor_event(
                "Issue public reply persistence failed",
                &[("error", error.to_string())],
            );
            return;
        }
        self.sync_public_issue_replies(task);
    }

    pub(super) fn sync_public_issue_replies(&self, task: &str) {
        if self.store.read_task(task, |link| {
            link.runtime_handle["standInIssueReplies"]
                .as_object()
                .is_some_and(|reports| {
                    reports
                        .values()
                        .any(|report| report["sent"] != true && report["rejected"] != true)
                })
        }) != Some(true)
        {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let handler = self.clone();
        let task = task.to_owned();
        runtime.spawn(async move {
            let gate = handler.task_send_gate(&format!("stand-in-public-replies:{task}"));
            let Ok(_guard) = gate.try_lock() else {
                return;
            };
            loop {
                let Some(link) = handler.local_task_link(&task) else {
                    return;
                };
                let Some((key, report)) = link.runtime_handle["standInIssueReplies"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(_, report)| report["sent"] != true && report["rejected"] != true)
                    .min_by_key(|(_, report)| (
                        report["publicTurn"]["generation"].as_u64().unwrap_or(0),
                        report["sequence"].as_u64().unwrap_or(0),
                    ))
                    .map(|(key, report)| (key.clone(), report.clone()))
                else {
                    return;
                };
                match handler.publish_public_issue_reply(&task, &report).await {
                    Ok(()) => {
                        if let Err(error) = handler.store.try_update_task(&task, |link| {
                            link.runtime_handle["standInIssueReplies"][&key] = json!({"sent":true,"messageId":report["messageId"],"origin":report["origin"],"publicTurn":report["publicTurn"]});
                        }) {
                            log_executor_event(
                                "Issue public receipt persistence failed",
                                &[("error", error.to_string())],
                            );
                            return;
                        }
                    }
                    Err(error) => {
                        if matches!(
                            error.code.as_str(),
                            "permission_denied"
                                | "invalid_assignment"
                                | "source_removed"
                                | "public_reply_rejected"
                        ) {
                            if let Err(error) = handler.store.try_update_task(&task, |link| {
                                link.runtime_handle["standInIssueReplies"][&key] =
                                    json!({"rejected":true});
                            }) {
                                log_executor_event(
                                    "Issue public rejection persistence failed",
                                    &[("error", error.to_string())],
                                );
                                return;
                            }
                            continue;
                        }
                        log_executor_event(
                            "Issue public reply synchronization failed",
                            &[("task_id", task.clone()), ("code", error.code)],
                        );
                        return;
                    }
                }
            }
        });
    }

    async fn publish_public_issue_reply(
        &self,
        task: &str,
        report: &Value,
    ) -> Result<(), AppIpcError> {
        let origin = &report["origin"];
        if is_cloud_collaboration_issue_origin(origin) {
            let public_turn = &report["publicTurn"];
            let trigger = &public_turn["triggerCommentId"];
            let has_other_targets = public_turn["guidanceCommentIds"]
                .as_array()
                .is_some_and(|targets| targets.iter().any(|target| target != trigger));
            let source = json!({
                "device_id": self.cloud_device_id()?,
                "task_id": task,
                "dispatch_id": origin["dispatchId"],
                "message_id": report["messageId"],
                "turn_id": public_turn["turn"],
                "phase": report["phase"],
                "execution_trigger_comment_id": trigger,
                "trigger_comment_id": if has_other_targets { &Value::Null } else { trigger },
            });
            return self
                .send_cloud_issue_reply(
                    origin,
                    json!({
                        "body": report["body"],
                        "collaboration": source,
                    }),
                )
                .await
                .map(|_| ());
        }
        let user = origin["userId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("permission_denied", "Missing reply owner"))?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        let roles = crate::task_runtime::personal_stand_in::stand_in_identities(&settings);
        issue_reply_role(&roles, origin)
            .ok_or_else(|| AppIpcError::new("source_removed", "Stand-in is no longer available"))?;
        self.local_task_link(task)
            .ok_or_else(|| AppIpcError::new("source_removed", "Conversation no longer exists"))?;
        self.read_stand_in_issue(&store, user, origin).await?;
        if origin["projectStore"] == super::stand_in_personal_issues::INDEPENDENT {
            let id = origin["loopItemId"].as_str().unwrap_or_default();
            return self
                .send_issue_reply(
                    &format!("/v1/personal-issues/{id}/assistant-replies"),
                    json!({
                        "assignment": self.personal_issue_assignment_address(origin)?,
                        "message_id":report["messageId"],"body":report["body"],
                    }),
                )
                .await
                .map(|_| ());
        }
        if origin["projectStore"] == "local" {
            let comment = store
                .publish_stand_in_reply(
                    &self.device_id,
                    task,
                    user,
                    origin,
                    report["messageId"].as_str().unwrap_or_default(),
                    report["body"].as_str().unwrap_or_default(),
                )
                .map_err(|error| AppIpcError::new("public_reply_rejected", error.to_string()))?;
            self.record_issue_training_delivery(&store, user, report, Some(&comment.message_id));
            emit_runtime_work_changed(&self.event_tx, &self.device_id, task);
            return Ok(());
        }
        let native_id = self.send_cloud_issue_reply(origin, json!({
            "body":report["body"],"stand_in":{
                "device_id":self.cloud_device_id()?,"task_id":task,"role_id":origin["standInId"],
                "role_name":origin["roleName"].as_str().filter(|name| !name.trim().is_empty()).unwrap_or("Stand-in"),
                "message_id":report["messageId"],"human_assignment_id":if origin["trigger"] == "mention" {Value::Null} else {origin["humanAssignmentId"].clone()},
                "trigger_comment_id":origin["triggerCommentId"]
            }
        })).await?;
        self.record_issue_training_delivery(&store, user, report, native_id.as_deref());
        Ok(())
    }

    async fn send_cloud_issue_reply(
        &self,
        origin: &Value,
        body: Value,
    ) -> Result<Option<String>, AppIpcError> {
        let path = super::stand_in_issue_training::issue_path(&[
            "v1",
            "cloud-projects",
            origin["cloudProjectId"].as_str().unwrap_or_default(),
            "loop-items",
            origin["loopItemId"].as_str().unwrap_or_default(),
            "activity-comments",
        ])?;
        self.send_issue_reply(&path, body).await
    }

    async fn send_issue_reply(
        &self,
        path: &str,
        body: Value,
    ) -> Result<Option<String>, AppIpcError> {
        let response = self
            .runtime_request(reqwest::Method::POST, path, Some(&body))
            .await?;
        if !response.status().is_success() {
            let permanent = matches!(response.status().as_u16(), 400 | 403 | 404 | 409 | 422);
            return Err(AppIpcError::new(
                if permanent {
                    "public_reply_rejected"
                } else {
                    "cloud_request_failed"
                },
                format!("Public reply returned {}", response.status()),
            ));
        }
        // A successful remote publication must never be retried solely for analytics.
        Ok(response.json::<Value>().await.ok().and_then(|row| {
            row["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        }))
    }
}

fn queue_public_issue_reply(
    link: &mut RuntimeTaskLink,
    key: &str,
    body: &str,
    public_turn: &Value,
    phase: Option<&str>,
    message: &CodexNotification,
) {
    if !link.runtime_handle["standInIssueReplies"].is_object() {
        link.runtime_handle["standInIssueReplies"] = json!({});
    }
    let replies = link.runtime_handle["standInIssueReplies"]
        .as_object_mut()
        .expect("Issue replies are an object");
    replies.entry(key).or_insert_with(|| {
        json!({
            "origin": public_turn["origin"],
            "body": body,
            "messageId": key,
            "publicTurn": public_turn,
            "phase": phase,
            "sequence": message.sequence(),
        })
    });
}

#[cfg(test)]
#[path = "stand_in_issue_replies_tests.rs"]
mod tests;
