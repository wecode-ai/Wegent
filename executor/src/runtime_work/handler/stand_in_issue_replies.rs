//! Only completed public messages from the owning Issue conversation become comments.
use super::stand_in::settings_error;
use super::*;
use sha2::{Digest, Sha256};

fn issue_reply_role<'a>(roles: &'a [Value], origin: &Value) -> Option<&'a Value> {
    roles.iter().find(|role| role["id"] == origin["standInId"])
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn read_stand_in_issue(
        &self,
        store: &LocalTaskStore,
        user: i64,
        origin: &Value,
    ) -> Result<Value, AppIpcError> {
        let project = origin["cloudProjectId"].as_str().unwrap_or_default();
        let issue_id = origin["loopItemId"].as_str().unwrap_or_default();
        let issue = if origin["projectStore"] == "local" {
            serde_json::to_value(store.get_task(project, issue_id).map_err(settings_error)?)
                .unwrap()
        } else {
            self.verify_runtime_user(&json!({"userId":user})).await?;
            self.runtime_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}"),
                None,
            )
            .await?
        };
        if issue["cloud_project_id"] != project {
            return Err(AppIpcError::new(
                "permission_denied",
                "Issue does not belong to this project",
            ));
        }
        Ok(issue)
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
        issue_reply_role(&roles, origin).ok_or("Issue stand-in is unavailable")?;
        let issue = self
            .read_stand_in_issue(&store, user, origin)
            .await
            .map_err(|error| error.message)?;
        if origin["projectStore"] != "local" && issue["permissions"]["execute"] != true {
            return Err("Issue execution permission is unavailable".into());
        }
        Ok(())
    }

    pub(super) fn persist_stand_in_issue_reply(&self, task: &str, message: &CodexNotification) {
        let notification = codex_notification(message);
        if notification.method != "turn/started" && notification.method != "item/completed" {
            return;
        }
        if self.store.read_task(task, |link| {
            link.runtime_handle["origin"]["type"] == "issue_dispatch"
                && link.runtime_handle["origin"]["initiatedBy"] == "stand_in"
        }) != Some(true)
        {
            return;
        }
        if notification.method == "turn/started" {
            let result = self.store.try_update_task(task, |link| {
                if link.runtime_handle["origin"]["type"] == "issue_dispatch"
                    && link.runtime_handle["origin"]["initiatedBy"] == "stand_in"
                    && codex_notification_thread_id(message).as_deref() == link.thread_id.as_deref()
                {
                    link.runtime_handle["standInPublicTurn"] = json!({
                        "thread":codex_notification_thread_id(message),
                        "turn":codex_notification_turn_id(message),
                        "generation":message.process_generation(),
                        "origin":link.runtime_handle["origin"]
                    });
                }
            });
            if let Err(error) = result {
                log_executor_event(
                    "Stand-in public turn persistence failed",
                    &[("error", error.to_string())],
                );
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
            if origin["type"] != "issue_dispatch"
                || origin["initiatedBy"] != "stand_in"
                || link.runtime_handle["origin"]["type"] != "issue_dispatch"
                || link.thread_id.as_deref() != Some(&thread)
                || link.runtime_handle["lastTurnId"].as_str() != Some(&turn)
                || public_turn["thread"] != thread
                || public_turn["turn"] != turn
                || public_turn["generation"] != message.process_generation()
            {
                return;
            }
            let report = json!({"origin":origin,"body":text,"messageId":key});
            if !link.runtime_handle["standInIssueReplies"].is_object() {
                link.runtime_handle["standInIssueReplies"] = json!({});
            }
            if link.runtime_handle["standInIssueReplies"]
                .get(&key)
                .is_none()
            {
                link.runtime_handle["standInIssueReplies"][&key] = report;
            }
        });
        if let Err(error) = result {
            log_executor_event(
                "Stand-in public reply persistence failed",
                &[("error", error.to_string())],
            );
            return;
        }
        self.sync_stand_in_issue_replies(task);
    }

    pub(super) fn sync_stand_in_issue_replies(&self, task: &str) {
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
                    .find(|(_, report)| report["sent"] != true && report["rejected"] != true)
                    .map(|(key, report)| (key.clone(), report.clone()))
                else {
                    return;
                };
                match handler.publish_stand_in_issue_reply(&task, &report).await {
                    Ok(()) => {
                        if let Err(error) = handler.store.try_update_task(&task, |link| {
                            link.runtime_handle["standInIssueReplies"][&key] = json!({"sent":true});
                        }) {
                            log_executor_event(
                                "Stand-in public receipt persistence failed",
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
                                    "Stand-in public rejection persistence failed",
                                    &[("error", error.to_string())],
                                );
                                return;
                            }
                            continue;
                        }
                        log_executor_event(
                            "Stand-in public reply synchronization failed",
                            &[("task_id", task.clone()), ("code", error.code)],
                        );
                        return;
                    }
                }
            }
        });
    }

    async fn publish_stand_in_issue_reply(
        &self,
        task: &str,
        report: &Value,
    ) -> Result<(), AppIpcError> {
        let origin = &report["origin"];
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
        if origin["projectStore"] == "local" {
            store
                .publish_stand_in_reply(
                    &self.device_id,
                    task,
                    user,
                    origin,
                    report["messageId"].as_str().unwrap_or_default(),
                    report["body"].as_str().unwrap_or_default(),
                )
                .map_err(|error| AppIpcError::new("public_reply_rejected", error.to_string()))?;
            emit_runtime_work_changed(&self.event_tx, &self.device_id, task);
            return Ok(());
        }
        let response = self.runtime_request(reqwest::Method::POST, &format!("/v1/cloud-projects/{}/loop-items/{}/activity-comments", origin["cloudProjectId"].as_str().unwrap_or_default(), origin["loopItemId"].as_str().unwrap_or_default()), Some(&json!({
            "body":report["body"],"stand_in":{
                "device_id":self.cloud_device_id()?,"task_id":task,"role_id":origin["standInId"],
                "role_name":origin["roleName"].as_str().filter(|name| !name.trim().is_empty()).unwrap_or("Stand-in"),
                "message_id":report["messageId"],"human_assignment_id":if origin["trigger"] == "mention" {Value::Null} else {origin["humanAssignmentId"].clone()},
                "trigger_comment_id":origin["triggerCommentId"]
            }
        }))).await?;
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
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn issue_conversations_do_not_depend_on_intake_or_current_assignment() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, origin, mut settings) = paused_issue_fixture(root.path());
        let mut request = ExecutionRequest::default();
        request.extra.insert("origin".into(), origin.clone());
        handler
            .validate_stand_in_issue_request(&request)
            .await
            .unwrap();
        let roles = crate::task_runtime::personal_stand_in::stand_in_identities(&settings);
        assert!(issue_reply_role(&roles, &origin).is_some());
        for field in ["trigger", "humanAssignmentId", "triggerCommentId"] {
            let mut forged = origin.clone();
            forged[field] = json!("forged");
            request.extra.insert("origin".into(), forged);
            assert_eq!(
                handler
                    .validate_stand_in_issue_request(&request)
                    .await
                    .unwrap_err(),
                "Issue conversation owner does not match"
            );
        }
        let mut automatic = origin.clone();
        automatic["trigger"] = json!("assignment");
        handler.store.update_task("issue-chat", |link| {
            link.runtime_handle["origin"] = automatic.clone()
        });
        request.extra.insert("origin".into(), automatic.clone());
        assert!(issue_reply_role(&roles, &automatic).is_some());
        handler
            .validate_stand_in_issue_request(&request)
            .await
            .unwrap();
        assert!(issue_reply_role(&[], &origin).is_none());
        handler.store.update_task("issue-chat", |link| {
            link.runtime_handle["origin"] = origin.clone()
        });
        request.extra.insert("origin".into(), origin);
        settings["roles"][0]["collaboration"]["enabled"] = json!(false);
        store
            .save_personal_stand_in(7, "mac", settings.clone())
            .unwrap();
        handler
            .validate_stand_in_issue_request(&request)
            .await
            .unwrap();
        let link = handler.local_task_link("issue-chat").unwrap();
        assert_eq!(
            handler
                .validate_followup_role(&store, 7, &settings["roles"][0], &link)
                .await
                .unwrap_err()
                .message,
            "Work project is no longer connected"
        );
        let project = link.runtime_handle["origin"]["cloudProjectId"]
            .as_str()
            .unwrap();
        let issue_id = link.runtime_handle["origin"]["loopItemId"]
            .as_str()
            .unwrap();
        let issue = store.get_task(project, issue_id).unwrap();
        store
            .update_task(
                project,
                issue_id,
                serde_json::from_value(json!({"version":issue.version,"assignee_user_id":8}))
                    .unwrap(),
            )
            .unwrap();
        handler
            .validate_stand_in_issue_request(&request)
            .await
            .unwrap();
        let issue = store.get_task(project, issue_id).unwrap();
        store
            .update_task(
                project,
                issue_id,
                serde_json::from_value(json!({"version":issue.version,"assignee_user_id":null}))
                    .unwrap(),
            )
            .unwrap();
        handler
            .validate_stand_in_issue_request(&request)
            .await
            .unwrap();
    }

    fn paused_issue_fixture(root: &Path) -> (RuntimeWorkRpcHandler, LocalTaskStore, Value, Value) {
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Manual Issue"})).unwrap())
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Review","assignee_user_id":7})).unwrap(),
            )
            .unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"][0]["enabled"] = json!(false);
        settings["roles"][0]["collaboration"] = json!({"enabled":true,"allProjects":false,"projects":[{"id":project.id,"store":"local"}],"excludedProjects":[],"tags":[],"policy":{"automatic":false,"askBeforeAct":false}});
        let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","trigger":"manual","publicConversation":true,"runtimeTaskId":"issue-chat","userId":7,"standInId":"default","projectStore":"local","cloudProjectId":project.id,"loopItemId":issue.id,"humanAssignmentId":format!("{}-{}",issue.id,issue.metadata["assignment_history"].as_array().unwrap().len())});
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "issue-chat".into(),
            runtime_handle: json!({"origin":origin}),
            ..Default::default()
        });
        (handler, store, origin, settings)
    }

    #[tokio::test]
    async fn queued_stand_in_turns_recheck_current_issue_execution_permission() {
        use axum::{routing::get, Json, Router};

        let root = tempfile::tempdir().unwrap();
        let (mut handler, _, mut origin, _) = paused_issue_fixture(root.path());
        origin["projectStore"] = json!("cloud");
        handler.store.update_task("issue-chat", |link| {
            link.runtime_handle["origin"] = origin.clone()
        });
        let mut request = ExecutionRequest::default();
        request.extra.insert("origin".into(), origin.clone());
        let issue = Arc::new(Mutex::new(json!({
            "cloud_project_id":origin["cloudProjectId"],"permissions":{"execute":true}
        })));
        let current = issue.clone();
        let router = Router::new()
            .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
            .route(
                &format!(
                    "/api/v1/loop-items/{}",
                    origin["loopItemId"].as_str().unwrap()
                ),
                get(move || {
                    let value = current.lock().unwrap().clone();
                    async move { Json(value) }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: format!("http://{}", listener.local_addr().unwrap()),
            auth_token: "test".into(),
            ..Default::default()
        })));
        let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
        handler
            .validate_project_coordinator_request(&request)
            .await
            .unwrap();
        for permission in [json!(false), Value::Null] {
            issue.lock().unwrap()["permissions"]["execute"] = permission;
            assert_eq!(
                handler
                    .validate_project_coordinator_request(&request)
                    .await
                    .unwrap_err(),
                "Issue execution permission is unavailable"
            );
        }
        issue.lock().unwrap()["permissions"]["execute"] = json!(true);
        handler
            .validate_project_coordinator_request(&request)
            .await
            .unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn a_public_issue_request_cannot_change_its_trusted_origin_kind() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"][0]["enabled"] = json!(true);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","publicConversation":true,"runtimeTaskId":"issue-chat","userId":7,"standInId":"default","projectStore":"cloud","cloudProjectId":"project","loopItemId":"one"});
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "issue-chat".into(),
            runtime_handle: json!({"origin":origin}),
            ..Default::default()
        });
        for key in ["type", "initiatedBy"] {
            let mut request = ExecutionRequest::default();
            let mut untrusted = origin.clone();
            untrusted[key] = json!("different-kind");
            request.extra.insert("origin".into(), untrusted);
            assert_eq!(
                handler
                    .validate_stand_in_issue_request(&request)
                    .await
                    .unwrap_err(),
                "Issue conversation owner does not match"
            );
        }
    }

    #[test]
    fn a_failed_outbox_write_never_exposes_an_uncommitted_reply() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("state/runtime.json");
        fs::create_dir_all(&path).unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(path.clone());
        let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in"});
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "issue-chat".into(),
            thread_id: Some("parent".into()),
            runtime_handle: json!({"lastTurnId":"turn","origin":origin,"standInPublicTurn":{"thread":"parent","turn":"turn","generation":0,"origin":origin}}),
            ..Default::default()
        });
        // The conflicting index directory forces a real atomic replacement failure.
        handler.persist_stand_in_issue_reply("issue-chat", &json!({"method":"item/completed","params":{"threadId":"parent","turnId":"turn","item":{"id":"reply","type":"agentMessage","phase":"commentary","text":"Received"}}}).into());
        assert!(handler
            .local_task_link("issue-chat")
            .unwrap()
            .runtime_handle["standInIssueReplies"]
            .is_null());
    }

    #[test]
    fn public_issue_replies_are_distinct_durable_messages_not_turn_aggregates() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        let path = root.path().join("runtime.json");
        handler.store = RuntimeWorkStore::new(path.clone());
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id:"issue-chat".into(), thread_id:Some("parent".into()),
            runtime_handle:json!({"lastTurnId":"turn", "origin":{"type":"issue_dispatch","initiatedBy":"stand_in","userId":7,"standInId":"review","loopItemId":"one","humanAssignmentId":"first"}}),
            ..Default::default()
        });
        handler.persist_stand_in_issue_reply(
            "issue-chat",
            &json!({"method":"turn/started","params":{"threadId":"parent","turnId":"turn"}}).into(),
        );
        let notification = |id: &str, thread: &str, kind: &str, phase: &str| {
            CodexNotification::from(json!({
                "method":"item/completed","params":{"threadId":thread,"turnId":"turn","item":{"id":id,"type":kind,"phase":phase,"text":id}}
            }))
        };
        for id in ["Received", "Result", "Result"] {
            handler.persist_stand_in_issue_reply(
                "issue-chat",
                &notification(id, "parent", "agentMessage", "commentary"),
            );
        }
        for (id, thread, kind, phase) in [
            ("Child raw result", "child", "agentMessage", "final_answer"),
            ("Tool log", "parent", "commandExecution", "commentary"),
            ("Reasoning", "parent", "agentMessage", "analysis"),
        ] {
            handler
                .persist_stand_in_issue_reply("issue-chat", &notification(id, thread, kind, phase));
        }
        // A reassignment cannot relabel an old turn's late output with its new grant.
        handler.store.update_task("issue-chat", |link| {
            link.runtime_handle["origin"]["humanAssignmentId"] = json!("second")
        });
        handler.persist_stand_in_issue_reply(
            "issue-chat",
            &notification("Late", "parent", "agentMessage", "final_answer"),
        );
        let reopened = RuntimeWorkStore::new(path);
        let link = reopened.get_task("issue-chat").unwrap();
        let reports = link.runtime_handle["standInIssueReplies"]
            .as_object()
            .unwrap();
        assert_eq!(reports.len(), 3);
        assert_eq!(
            reports
                .values()
                .map(|report| report["body"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["Received", "Result", "Late"]
        );
        assert!(reports
            .values()
            .all(|report| report["origin"]["humanAssignmentId"] == "first"));
        handler.store.update_task("issue-chat", |link| {
            link.runtime_handle["origin"]["type"] = json!("stand_in_identity")
        });
        handler.persist_stand_in_issue_reply(
            "issue-chat",
            &json!({"method":"turn/started","params":{"threadId":"parent","turnId":"turn"}}).into(),
        );
        handler.persist_stand_in_issue_reply(
            "issue-chat",
            &notification("Private", "parent", "agentMessage", "final_answer"),
        );
        assert_eq!(
            handler
                .local_task_link("issue-chat")
                .unwrap()
                .runtime_handle["standInIssueReplies"]
                .as_object()
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn issue_conversations_reuse_history_but_reassignment_is_a_new_wakeup() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        let config = json!({"id":"review","userId":7,"projectId":"project","projectStore":"cloud"});
        let issue = json!({"id":"one"});
        let id = handler.stand_in_task_id(&config, &issue);
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id:id.clone(), status:"done".into(),
            runtime_handle:json!({"origin":{"type":"issue_dispatch","initiatedBy":"stand_in","standInId":"review","userId":7,"cloudProjectId":"project","projectStore":"cloud","loopItemId":"one","humanAssignmentId":"first"},"standInIssueWakeups":["first"]}),
            ..Default::default()
        });
        assert_eq!(handler.stand_in_task_id(&config, &issue), id);
        assert!(handler.stand_in_assignment_is_handled(
            &config,
            &id,
            &json!({"humanAssignmentId":"first"})
        ));
        assert!(!handler.stand_in_assignment_is_handled(
            &config,
            &id,
            &json!({"humanAssignmentId":"second"})
        ));
        assert_ne!(handler.stand_in_task_id(&config, &json!({"id":"two"})), id);
        for field in ["id", "userId", "projectId", "projectStore"] {
            let mut other = config.clone();
            other[field] = json!("other");
            assert_ne!(handler.stand_in_task_id(&other, &issue), id, "{field}");
        }
    }

    #[test]
    fn a_reserved_legacy_conversation_survives_restart_before_native_task_creation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime.json");
        let store = RuntimeWorkStore::new(path.clone());
        let config = json!({"id":"review","userId":7,"projectId":"project","projectStore":"cloud"});
        let issue = json!({"id":"one"});
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = store.clone();
        let identity = handler.stand_in_task_id(&config, &issue);
        store
            .bind_issue_conversation(&identity, "stand-in-old-assignment-review")
            .unwrap();
        assert!(store
            .bind_issue_conversation(&identity, "different-reservation")
            .is_err());
        handler.store = RuntimeWorkStore::new(path);
        assert_eq!(
            handler.stand_in_task_id(&config, &issue),
            "stand-in-old-assignment-review"
        );
        assert!(handler
            .local_task_link("stand-in-old-assignment-review")
            .is_none());
    }

    #[test]
    fn mentions_and_assignments_respect_the_same_device_reservation_without_a_current_grant() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        let config = json!({"id":"review","userId":7,"projectId":"project","projectStore":"cloud"});
        let issue = json!({"id":"one"});
        let canonical = handler.stand_in_task_id(&config, &issue);
        for (task, grant) in [
            (canonical.as_str(), Value::Null),
            ("stand-in-old-grant-review", json!("old-grant")),
        ] {
            let rows = json!([{"task_id":task,"task_user_id":7,"device_id":"other-device","human_assignment_id":grant}]);
            assert!(!handler
                .use_stand_in_issue_reservation(&config, &issue, &rows)
                .unwrap());
        }
        let rows = json!([{"task_id":"stand-in-old-grant-review","task_user_id":7,"device_id":"mac","human_assignment_id":"old-grant"}]);
        assert!(handler
            .use_stand_in_issue_reservation(&config, &issue, &rows)
            .unwrap());
        assert_eq!(
            handler.stand_in_task_id(&config, &issue),
            "stand-in-old-grant-review"
        );
        let established = json!([
            {"task_id":"stand-in-old-grant-review","task_user_id":7,"device_id":"mac","human_assignment_id":"old-grant"},
            {"task_id":"another-legacy-thread","task_user_id":7,"device_id":"other-device","stand_in_conversation_id":canonical}
        ]);
        assert!(
            !handler
                .use_stand_in_issue_reservation(&config, &issue, &established)
                .unwrap(),
            "An established reservation takes precedence over an older local alias"
        );
    }
}
