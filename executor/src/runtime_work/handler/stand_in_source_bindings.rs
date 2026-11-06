//! Preserve independently authorized observations of one versioned connection object.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn resolve_connection_event_binding(&self, event: &Value, roles: &[Value]) -> Value {
        let Some(identity) = LocalTaskStore::canonical_connection_event_identity(event) else {
            return event.clone();
        };
        for binding in event["sourceBindings"].as_array().into_iter().flatten() {
            let mut candidate = event.clone();
            candidate["source"] = binding["source"].clone();
            candidate["message"]["at"] = binding["at"].clone();
            candidate["message"]["position"] = binding["position"].clone();
            if LocalTaskStore::canonical_connection_event_identity(&candidate)
                == Some(identity.clone())
                && roles
                    .iter()
                    .any(|role| self.validate_intake_role(role, &candidate).is_ok())
            {
                return candidate;
            }
        }
        event.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> (RuntimeWorkRpcHandler, LocalTaskStore, Value, Value, Value) {
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        let personal = json!({"providerId":"@wegent/dsh-connection-git/github", "profile":"[\"https://github.com\",\"7\"]", "kind":"personal", "id":"personal", "transport":"cli", "name":"Account", "enabledAfter":(chrono::Utc::now()-chrono::Duration::hours(1)).to_rfc3339(), "policy":{"automatic":true,"askBeforeAct":true}});
        let mut repository = personal.clone();
        repository["kind"] = json!("repository");
        repository["id"] = json!("42");
        repository["name"] = json!("owner/repository");
        settings["primary"] = json!({"enabled":true,"prompt":"","preferences":"","connections":[personal,repository]});
        (handler, store, settings, personal, repository)
    }

    fn observation(source: &Value, role: &str) -> Value {
        json!({"roleScoped":true,"kind":"connection","source":source,
            "message":{"id":"git-canonical:comment-version","objectId":"comment:one","version":"1","at":chrono::Utc::now().to_rfc3339(),"text":"The same comment version","topicId":"https://github.com/owner/repository/issues/1"},
            "roleIds":[role]})
    }

    fn enqueue(store: &LocalTaskStore, user: i64, event: Value) -> Value {
        let identity = LocalTaskStore::canonical_connection_event_identity(&event).unwrap();
        store.enqueue_stand_in_event(user, identity, event).unwrap()
    }

    #[tokio::test]
    async fn canonical_overlap_keeps_the_remaining_subscription_and_one_notification_intent() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, mut settings, personal, repository) = fixture(root.path());
        let first = enqueue(&store, 7, observation(&personal, "@primary"));
        let mut duplicate = first.clone();
        duplicate["source"] = repository.clone();
        let second = enqueue(&store, 7, duplicate.clone());
        assert_eq!(first["id"], second["id"]);
        assert_eq!(store.stand_in_events(7).unwrap().len(), 1);
        assert_eq!(second["sourceBindings"].as_array().unwrap().len(), 2);

        settings["primary"]["connections"] = json!([repository]);
        let selected = handler
            .authorized_coordination_events(&store, 7, &settings)
            .await
            .unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0]["source"]["kind"], "repository");
        assert_eq!(selected[0]["id"], first["id"]);

        store
            .save_stand_in_processing_state(7, &json!({"batchId":"one"}))
            .unwrap();
        let args =
            json!({"eventIds":[first["id"]],"roleId":"@primary","message":"A significant finding"});
        let action = store
            .queue_stand_in_action(7, "mac", "one", "suggest_action", args.clone())
            .unwrap();
        let repeated = store
            .queue_stand_in_action(7, "mac", "one", "suggest_action", args)
            .unwrap();
        assert_eq!(action["id"], repeated["id"]);
        assert_eq!(store.stand_in_actions(7).unwrap().len(), 1);
        assert!(store.list_stand_in_work(7, None).unwrap().is_empty());

        let mut handled = second;
        handled["status"] = json!("handled");
        store.save_stand_in_event(7, &handled).unwrap();
        enqueue(&store, 7, duplicate);
        assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "handled");
        assert!(handler
            .authorized_coordination_events(&store, 7, &settings)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn canonical_overlap_never_authorizes_removed_sources_or_another_role() {
        for other_role in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (handler, store, mut settings, personal, repository) = fixture(root.path());
            let first = enqueue(&store, 7, observation(&personal, "@primary"));
            let mut duplicate = first.clone();
            duplicate["source"] = repository.clone();
            enqueue(&store, 7, duplicate);
            settings["primary"]["connections"] = json!([]);
            if other_role {
                settings["roles"][0]["enabled"] = json!(true);
                settings["roles"][0]["connections"] = json!([repository]);
            }
            assert!(handler
                .authorized_coordination_events(&store, 7, &settings)
                .await
                .unwrap()
                .is_empty());
            assert_eq!(store.stand_in_events(7).unwrap()[0]["status"], "cancelled");
            assert!(store.stand_in_actions(7).unwrap().is_empty());
            assert!(handler.local_task_links(true).is_empty());
        }
    }

    #[tokio::test]
    async fn canonical_alternate_binding_retains_its_own_ordered_boundary() {
        let root = tempfile::tempdir().unwrap();
        let (handler, store, mut settings, personal, mut repository) = fixture(root.path());
        repository["transport"] = json!("webhook");
        repository["boundary"] = json!({"partition":"repository-generation","sequence":7});
        let first = enqueue(&store, 7, observation(&personal, "@primary"));
        let mut duplicate = first.clone();
        duplicate["source"] = repository.clone();
        duplicate["message"]["position"] =
            json!({"partition":"repository-generation","sequence":8});
        enqueue(&store, 7, duplicate);
        settings["primary"]["connections"] = json!([repository]);
        let selected = handler
            .authorized_coordination_events(&store, 7, &settings)
            .await
            .unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0]["message"]["position"]["sequence"], 8);
        settings["primary"]["connections"][0]["boundary"]["sequence"] = json!(8);
        assert!(handler
            .authorized_coordination_events(&store, 7, &settings)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn canonical_alternates_cannot_cross_owner_role_or_cli_account() {
        let root = tempfile::tempdir().unwrap();
        let (_handler, store, _settings, personal, repository) = fixture(root.path());
        let original = observation(&personal, "@primary");
        let identity = LocalTaskStore::canonical_connection_event_identity(&original).unwrap();
        let first = enqueue(&store, 7, original.clone());
        let another_user = enqueue(&store, 8, original.clone());
        assert_ne!(first["id"], another_user["id"]);
        let mut another_role = original.clone();
        another_role["roleIds"] = json!(["another-role"]);
        let separate = enqueue(&store, 7, another_role.clone());
        assert_ne!(first["id"], separate["id"]);

        let mut another_account = original;
        another_account["source"] = repository;
        another_account["source"]["profile"] = json!("[\"https://github.com\",\"8\"]");
        for invalid in [another_role, another_account] {
            let unchanged = store
                .enqueue_stand_in_event(7, identity.clone(), invalid)
                .unwrap();
            assert_eq!(unchanged["sourceBindings"].as_array().unwrap().len(), 1);
            assert_eq!(unchanged["source"], personal);
        }
    }
}
