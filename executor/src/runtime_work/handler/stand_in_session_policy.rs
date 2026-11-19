//! Conversation identity is independent of intake timing and operation grants.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) fn connection_binding_target(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role: &Value,
        event: &Value,
        immediate: bool,
    ) -> Result<Option<String>, AppIpcError> {
        if immediate {
            return self.connection_session_target(
                store,
                user,
                role,
                &event["source"],
                &event["message"],
            );
        }
        // A reusable conversation is not evidence that new work is already classified.
        let Some(quoted) = event["message"]["quotedMessageId"].as_str() else {
            return Ok(None);
        };
        let target = store
            .known_stand_in_message(user, required(role, "id")?, &event["source"], quoted)
            .map_err(settings_error)?
            .and_then(|message| message["workId"].as_str().map(str::to_owned));
        if target
            .as_deref()
            .is_some_and(|id| self.connection_session_archived(id))
        {
            return self.connection_session_target(
                store,
                user,
                role,
                &event["source"],
                &event["message"],
            );
        }
        Ok(target)
    }

    pub(in crate::runtime_work::handler) fn connection_session_target(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role: &Value,
        source: &Value,
        message: &Value,
    ) -> Result<Option<String>, AppIpcError> {
        let role_id = required(role, "id")?;
        // Redelivery retains its original conversation; new replies cannot reopen archives.
        let known = store
            .known_stand_in_event_message(user, role_id, source, message)
            .map_err(settings_error)?;
        let known = match (known, message["quotedMessageId"].as_str()) {
            (None, Some(quoted)) => store
                .known_stand_in_message(user, role_id, source, quoted)
                .map_err(settings_error)?
                .filter(|known| {
                    !known["workId"]
                        .as_str()
                        .is_some_and(|id| self.connection_session_archived(id))
                }),
            (known, _) => known,
        };
        // Provider revisions belong to the same work even with independent events.
        let known = if known.is_none() && message["objectId"].is_string() {
            store
                .known_stand_in_message(user, role_id, source, required(message, "id")?)
                .map_err(settings_error)?
                .filter(|previous| previous["objectId"] == message["objectId"])
        } else {
            known
        };
        if let Some(known) = known {
            return Ok(known["workId"].as_str().map(str::to_owned));
        }
        let connection = stand_in_collection_connection(role, source)
            .ok_or_else(|| AppIpcError::new("source_removed", "Source was disconnected"))?;
        if connection["policy"]["sessionStrategy"] == "independent" {
            return Ok(None);
        }
        let identity = json!([
            user,
            role_id,
            crate::task_runtime::personal_stand_in::source_provider(source),
            source["transport"],
            crate::task_runtime::personal_stand_in::source_collection_namespace(source),
            source["kind"],
            source["id"]
        ]);
        let mut target = format!(
            "stand-in-work-source-{}",
            LocalTaskStore::coordination_event_version(&identity)
        );
        while self.connection_session_archived(&target) {
            target = format!(
                "stand-in-work-source-{}",
                LocalTaskStore::coordination_event_version(&json!([identity, target]))
            );
        }
        Ok(Some(target))
    }

    fn connection_session_archived(&self, id: &str) -> bool {
        self.store.is_deleted_archived_task_id(id)
            || self
                .local_task_link(id)
                .is_some_and(|link| link.status == "archived")
    }

    pub(super) fn validate_connection_session_target(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role: &Value,
        event: &Value,
        target: &str,
    ) -> Result<(), AppIpcError> {
        if event["kind"] == "connection"
            && self
                .connection_session_target(store, user, role, &event["source"], &event["message"])?
                .as_deref()
                != Some(target)
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Conversation does not match the source session strategy",
            ));
        }
        Ok(())
    }

    pub(super) async fn dispatch_connection_intake(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role: &Value,
        events: &[Value],
        title: Option<&str>,
    ) -> Result<Value, AppIpcError> {
        let mut groups: Vec<(String, std::collections::BTreeSet<String>)> = Vec::new();
        for event in events {
            let target = self.connection_session_target(
                store,
                user,
                role,
                &event["source"],
                &event["message"],
            )?;
            let id = target.unwrap_or_else(|| {
                format!(
                    "stand-in-work-event-{}",
                    LocalTaskStore::coordination_event_version(&json!([
                        user,
                        role["id"],
                        event["id"]
                    ]))
                )
            });
            if let Some(link) = self.local_task_link(&id) {
                if link.status == "archived" {
                    return Err(AppIpcError::new(
                        "bad_request",
                        format!("Work \"{}\" from \"{}\" is archived. Restore it from recent activities before continuing.", link.title, event["source"]["name"].as_str().unwrap_or("this source")),
                    ));
                }
                if waits_for_user(&link) {
                    return Ok(json!({"pending":true,"taskId":id}));
                }
                self.validate_followup_role(store, user, role, &link)
                    .await?;
            }
            store
                .ensure_coordinated_work(
                    user,
                    required(role, "id")?,
                    &id,
                    &event["source"],
                    title.unwrap_or("Work"),
                )
                .map_err(settings_error)?;
            let work = store
                .ingest_stand_in_message(
                    user,
                    required(role, "id")?,
                    &event["source"],
                    &event["message"],
                    Some(&id),
                )
                .map_err(settings_error)?;
            let id = required(&work, "id")?;
            let records = self.connection_event_records(
                store,
                user,
                required(role, "id")?,
                id,
                std::slice::from_ref(event),
            )?;
            if let Some((_, selected)) = groups.iter_mut().find(|(work, _)| work == id) {
                selected.extend(records);
            } else {
                groups.push((id.to_owned(), records.into_iter().collect()));
            }
        }
        let mut result = json!({"success":true});
        for (id, records) in groups {
            let records = records.into_iter().collect::<Vec<_>>();
            result = self
                .dispatch_connection_work(user, &id, false, None, Some(&records))
                .await?;
            if result["pending"] == true {
                return Ok(result);
            }
        }
        Ok(result)
    }

    pub(in crate::runtime_work::handler) fn connection_event_records(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role: &str,
        work: &str,
        events: &[Value],
    ) -> Result<Vec<String>, AppIpcError> {
        let mut records = std::collections::BTreeSet::new();
        for event in events.iter().filter(|event| event["kind"] == "connection") {
            let record = store
                .known_stand_in_event_message(user, role, &event["source"], &event["message"])
                .map_err(settings_error)?
                .ok_or_else(|| {
                    AppIpcError::new("stale_context", "Selected source message is unavailable")
                })?;
            if record["workId"] != work {
                return Err(AppIpcError::new(
                    "stale_context",
                    "Selected source message changed work",
                ));
            }
            records.insert(required(&record, "recordId")?.to_owned());
        }
        Ok(records.into_iter().collect())
    }

    pub(in crate::runtime_work::handler) fn ignore_connection_event(
        &self,
        store: &LocalTaskStore,
        user: i64,
        event: &Value,
    ) -> Result<(), AppIpcError> {
        for role in event["roleIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let Some(record) = store
                .known_stand_in_event_message(user, role, &event["source"], &event["message"])
                .map_err(settings_error)?
            else {
                continue;
            };
            if matches!(
                record["dispatchStatus"].as_str(),
                Some("pending" | "needs_grouping")
            ) {
                let work = required(&record, "workId")?;
                let state = store.stand_in_work(user, work).map_err(settings_error)?;
                store
                    .update_stand_in_dispatch(
                        user,
                        work,
                        &[required(&record, "recordId")?.to_owned()],
                        "ignored",
                        state["error"].as_str(),
                    )
                    .map_err(settings_error)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(
        root: &Path,
        immediate: bool,
        strategy: &str,
    ) -> (RuntimeWorkRpcHandler, LocalTaskStore, Value, Value) {
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        let source = json!({"providerId":"example/events","profile":"account","kind":"group","id":"one","name":"One", "policy":{"automatic":true,"askBeforeAct":true,"immediate":immediate,"sessionStrategy":strategy}});
        settings["roles"][0]["enabled"] = json!(true);
        settings["roles"][0]["prompt"] = json!("Handle incoming work");
        settings["roles"][0]["connections"] = json!([source]);
        let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let role = settings["roles"][0].clone();
        (handler, store, role.clone(), role["connections"][0].clone())
    }

    fn message(id: &str) -> Value {
        json!({"id":id,"text":"Incoming work","at":chrono::Utc::now().to_rfc3339()})
    }

    #[tokio::test]
    async fn archived_sources_roll_over_and_reuse_the_new_work_without_replaying_history() {
        for immediate in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (handler, store, role, source) = fixture(root.path(), immediate, "reuse");
            let mut previous = None;
            for generation in 0..3 {
                let mut incoming = message(&format!("first-{generation}"));
                if generation > 0 {
                    incoming["quotedMessageId"] = json!(format!("first-{}", generation - 1));
                }
                let target = handler
                    .connection_session_target(&store, 7, &role, &source, &incoming)
                    .unwrap()
                    .unwrap();
                assert_ne!(Some(&target), previous.as_ref());
                let event = json!({"kind":"connection","source":source,"message":incoming});
                let binding = handler
                    .connection_binding_target(&store, 7, &role, &event, immediate)
                    .unwrap();
                if immediate || generation > 0 {
                    assert_eq!(binding.as_deref(), Some(target.as_str()));
                }
                handler
                    .collect_connection_message(&store, 7, &role, &source, &incoming)
                    .await
                    .unwrap();
                handler
                    .collect_connection_message(
                        &store,
                        7,
                        &role,
                        &source,
                        &message(&format!("followup-{generation}")),
                    )
                    .await
                    .unwrap();
                assert_eq!(store.stand_in_messages(7, &target).unwrap().len(), 2);
                handler.upsert_local_task(RuntimeTaskLink {
                    local_task_id: target.clone(),
                    status: "archived".into(),
                    ..Default::default()
                });
                // A repeated delivery still belongs to the archived original work.
                assert_eq!(
                    handler
                        .connection_session_target(&store, 7, &role, &source, &incoming)
                        .unwrap(),
                    Some(target.clone())
                );
                previous = Some(target);
            }
            let (restarted, _, _, _) = fixture(root.path(), immediate, "reuse");
            let target = restarted
                .connection_session_target(&store, 7, &role, &source, &message("after-restart"))
                .unwrap()
                .unwrap();
            assert_ne!(Some(&target), previous.as_ref());
            for work in store.list_stand_in_work(7, None).unwrap() {
                let id = work["id"].as_str().unwrap();
                assert_eq!(restarted.local_task_link(id).unwrap().status, "archived");
                assert_eq!(store.stand_in_messages(7, id).unwrap().len(), 2);
            }
        }
    }

    #[tokio::test]
    async fn independent_replies_to_archives_create_new_work() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, role, source) = fixture(root.path(), false, "independent");
        handler
            .collect_connection_message(&store, 7, &role, &source, &message("first"))
            .await
            .unwrap();
        let work = store.list_stand_in_work(7, None).unwrap().remove(0);
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: work["id"].as_str().unwrap().into(),
            status: "archived".into(),
            ..Default::default()
        });
        let mut reply = message("reply");
        reply["quotedMessageId"] = json!("first");
        assert_eq!(
            handler
                .connection_session_target(&store, 7, &role, &source, &reply)
                .unwrap(),
            None
        );
        let event = json!({"kind":"connection","source":source,"message":reply});
        assert_eq!(
            handler
                .connection_binding_target(&store, 7, &role, &event, false)
                .unwrap(),
            None
        );
        handler
            .collect_connection_message(&store, 7, &role, &source, &reply)
            .await
            .unwrap();
        assert_eq!(store.list_stand_in_work(7, None).unwrap().len(), 2);
    }

    #[test]
    fn ignoring_selected_input_preserves_other_messages_and_failed_outcomes() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, role, source) = fixture(root.path(), false, "reuse");
        let role_id = role["id"].as_str().unwrap();
        let first = message("selected");
        let second = message("failed");
        let work = store
            .ingest_stand_in_message(7, role_id, &source, &first, None)
            .unwrap();
        let id = work["id"].as_str().unwrap();
        store
            .ingest_stand_in_message(7, role_id, &source, &second, Some(id))
            .unwrap();
        let failed = store
            .known_stand_in_event_message(7, role_id, &source, &second)
            .unwrap()
            .unwrap();
        store
            .update_stand_in_dispatch(
                7,
                id,
                &[failed["recordId"].as_str().unwrap().into()],
                "failed",
                Some("Outcome requires review"),
            )
            .unwrap();
        for message in [first, second] {
            handler
                .ignore_connection_event(
                    &store,
                    7,
                    &json!({"roleIds":[role_id],"source":source,"message":message}),
                )
                .unwrap();
        }
        let messages = store.stand_in_messages(7, id).unwrap();
        assert_eq!(messages[0]["dispatchStatus"], "ignored");
        assert_eq!(messages[1]["dispatchStatus"], "failed");
        assert_eq!(
            store.stand_in_work(7, id).unwrap()["error"],
            "Outcome requires review"
        );
    }

    #[test]
    fn provider_object_revisions_keep_the_original_work_in_independent_mode() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, role, source) = fixture(root.path(), true, "independent");
        let mut first = message("provider-object");
        first["objectId"] = json!("object-one");
        first["version"] = json!("revision-one");
        store
            .ensure_coordinated_work(7, "default", "original-work", &source, "Original work")
            .unwrap();
        store
            .ingest_stand_in_message(7, "default", &source, &first, Some("original-work"))
            .unwrap();
        let mut revision = first.clone();
        revision["version"] = json!("revision-two");
        assert_eq!(
            handler
                .connection_session_target(&store, 7, &role, &source, &revision)
                .unwrap(),
            Some("original-work".into())
        );
        revision["objectId"] = json!("different-object");
        assert_eq!(
            handler
                .connection_session_target(&store, 7, &role, &source, &revision)
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn missing_strategy_defaults_to_reuse_for_the_same_source() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, mut role, mut source) = fixture(root.path(), false, "reuse");
        source["policy"]
            .as_object_mut()
            .unwrap()
            .remove("sessionStrategy");
        role["connections"] = json!([source]);
        for id in ["first", "second"] {
            handler
                .collect_connection_message(&store, 7, &role, &source, &message(id))
                .await
                .unwrap();
        }
        let works = store.list_stand_in_work(7, None).unwrap();
        assert_eq!(works.len(), 1);
        assert_eq!(works[0]["messageCount"], 2);
    }

    #[tokio::test]
    async fn session_policy_is_independent_of_timing_and_survives_store_reopen() {
        for immediate in [false, true] {
            for strategy in ["independent", "reuse"] {
                let root = tempfile::tempdir().unwrap();
                let (handler, store, role, source) = fixture(root.path(), immediate, strategy);
                handler
                    .collect_connection_message(&store, 7, &role, &source, &message("first"))
                    .await
                    .unwrap();
                drop(store);
                let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
                for id in ["second", "second"] {
                    handler
                        .collect_connection_message(&store, 7, &role, &source, &message(id))
                        .await
                        .unwrap();
                }
                let works = store.list_stand_in_work(7, Some("default")).unwrap();
                assert_eq!(works.len(), if strategy == "reuse" { 1 } else { 2 });
                let count: i64 = works
                    .iter()
                    .map(|work| work["messageCount"].as_i64().unwrap())
                    .sum();
                assert_eq!(count, 2);
                assert!(handler.local_task_links(true).is_empty());
                let saved = store.personal_stand_in(7, "mac").unwrap();
                assert_eq!(
                    saved["roles"][0]["connections"][0]["policy"],
                    source["policy"]
                );
            }
        }
    }

    #[test]
    fn reuse_identity_isolates_owner_role_provider_account_resource_and_collection() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, role, source) = fixture(root.path(), true, "reuse");
        let original = handler
            .connection_session_target(&store, 7, &role, &source, &message("first"))
            .unwrap();
        assert!(original.is_some());
        assert_eq!(
            original,
            handler
                .connection_session_target(&store, 7, &role, &source, &message("different"))
                .unwrap()
        );
        assert_ne!(
            original,
            handler
                .connection_session_target(&store, 8, &role, &source, &message("first"))
                .unwrap()
        );
        let mut other_role = role.clone();
        other_role["id"] = json!("other");
        assert_ne!(
            original,
            handler
                .connection_session_target(&store, 7, &other_role, &source, &message("first"))
                .unwrap()
        );
        for field in [
            "providerId",
            "profile",
            "kind",
            "id",
            "collectionKey",
            "transport",
        ] {
            let mut source = source.clone();
            source[field] = json!("another");
            let mut role = role.clone();
            role["connections"] = json!([source]);
            assert_ne!(
                original,
                handler
                    .connection_session_target(
                        &store,
                        7,
                        &role,
                        &role["connections"][0],
                        &message("first")
                    )
                    .unwrap(),
                "{field}"
            );
        }
        let mut disconnected = role.clone();
        disconnected["connections"] = json!([]);
        assert!(handler
            .connection_session_target(&store, 7, &disconnected, &source, &message("first"))
            .is_err());
    }

    #[tokio::test]
    async fn explicit_replies_keep_original_work_but_unrelated_continuations_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, role, source) = fixture(root.path(), false, "independent");
        handler
            .collect_connection_message(&store, 7, &role, &source, &message("first"))
            .await
            .unwrap();
        let work = store.list_stand_in_work(7, None).unwrap().remove(0);
        let target = work["id"].as_str().unwrap();
        let mut event = json!({"kind":"connection","source":source,"message":message("second")});
        assert_eq!(
            handler
                .validate_connection_session_target(&store, 7, &role, &event, target)
                .unwrap_err()
                .code,
            "permission_denied"
        );
        event["message"]["quotedMessageId"] = json!("first");
        handler
            .validate_connection_session_target(&store, 7, &role, &event, target)
            .unwrap();
    }

    #[tokio::test]
    async fn router_binding_and_eligibility_follow_separate_policy_dimensions() {
        for immediate in [false, true] {
            for strategy in ["independent", "reuse"] {
                let root = tempfile::tempdir().unwrap();
                let (handler, store, role, source) = fixture(root.path(), immediate, strategy);
                handler
                    .collect_connection_message(&store, 7, &role, &source, &message("first"))
                    .await
                    .unwrap();
                let work = store.list_stand_in_work(7, None).unwrap().remove(0);
                handler.upsert_local_task(RuntimeTaskLink {
                    local_task_id: work["id"].as_str().unwrap().into(), status: "done".into(),
                    runtime_handle: json!({"origin":{"type":"connection_work","initiatedBy":"stand_in","userId":7,"standInId":"default"}}),
                    ..Default::default()
                });
                store.enqueue_stand_in_event(7,json!("second"),json!({"kind":"connection","roleScoped":true,"roleIds":["default"],"source":source,"message":message("second")})).unwrap();
                let settings = store.personal_stand_in(7, "mac").unwrap();
                let snapshot = handler.coordination_rpc("runtime.coordination.snapshot",json!({"contextId":"personal:7","revision":LocalTaskStore::coordination_configuration_version(&settings)})).await.unwrap();
                let event = snapshot["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|event| event["kind"] == "connection")
                    .unwrap();
                assert_eq!(
                    event["processingMode"],
                    if immediate { "immediate" } else { "silent" }
                );
                if immediate && strategy == "reuse" {
                    assert_eq!(event["binding"]["workId"], work["id"]);
                } else {
                    assert!(event["binding"].is_null());
                }
                if !immediate {
                    assert!(event["dispatch"].is_null());
                    for quoted in ["first", "unknown"] {
                        let mut reply_message = message(&format!("reply-{quoted}"));
                        reply_message["quotedMessageId"] = json!(quoted);
                        let reply = store.enqueue_stand_in_event(7,json!(["reply",quoted]),json!({"kind":"connection","roleScoped":true,"roleIds":["default"],"source":source,"message":reply_message})).unwrap();
                        let snapshot = handler.coordination_rpc("runtime.coordination.snapshot",json!({"contextId":"personal:7","revision":LocalTaskStore::coordination_configuration_version(&settings)})).await.unwrap();
                        let event = snapshot["events"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|event| event["id"] == reply["id"])
                            .unwrap();
                        if quoted == "first" {
                            assert_eq!(event["binding"]["workId"], work["id"]);
                        } else {
                            assert!(event["binding"].is_null());
                            assert!(event["dispatch"].is_null());
                        }
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn reused_work_waits_for_user_without_ingesting_or_dispatching_new_events() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, role, source) = fixture(root.path(), true, "reuse");
        handler
            .collect_connection_message(&store, 7, &role, &source, &message("first"))
            .await
            .unwrap();
        let work = store.list_stand_in_work(7, None).unwrap().remove(0);
        let id = work["id"].as_str().unwrap();
        for status in ["waitingForUserInput", "waitingForApproval"] {
            handler.upsert_local_task(RuntimeTaskLink {
                local_task_id: id.into(),
                status: "active".into(),
                interaction_status: Some(status.into()),
                ..Default::default()
            });
            let result=handler.dispatch_connection_intake(&store,7,&role,&[json!({"id":"event-two","kind":"connection","source":source,"message":message("second")})],Some("Work")).await.unwrap();
            assert_eq!(result["pending"], true);
            assert_eq!(store.stand_in_messages(7, id).unwrap().len(), 1);
        }
    }
}
