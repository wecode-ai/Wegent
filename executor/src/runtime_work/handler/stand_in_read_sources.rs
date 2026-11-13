//! Delegates receive only explicitly selected, host-captured read references.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;

const KEYS: [&str; 4] = ["providerId", "profile", "kind", "id"];

fn denied() -> AppIpcError {
    AppIpcError::new(
        "permission_denied",
        "Delegated source reading is no longer authorized",
    )
}

fn source_ref(source: &Value) -> Result<Value, AppIpcError> {
    if source.get("scope").is_some()
        || KEYS.iter().any(|key| {
            !source[*key]
                .as_str()
                .is_some_and(|value| !value.is_empty() && value != "*")
        })
    {
        return Err(denied());
    }
    Ok(
        json!({"providerId":source["providerId"],"profile":source["profile"],"kind":source["kind"],"id":source["id"]}),
    )
}

pub(super) fn same_source(left: &Value, right: &Value) -> bool {
    KEYS.iter().all(|key| left[*key] == right[*key])
}

fn selection(value: Option<&Value>) -> Result<Vec<Value>, AppIpcError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= 50)
        .ok_or_else(denied)?;
    let mut refs = Vec::new();
    for source in rows {
        let source = source_ref(source)?;
        if refs.iter().any(|saved| same_source(saved, &source)) {
            return Err(denied());
        }
        refs.push(source);
    }
    Ok(refs)
}

