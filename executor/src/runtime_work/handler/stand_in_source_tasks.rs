//! Owner self-channel requests can start workers without acquiring personal control.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;
use sha2::{Digest, Sha256};

fn denied() -> AppIpcError {
    AppIpcError::new("permission_denied", "A verified owner self-conversation is required to start a personal task from a connected source")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(
        own: Option<bool>,
        self_chat: Option<bool>,
    ) -> (
        tempfile::TempDir,
        RuntimeWorkRpcHandler,
        StandInMcpIdentity,
        Value,
    ) {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.turn_queue_path = Arc::new(root.path().join("turns.json"));
        handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
        handler.turn_scheduler = Arc::new(Mutex::new(RuntimeTurnScheduler::new(
            RuntimeSettings {
                max_concurrent_tasks: 0,
                max_concurrent_stand_in_tasks: 0,
                max_concurrent_agent_tasks: 0,
            },
            VecDeque::new(),
        )));
        handler.command_journal = Arc::new(Mutex::new(Default::default()));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let source = json!({"providerId":"@third-party/messenger/messages","profile":"owner","kind":"direct","id":"self","name":"Same display name","policy":{"automatic":true,"immediate":true,"askBeforeAct":true}});
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"] =
            json!({"enabled":true,"prompt":"","preferences":"","connections":[source]});
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let mut message = json!({"id":"request","at":"2026-11-15T00:00:00Z","text":"Open a new task and fix the defect"});
        if let Some(value) = own {
            message["isOwn"] = json!(value);
        }
        if let Some(value) = self_chat {
            message["isSelfConversation"] = json!(value);
        }
        let work = store
            .ingest_stand_in_message(7, "@primary", &source, &message, None)
            .unwrap();
        let id = work["id"].as_str().unwrap();
        let origin = json!({"type":"connection_work","initiatedBy":"stand_in","userId":7,"deviceId":"mac","standInId":"@primary","workId":id,"askBeforeAct":true});
        handler.upsert_local_task(RuntimeTaskLink { local_task_id:id.into(), runtime:"codex".into(), thread_id:Some("source-thread".into()),
            runtime_handle:json!({"origin":origin,"executionRequest":{"user_id":7,"origin":origin}}), ..Default::default() });
        let identity = crate::task_runtime::mcp::stand_in_identity(
            &serde_json::from_value(json!({"task_id":id,"origin":origin})).unwrap(),
        )
        .unwrap();
        let message_id = store.stand_in_messages(7, id).unwrap()[0]["recordId"].clone();
        let args = json!({"messageId":message_id,"requestId":"fix-once","title":"Fix the defect","message":"Fix the defect and verify the result in this worker."});
        (root, handler, identity, args)
    }

    #[tokio::test]
    async fn source_task_rejects_other_people_own_messages_to_others_and_unknown_identity() {
        for (own, self_chat) in [
            (Some(false), Some(false)),
            (Some(true), Some(false)),
            (Some(false), Some(true)),
            (Some(true), None),
            (None, Some(true)),
            (None, None),
        ] {
            let (_root, handler, identity, args) = fixture(own, self_chat);
            assert_eq!(
                handler
                    .stand_in_task_operation(identity, "create_task", args)
                    .await
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
            assert_eq!(handler.local_task_links(true).len(), 1);
        }
    }

    #[test]
    fn source_task_starts_once_retains_review_and_delivers_to_its_source_without_personal_access() {
        let _lock = crate::test_env::lock();
        let (root, handler, identity, args) = fixture(Some(true), Some(true));
        let _workspace = super::super::tests::ScalarEnv::set(
            "WEGENT_STANDALONE_WORKSPACE_ROOT",
            root.path().to_str().unwrap(),
        );
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let result = handler
                    .stand_in_task_operation(identity.clone(), "create_task", args.clone())
                    .await
                    .unwrap();
                assert_eq!(result["accepted"], true);
                let id = result["taskId"].as_str().unwrap();
                assert_ne!(id, identity.task_id);
                let mut child = handler.local_task_link(id).unwrap();
                let mut request: ExecutionRequest =
                    serde_json::from_value(child.runtime_handle["executionRequest"].clone())
                        .unwrap();
                assert!(crate::runtime_work::stand_in_requires_confirmation(
                    &request
                ));
                assert!(crate::workbench_control::restricted_request(&request));
                // start_turn_worker binds the native local address immediately before launch.
                request.extra.insert("runtimeLocalTaskId".into(), json!(id));
                let worker = crate::task_runtime::mcp::stand_in_identity(&request).unwrap();
                assert_eq!(worker.task_id, id);
                assert_eq!(worker.role.as_deref(), Some("@primary"));
                assert_eq!(child.runtime_handle["origin"]["standInId"], "@primary");
                assert_eq!(
                    child.runtime_handle["executionRequest"]["standInDelegation"]["sourceTaskId"],
                    identity.task_id
                );
                assert_eq!(
                    child.runtime_handle["executionRequest"]["standInDelegation"]["readSources"],
                    json!([])
                );
                handler.source_task_parent(&child).unwrap();
                assert!(handler.delegated_read_sources(&worker).unwrap().is_empty());
                let page = handler
                    .read_stand_in_conversations(&worker, "list_tasks", &json!({}))
                    .await
                    .unwrap();
                assert_eq!(page["items"].as_array().unwrap().len(), 1);
                assert_eq!(page["items"][0]["taskId"], id);
                let page = handler
                    .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
                    .await
                    .unwrap();
                assert!(page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["taskId"] == id));
                assert_eq!(
                    handler
                        .stand_in_task_operation(identity.clone(), "create_task", args.clone())
                        .await
                        .unwrap()["alreadyExists"],
                    true
                );
                assert_eq!(handler.local_task_links(true).len(), 2);
                // A completed child returns to the exact source task and immutable request.
                handler.turn_scheduler.lock().unwrap().queued_turns.clear();
                child.status = "done".into();
                child.completed_at = Some(123);
                let delivery = handler.stand_in_result_delivery(&child).unwrap();
                assert_eq!(delivery["taskId"], identity.task_id);
                assert_eq!(delivery["automaticStandIn"], true);
                assert!(delivery["message"]
                    .as_str()
                    .unwrap()
                    .contains(args["messageId"].as_str().unwrap()));
                child.runtime_handle["standInResultReceipt"] = delivery["commandId"].clone();
                assert!(handler.stand_in_result_delivery(&child).is_none());
                handler.store.update_task(id, |link| {
                    link.thread_id = Some("worker-thread".into());
                    link.status = "done".into();
                });
                handler.upsert_local_task(RuntimeTaskLink {
                    local_task_id: "primary".into(), runtime: "codex".into(),
                    runtime_handle: json!({"origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac"},"executionRequest":{"user_id":7}}),
                    ..Default::default()
                });
                let primary = StandInMcpIdentity { task_id:"primary".into(), role:None, work:None, ..identity.clone() };
                let continued = handler.stand_in_task_operation(primary,"continue_task",json!({"taskId":id,"requestId":"followup","message":"Continue the same repair"})).await.unwrap();
                assert_eq!(continued["accepted"],true);
                let queue = handler.turn_scheduler.lock().unwrap();
                let continued = queue.queued_turns.iter().find(|turn| turn.local_task_id == id).unwrap();
                assert_eq!(continued.request.extra["standInDelegation"]["sourceTaskId"],identity.task_id);
                assert_eq!(continued.request.extra["standInDelegation"]["sourceMessageId"],args["messageId"]);
                drop(queue);
                let mut invalid = args.clone();
                invalid["readSources"] = json!([]);
                assert!(handler
                    .stand_in_task_operation(identity.clone(), "create_task", invalid)
                    .await
                    .is_err());
                let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
                let mut settings = store.personal_stand_in(7, "mac").unwrap();
                settings["primary"]["connections"] = json!([]);
                store.save_personal_stand_in(7, "mac", settings).unwrap();
                assert!(handler.source_task_parent(&child).is_err());
                assert!(handler
                    .stand_in_task_operation(identity, "create_task", args)
                    .await
                    .is_err());
            });
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn source_task_context(
        &self,
        identity: &StandInMcpIdentity,
        message: &str,
    ) -> Result<(Value, Value), AppIpcError> {
        let source = self.authorize_work_source_read(identity, &Value::Null)?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let messages = store
            .stand_in_messages(identity.user, identity.work.as_deref().ok_or_else(denied)?)
            .map_err(super::stand_in::settings_error)?;
        let record = messages
            .iter()
            .find(|record| record["recordId"] == message)
            .ok_or_else(denied)?;
        // Provider-derived identity is evidence of the participant, never an operation grant.
        // Own messages sent to colleagues or groups are not owner self-conversations.
        if record["isSelfConversation"] != true
            || record["isOwn"] != true
            || !super::stand_in_read_sources::same_source(&record["source"], &source)
        {
            return Err(denied());
        }
        let settings = store
            .personal_stand_in(identity.user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let roles = crate::task_runtime::personal_stand_in::stand_in_identities(&settings);
        let mut config = roles
            .into_iter()
            .find(|role| role["id"].as_str() == identity.role.as_deref())
            .ok_or_else(denied)?;
        if !identity.ask_before_act
            && (config["enabled"] != true || source["policy"]["automatic"] != true)
        {
            return Err(denied());
        }
        let actor = self.local_task_link(&identity.task_id).ok_or_else(denied)?;
        let ask = identity.ask_before_act
            || source["policy"]["askBeforeAct"] == true
            || actor.runtime_handle["origin"]["askBeforeAct"] == true;
        config["userId"] = json!(identity.user);
        config["handlingPolicy"] = json!({"automatic":true,"askBeforeAct":ask});
        Ok((config, record.clone()))
    }

    pub(super) async fn create_source_task(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        if !args.as_object().is_some_and(|fields| {
            fields.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "requestId" | "messageId" | "title" | "message"
                )
            })
        }) {
            return Err(denied());
        }
        let message = super::stand_in_tasks::required(args, "messageId")?;
        let (config, _) = self.source_task_context(identity, message)?;
        let key = json!([
            identity.user,
            identity.task_id,
            message,
            super::stand_in_tasks::required(args, "requestId")?
        ]);
        let id = format!(
            "stand-in-task-{:x}",
            Sha256::digest(key.to_string().as_bytes())
        );
        let gate = self.task_send_gate(&format!("stand-in-task-operation:{id}"));
        let _guard = gate.lock().await;
        if let Some(link) = self.local_task_link(&id) {
            if self.source_task_parent(&link).is_ok() {
                return Ok(json!({"success":true,"taskId":id,"alreadyExists":true}));
            }
            return Err(denied());
        }
        let delegation = json!({"userId":identity.user,"sourceTaskId":identity.task_id,
            "sourceMessageId":message,"askBeforeAct":config["handlingPolicy"]["askBeforeAct"],"readSources":[]});
        self.start_delegated_task(identity, args, &id, &config, delegation)
            .await
    }

    pub(super) fn source_task_parent(
        &self,
        child: &RuntimeTaskLink,
    ) -> Result<StandInMcpIdentity, AppIpcError> {
        let saved = &child.runtime_handle["executionRequest"];
        let delegation = &saved["standInDelegation"];
        let origin = &child.runtime_handle["origin"];
        let user = saved["user_id"].as_i64().ok_or_else(denied)?;
        if child.ephemeral
            || origin["type"] != "stand_in_task"
            || origin["initiatedBy"] != "stand_in"
            || origin["userId"] != user
            || origin["deviceId"] != self.device_id
            || origin["standInId"] != "@primary"
            || delegation["userId"] != user
            || delegation["sourceTaskId"] != origin["sourceTaskId"]
            || delegation["readSources"] != json!([])
        {
            return Err(denied());
        }
        let parent = self
            .local_task_link(origin["sourceTaskId"].as_str().ok_or_else(denied)?)
            .ok_or_else(denied)?;
        let mut request = ExecutionRequest {
            task_id: parent.local_task_id.clone(),
            ..Default::default()
        };
        request
            .extra
            .insert("origin".into(), parent.runtime_handle["origin"].clone());
        let identity = crate::task_runtime::mcp::stand_in_identity(&request).ok_or_else(denied)?;
        if identity.user != user {
            return Err(denied());
        }
        self.source_task_context(
            &identity,
            delegation["sourceMessageId"].as_str().ok_or_else(denied)?,
        )?;
        Ok(identity)
    }
}