impl RuntimeWorkRpcHandler {
    fn primary_read_sources(&self, user: i64, parent: &str) -> Result<Vec<Value>, AppIpcError> {
        let actor = self.local_task_link(parent).ok_or_else(denied)?;
        let origin = &actor.runtime_handle["origin"];
        if super::stand_in_conversations::scoped_conversation_task_id(
            user,
            None,
            &origin["conversationScope"],
        )
        .ok()
        .as_deref()
            != Some(parent)
            || actor.ephemeral
            || actor.status == "archived"
            || self.archived_link_is_deleted(&actor)
            || origin["type"] != "stand_in_identity"
            || origin["userId"] != user
            || origin["deviceId"] != self.device_id
            || !(origin["standInId"].is_null() || origin["standInId"] == "@primary")
            || actor.runtime_handle["executionRequest"]["user_id"] != user
        {
            return Err(denied());
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        Ok(settings["primary"]["connections"]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    pub(super) fn capture_delegated_read_sources(
        &self,
        parent: &StandInMcpIdentity,
        args: &Value,
    ) -> Result<Vec<Value>, AppIpcError> {
        let selected = selection(args.get("readSources"))?;
        if selected.is_empty() {
            return Ok(selected);
        }
        if parent.device != self.device_id
            || parent.work.is_some()
            || parent.project.is_some()
            || parent.coordinator_batch.is_some()
            || parent.readonly_worker
            || parent.review
            || !matches!(parent.role.as_deref(), None | Some("@primary"))
        {
            return Err(denied());
        }
        let current = self.primary_read_sources(parent.user, &parent.task_id)?;
        for selected in &selected {
            let source = current
                .iter()
                .find(|source| same_source(source, selected))
                .ok_or_else(denied)?;
            source_ref(source)?;
        }
        Ok(selected)
    }

    pub(super) fn delegated_read_sources(
        &self,
        child: &StandInMcpIdentity,
    ) -> Result<Vec<Value>, AppIpcError> {
        if !child.readonly_worker
            || child.device != self.device_id
            || child.work.is_some()
            || child.project.is_some()
            || child.coordinator_batch.is_some()
            || child.review
            || !matches!(child.role.as_deref(), None | Some("@primary"))
        {
            return Err(denied());
        }
        let actor = self.local_task_link(&child.task_id).ok_or_else(denied)?;
        let origin = &actor.runtime_handle["origin"];
        let saved = &actor.runtime_handle["executionRequest"];
        let delegation = &saved["standInDelegation"];
        if actor.ephemeral
            || actor.status == "archived"
            || self.archived_link_is_deleted(&actor)
            || origin["type"] != "stand_in_task"
            || origin["initiatedBy"] != "stand_in"
            || origin["userId"] != child.user
            || origin["deviceId"] != self.device_id
            || origin["standInId"] != "@primary"
            || saved["user_id"] != child.user
            || delegation["userId"] != child.user
            || delegation["sourceTaskId"] != origin["sourceTaskId"]
        {
            return Err(denied());
        }
        let parent = origin["sourceTaskId"].as_str().ok_or_else(denied)?;
        let current = self.primary_read_sources(child.user, parent)?;
        let selected = selection(delegation.get("readSources"))?;
        selected
            .iter()
            .map(|reference| {
                let source = current
                    .iter()
                    .find(|source| same_source(source, reference))
                    .ok_or_else(denied)?;
                source_ref(source)?;
                Ok(source.clone())
            })
            .collect()
    }

    pub(super) fn validate_continued_read_sources(
        &self,
        parent: &StandInMcpIdentity,
        link: &RuntimeTaskLink,
        args: &Value,
    ) -> Result<(), AppIpcError> {
        let saved = &link.runtime_handle["executionRequest"]["standInDelegation"];
        let existing = selection(saved.get("readSources"))?;
        if let Some(requested) = args.get("readSources") {
            let requested = selection(Some(requested))?;
            if requested.len() != existing.len()
                || requested
                    .iter()
                    .any(|source| !existing.iter().any(|saved| same_source(source, saved)))
            {
                return Err(AppIpcError::new(
                    "delegated_read_scope_immutable",
                    "Create a new delegated task to select a different read source scope",
                ));
            }
        }
        if existing.is_empty() {
            return Ok(());
        }
        if parent.coordinator_batch.is_some()
            || parent.task_id != saved["sourceTaskId"]
            || saved["userId"] != parent.user
        {
            return Err(denied());
        }
        let child = StandInMcpIdentity {
            task_id: link.local_task_id.clone(),
            user: parent.user,
            device: self.device_id.clone(),
            role: Some("@primary".into()),
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: false,
            readonly_worker: true,
        };
        self.delegated_read_sources(&child).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collaboration_delegates_keep_the_same_exact_source_grants() {
        let (_root, handler, mut parent, source) = fixture();
        let mut actor = handler.local_task_link(&parent.task_id).unwrap();
        parent.task_id.push_str("-collaboration");
        actor.local_task_id = parent.task_id.clone();
        actor.runtime_handle["origin"]["conversationScope"] = json!("collaboration");
        handler.upsert_local_task(actor.clone());
        let args = json!({"readSources":[source_ref(&source).unwrap()]});
        assert_eq!(
            handler
                .capture_delegated_read_sources(&parent, &args)
                .unwrap()
                .len(),
            1
        );
        for (field, value) in [
            ("userId", json!(8)),
            ("deviceId", json!("foreign")),
            ("conversationScope", Value::Null),
            ("conversationScope", json!("unknown")),
        ] {
            handler.store.update_task(&parent.task_id, |row| {
                row.runtime_handle["origin"][field] = value
            });
            assert!(
                handler
                    .capture_delegated_read_sources(&parent, &args)
                    .is_err(),
                "{field}"
            );
            handler.upsert_local_task(actor.clone());
        }
    }

    fn fixture() -> (
        tempfile::TempDir,
        RuntimeWorkRpcHandler,
        StandInMcpIdentity,
        Value,
    ) {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.turn_queue_path = Arc::new(root.path().join("turn-queue.json"));
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
        let source = json!({"providerId":"@third-party/builds/repos","profile":"account","kind":"repository","id":"selected","name":"Selected","policy":{"automatic":false,"askBeforeAct":true}});
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"] =
            json!({"enabled":true,"prompt":"","preferences":"","connections":[source]});
        let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let source = settings["primary"]["connections"][0].clone();
        let parent = "stand-in-chat-7-primary";
        handler.upsert_local_task(RuntimeTaskLink {local_task_id:parent.into(),runtime:"codex".into(),
            runtime_handle:json!({"origin":{"type":"stand_in_identity","userId":7,"deviceId":"mac"},"executionRequest":{"user_id":7}}),..Default::default()});
        let identity = StandInMcpIdentity {
            task_id: parent.into(),
            user: 7,
            device: "mac".into(),
            role: None,
            work: None,
            ask_before_act: false,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: false,
            readonly_worker: false,
        };
        (root, handler, identity, source)
    }

    async fn create(
        handler: &RuntimeWorkRpcHandler,
        parent: &StandInMcpIdentity,
        source: &Value,
    ) -> StandInMcpIdentity {
        let result=handler.stand_in_task_operation(parent.clone(),"create_task",json!({"requestId":"read-selected","title":"Read selected evidence","message":"Read only selected evidence","readSources":[source_ref(source).unwrap()]})).await.unwrap();
        let id = result["taskId"].as_str().unwrap();
        assert_eq!(result["accepted"], true);
        let request: ExecutionRequest = serde_json::from_value(
            handler.local_task_link(id).unwrap().runtime_handle["executionRequest"].clone(),
        )
        .unwrap();
        assert_eq!(
            request.extra["standInDelegation"]["sourceTaskId"],
            parent.task_id
        );
        StandInMcpIdentity {
            task_id: id.into(),
            user: parent.user,
            device: parent.device.clone(),
            role: Some("@primary".into()),
            work: None,
            ask_before_act: false,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: false,
            readonly_worker: true,
        }
    }

    #[test]
    fn native_create_captures_only_selected_refs_and_never_inherits_new_connections() {
        let _lock = crate::test_env::lock();
        let (root, handler, parent, source) = fixture();
        let _workspace = super::super::tests::ScalarEnv::set(
            "WEGENT_STANDALONE_WORKSPACE_ROOT",
            root.path().to_str().unwrap(),
        );
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        assert!(handler
            .capture_delegated_read_sources(&parent, &json!({}))
            .unwrap()
            .is_empty());
        let child = create(&handler, &parent, &source).await;
        let refs = handler
            .stand_in_task_operation(child.clone(), "delegated_read_sources", json!({}))
            .await
            .unwrap();
        assert_eq!(refs["sources"], json!([source]));
        let original = handler.local_task_link(&child.task_id).unwrap();
        assert_eq!(
            original.runtime_handle["executionRequest"]["standInDelegation"]["readSources"],
            json!([source_ref(&source).unwrap()])
        );
        let mut forged = source.clone();
        forged["policy"]["askBeforeAct"] = json!(false);
        let actual = handler
            .stand_in_task_operation(child.clone(), "authorize_delegated_source_read", forged)
            .await
            .unwrap();
        assert_eq!(actual["policy"]["askBeforeAct"], true);
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        let mut added = source.clone();
        added["id"] = json!("added-later");
        settings["primary"]["connections"]
            .as_array_mut()
            .unwrap()
            .push(added.clone());
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert_eq!(
            handler.delegated_read_sources(&child).unwrap(),
            vec![source.clone()]
        );
        assert!(handler
            .stand_in_task_operation(
                child.clone(),
                "authorize_delegated_source_read",
                added.clone()
            )
            .await
            .is_err());
        assert_eq!(handler.stand_in_task_operation(parent.clone(),"continue_task",json!({"taskId":child.task_id,"requestId":"expand","message":"Expand","readSources":[source,added]})).await.unwrap_err().code,"delegated_read_scope_immutable");
        handler.store.update_task(&child.task_id, |link| {
            link.thread_id = Some("child-thread".into())
        });
        let continued=handler.stand_in_task_operation(parent,"continue_task",json!({"taskId":child.task_id,"requestId":"same-scope","message":"Continue the same scope"})).await.unwrap();
        assert_eq!(continued["accepted"], true);
        let queued = handler
            .turn_scheduler
            .lock()
            .unwrap()
            .queued_turns
            .iter()
            .find(|turn| turn.local_task_id == child.task_id)
            .unwrap()
            .request
            .clone();
        assert_eq!(
            queued.extra["standInDelegation"]["readSources"],
            json!([source_ref(&source).unwrap()])
        );
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"]["connections"] = json!([]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert!(handler.delegated_read_sources(&child).is_err());
        });
    }

    #[test]
    fn each_read_rechecks_child_parent_owner_role_device_and_exact_scope() {
        let _lock = crate::test_env::lock();
        let (root, handler, parent, source) = fixture();
        let _workspace = super::super::tests::ScalarEnv::set(
            "WEGENT_STANDALONE_WORKSPACE_ROOT",
            root.path().to_str().unwrap(),
        );
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let child = create(&handler, &parent, &source).await;
                let original = handler.local_task_link(&child.task_id).unwrap();
                for (field, value) in [
                    ("userId", json!(8)),
                    ("deviceId", json!("foreign")),
                    ("standInId", json!("other")),
                    ("sourceTaskId", json!("foreign-parent")),
                    ("type", json!("issue_dispatch")),
                ] {
                    handler.store.update_task(&child.task_id, |link| {
                        link.runtime_handle["origin"][field] = value.clone()
                    });
                    assert!(handler.delegated_read_sources(&child).is_err(), "{field}");
                    handler.upsert_local_task(original.clone());
                }
                handler.store.update_task(&child.task_id, |link| {
                    link.runtime_handle["executionRequest"]["user_id"] = json!(8)
                });
                assert!(handler.delegated_read_sources(&child).is_err());
                handler.upsert_local_task(original);
                let actor = handler.local_task_link(&parent.task_id).unwrap();
                for (field, value) in [
                    ("userId", json!(8)),
                    ("deviceId", json!("foreign")),
                    ("standInId", json!("other")),
                    ("standInId", json!(3)),
                    ("type", json!("connection_work")),
                ] {
                    handler.store.update_task(&parent.task_id, |link| {
                        link.runtime_handle["origin"][field] = value.clone()
                    });
                    assert!(
                        handler.delegated_read_sources(&child).is_err(),
                        "parent {field}"
                    );
                    handler.upsert_local_task(actor.clone());
                }
                for key in KEYS {
                    let mut foreign = source_ref(&source).unwrap();
                    foreign[key] = json!("other");
                    assert!(handler
                        .stand_in_task_operation(
                            child.clone(),
                            "authorize_delegated_source_read",
                            foreign
                        )
                        .await
                        .is_err());
                }
            });
    }

    #[test]
    fn capture_never_grants_wildcards_unconnected_or_source_coordinator_authority() {
        let (_root, handler, parent, source) = fixture();
        let mut wildcard = source_ref(&source).unwrap();
        wildcard["id"] = json!("*");
        assert!(handler
            .capture_delegated_read_sources(&parent, &json!({"readSources":[wildcard]}))
            .is_err());
        let mut absent = source_ref(&source).unwrap();
        absent["id"] = json!("unconnected");
        assert!(handler
            .capture_delegated_read_sources(&parent, &json!({"readSources":[absent]}))
            .is_err());
        let mut scoped = source.clone();
        scoped["scope"] = json!("all");
        assert!(handler
            .capture_delegated_read_sources(&parent, &json!({"readSources":[scoped]}))
            .is_err());
        let mut invalid = parent.clone();
        invalid.work = Some("source-work".into());
        assert!(handler
            .capture_delegated_read_sources(&invalid, &json!({"readSources":[source]}))
            .is_err());
        let mut coordinator = parent.clone();
        coordinator.coordinator_batch = Some("batch".into());
        assert!(handler
            .capture_delegated_read_sources(&coordinator, &json!({"readSources":[source]}))
            .is_err());
    }
}
