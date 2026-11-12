//! Routing plans and their business intents commit in the existing stand-in transaction.
use super::stand_in_inbox::stand_in_record_key;
use super::stand_in_processing::{rows, write, ACTION, EVENT, STATE};
use super::*;
use sha2::{Digest, Sha256};

const ROUTE: &str = "stand_in_route";

impl LocalTaskStore {
    pub fn split_stand_in_connection_intake(&self, user: i64) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let claimed = rows(&connection, ACTION, user)?
            .into_iter()
            .filter(|action| matches!(action["status"].as_str(), Some("pending" | "sending")))
            .flat_map(|action| {
                action["arguments"]["eventIds"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        for mut event in rows(&connection, EVENT, user)? {
            if event["kind"] != "connection"
                || event["roleScoped"] == true
                || claimed.contains(&event["id"])
            {
                continue;
            }
            let roles = event["roleIds"].as_array().cloned().unwrap_or_default();
            for role in roles {
                let source = &event["source"];
                let identity = json!([
                    super::personal_stand_in::source_provider(source),
                    source["profile"],
                    source["kind"],
                    source["id"],
                    event["message"]["id"],
                    role
                ]);
                let id = stand_in_record_key("stand-in-event", &json!([user, identity]));
                if get_item_from(&connection, &id, EVENT)?.is_some() {
                    continue;
                }
                let mut child = event.clone();
                child["id"] = json!(id);
                child["roleIds"] = json!([role]);
                child["roleScoped"] = json!(true);
                write(&connection, EVENT, &child)?;
            }
            event["status"] = json!("migrated");
            event["roleScoped"] = json!(true);
            write(&connection, EVENT, &event)?;
        }
        connection.commit()?;
        Ok(())
    }

    pub fn coordination_configuration_version(settings: &Value) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                json!([settings["primary"], settings["roles"]])
                    .to_string()
                    .as_bytes()
            )
        )
    }

    pub fn coordination_event_version(event: &Value) -> String {
        format!("{:x}", Sha256::digest(event.to_string().as_bytes()))
    }

    pub fn commit_stand_in_route(
        &self,
        user: i64,
        device: &str,
        snapshot_id: &str,
        digest: &str,
        states: (&Value, &Value),
        intents: &[Value],
    ) -> Result<Value, TaskRuntimeError> {
        let (expected_state, next_state) = states;
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let route_id = stand_in_record_key("stand-in-route", &json!([user, snapshot_id]));
        if let Some(receipt) = get_item_from(&connection, &route_id, ROUTE)? {
            if receipt.metadata["deviceId"] != device || receipt.metadata["digest"] != digest {
                return Err(TaskRuntimeError::Invalid(
                    "Routing snapshot was already committed with a different plan".into(),
                ));
            }
            return Ok(receipt.metadata["result"].clone());
        }
        let state = get_item_from(&connection, &format!("stand-in-processing:{user}"), STATE)?
            .ok_or(TaskRuntimeError::TaskNotFound)?
            .metadata;
        let snapshot = &state["routerSnapshot"];
        let settings = super::personal_stand_in::read_personal(&connection, user, device)?;
        if settings["primary"]["enabled"] == false
            || state != *expected_state
            || snapshot["id"] != snapshot_id
            || snapshot["deviceId"] != device
            || snapshot["wakeVersion"] != state["wakeVersion"]
            || snapshot["configurationVersion"]
                != Self::coordination_configuration_version(&settings)
        {
            return Err(TaskRuntimeError::Invalid(
                "Routing snapshot is no longer current".into(),
            ));
        }
        let mut event_ids = HashSet::new();
        for intent in intents {
            let ids = intent["arguments"]["eventIds"]
                .as_array()
                .filter(|ids| !ids.is_empty())
                .ok_or_else(|| {
                    TaskRuntimeError::Invalid("Routing intent requires event IDs".into())
                })?;
            for value in ids {
                let id = value
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| TaskRuntimeError::Invalid("Invalid routing event ID".into()))?;
                if !event_ids.insert(id) {
                    return Err(TaskRuntimeError::Invalid(
                        "Routing event is consumed more than once".into(),
                    ));
                }
            }
        }
        for action in rows(&connection, ACTION, user)? {
            if matches!(action["status"].as_str(), Some("pending" | "sending"))
                && action["arguments"]["eventIds"]
                    .as_array()
                    .is_some_and(|ids| {
                        ids.iter()
                            .filter_map(Value::as_str)
                            .any(|id| event_ids.contains(id))
                    })
            {
                return Err(TaskRuntimeError::Invalid(
                    "Routing events have already been claimed".into(),
                ));
            }
        }
        for id in &event_ids {
            let event = get_item_from(&connection, id, EVENT)?
                .ok_or(TaskRuntimeError::TaskNotFound)?
                .metadata;
            if event["userId"] != user
                || event["status"] != "pending"
                || snapshot["eventVersions"][*id] != Self::coordination_event_version(&event)
            {
                return Err(TaskRuntimeError::Invalid(
                    "Routing event changed or is outside the snapshot".into(),
                ));
            }
        }

        let mut ids = Vec::new();
        for intent in intents {
            let kind = intent["kind"]
                .as_str()
                .ok_or_else(|| TaskRuntimeError::Invalid("Routing intent has no kind".into()))?;
            if !matches!(
                kind,
                "create_work" | "continue_work" | "wait_for_work" | "assess"
            ) || intent["arguments"].to_string().len() > 100_000
            {
                return Err(TaskRuntimeError::Invalid("Invalid routing intent".into()));
            }
            let id = stand_in_record_key(
                "stand-in-action",
                &json!([user, snapshot_id, kind, intent["arguments"]]),
            );
            write(
                &connection,
                ACTION,
                &json!({"id":id,"userId":user,"batchId":snapshot_id,"kind":kind,"arguments":intent["arguments"],"status":"pending","createdAt":now()}),
            )?;
            ids.push(id);
        }
        let mut committed = next_state.clone();
        committed["id"] = json!(format!("stand-in-processing:{user}"));
        committed["userId"] = json!(user);
        committed["routerSnapshot"] = Value::Null;
        write(&connection, STATE, &committed)?;
        let result = json!({"accepted":true,"snapshotId":snapshot_id,"actionIds":ids});
        write(
            &connection,
            ROUTE,
            &json!({"id":route_id,"userId":user,"deviceId":device,"digest":digest,"result":result}),
        )?;
        connection.commit()?;
        Ok(result)
    }

    pub fn stand_in_route_receipt(
        &self,
        user: i64,
        snapshot_id: &str,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        let id = stand_in_record_key("stand-in-route", &json!([user, snapshot_id]));
        Ok(get_item_from(&*self.connection()?, &id, ROUTE)?.map(|row| row.metadata))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, LocalTaskStore, Value, Value) {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        settings["primary"] = json!({"enabled":true,"prompt":"","preferences":""});
        let settings = store.save_personal_stand_in(7, "device", settings).unwrap();
        let event = store
            .enqueue_stand_in_event(
                7,
                json!("one"),
                json!({"kind":"connection","roleIds":["default"]}),
            )
            .unwrap();
        let state = json!({"routerSnapshot":{"id":"snapshot","deviceId":"device","configurationVersion":LocalTaskStore::coordination_configuration_version(&settings),"eventVersions":{event["id"].as_str().unwrap():LocalTaskStore::coordination_event_version(&event)}}});
        store.save_stand_in_processing_state(7, &state).unwrap();
        let state = store.stand_in_processing_state(7).unwrap();
        (root, store, state, event)
    }

    #[test]
    fn route_replay_is_idempotent_and_changed_input_is_rejected() {
        let (_root, store, state, event) = fixture();
        let intent = json!({"kind":"continue_work","arguments":{"eventIds":[event["id"]],"taskId":"work","message":"followup"}});
        let receipt = store
            .commit_stand_in_route(
                7,
                "device",
                "snapshot",
                "digest",
                (&state, &state),
                std::slice::from_ref(&intent),
            )
            .unwrap();
        assert_eq!(
            receipt,
            store
                .commit_stand_in_route(
                    7,
                    "device",
                    "snapshot",
                    "digest",
                    (&state, &state),
                    &[intent]
                )
                .unwrap()
        );
        assert_eq!(store.stand_in_actions(7).unwrap().len(), 1);
        assert!(store
            .commit_stand_in_route(7, "device", "snapshot", "different", (&state, &state), &[])
            .is_err());
    }

    #[test]
    fn invalid_later_intent_rolls_back_the_entire_plan_and_receipt() {
        let (_root, store, state, event) = fixture();
        let intents = vec![
            json!({"kind":"continue_work","arguments":{"eventIds":[event["id"]]}}),
            json!({"kind":"invalid","arguments":{}}),
        ];
        assert!(store
            .commit_stand_in_route(
                7,
                "device",
                "snapshot",
                "digest",
                (&state, &state),
                &intents
            )
            .is_err());
        assert!(store.stand_in_actions(7).unwrap().is_empty());
        assert!(store
            .stand_in_route_receipt(7, "snapshot")
            .unwrap()
            .is_none());
        assert_eq!(
            store.stand_in_processing_state(7).unwrap()["routerSnapshot"],
            state["routerSnapshot"]
        );
    }

    #[test]
    fn invalid_duplicate_and_cross_device_plans_cannot_consume_events() {
        let (_root, store, state, event) = fixture();
        for ids in [json!([null]), json!([event["id"], event["id"]]), json!([])] {
            let intents = [json!({"kind":"assess","arguments":{"eventIds":ids}})];
            assert!(store
                .commit_stand_in_route(
                    7,
                    "device",
                    "snapshot",
                    "digest",
                    (&state, &state),
                    &intents
                )
                .is_err());
        }
        let intent = json!({"kind":"assess","arguments":{"eventIds":[event["id"]]}});
        assert!(store
            .commit_stand_in_route(
                7,
                "other-device",
                "snapshot",
                "digest",
                (&state, &state),
                std::slice::from_ref(&intent)
            )
            .is_err());
        assert!(store
            .commit_stand_in_route(
                7,
                "device",
                "snapshot",
                "digest",
                (&state, &state),
                &[intent.clone(), intent.clone()]
            )
            .is_err());
        assert!(store.stand_in_actions(7).unwrap().is_empty());
        store
            .commit_stand_in_route(
                7,
                "device",
                "snapshot",
                "digest",
                (&state, &state),
                &[intent],
            )
            .unwrap();
        assert!(store
            .commit_stand_in_route(
                7,
                "other-device",
                "snapshot",
                "digest",
                (&state, &state),
                &[]
            )
            .is_err());
    }

    #[test]
    fn configuration_or_event_changes_invalidate_the_snapshot() {
        let (_root, store, state, mut event) = fixture();
        event["notBefore"] = json!("2099-01-01T00:00:00Z");
        store.save_stand_in_event(7, &event).unwrap();
        let intents = [json!({"kind":"continue_work","arguments":{"eventIds":[event["id"]]}})];
        assert!(store
            .commit_stand_in_route(
                7,
                "device",
                "snapshot",
                "digest",
                (&state, &state),
                &intents
            )
            .is_err());
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        settings["primary"]["enabled"] = json!(false);
        store.save_personal_stand_in(7, "device", settings).unwrap();
        assert!(store
            .commit_stand_in_route(7, "device", "snapshot", "digest", (&state, &state), &[])
            .is_err());
        assert!(store.stand_in_actions(7).unwrap().is_empty());
    }

    #[test]
    fn concurrent_wake_and_ai_history_are_never_overwritten_by_a_stale_plan() {
        for field in ["wakeVersion", "history", "batchId"] {
            let (_root, store, state, event) = fixture();
            let mut current = state.clone();
            current[field] = json!("newer-native-state");
            store.save_stand_in_processing_state(7, &current).unwrap();
            let intents = [json!({"kind":"assess","arguments":{"eventIds":[event["id"]]}})];
            assert!(store
                .commit_stand_in_route(
                    7,
                    "device",
                    "snapshot",
                    "digest",
                    (&state, &state),
                    &intents
                )
                .is_err());
            assert_eq!(store.stand_in_processing_state(7).unwrap(), current);
            assert!(store.stand_in_actions(7).unwrap().is_empty());
        }
    }

    #[test]
    fn enabled_role_changes_and_foreign_events_cannot_commit_old_snapshots() {
        let (_root, store, mut state, _) = fixture();
        let foreign = store
            .enqueue_stand_in_event(8, json!("foreign"), json!({"kind":"assignment"}))
            .unwrap();
        state["routerSnapshot"]["eventVersions"][foreign["id"].as_str().unwrap()] =
            json!(LocalTaskStore::coordination_event_version(&foreign));
        store.save_stand_in_processing_state(7, &state).unwrap();
        let intents = [json!({"kind":"assess","arguments":{"eventIds":[foreign["id"]]}})];
        assert!(store
            .commit_stand_in_route(
                7,
                "device",
                "snapshot",
                "digest",
                (&state, &state),
                &intents
            )
            .is_err());
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        settings["roles"][0]["prompt"] = json!("changed responsibilities");
        store.save_personal_stand_in(7, "device", settings).unwrap();
        assert!(store
            .commit_stand_in_route(7, "device", "snapshot", "digest", (&state, &state), &[])
            .is_err());
        assert!(store.stand_in_actions(7).unwrap().is_empty());
    }

    #[test]
    fn connection_migration_keeps_original_window_and_terminal_status_without_replay() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        for status in ["pending", "handled"] {
            let mut event=store.enqueue_stand_in_event(7,json!(status),json!({"kind":"connection","source":{"id":"group","profile":"default","kind":"group"},"message":{"id":status},"roleIds":["a","b"]})).unwrap();
            event["status"] = json!(status);
            event["createdAt"] = json!("2026-01-01T00:00:00Z");
            store.save_stand_in_event(7, &event).unwrap();
        }
        store.split_stand_in_connection_intake(7).unwrap();
        let events = store.stand_in_events(7).unwrap();
        assert_eq!(events.len(), 6);
        assert_eq!(
            events
                .iter()
                .filter(|event| event["status"] == "pending")
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event["status"] == "handled")
                .count(),
            2
        );
        assert!(events
            .iter()
            .all(|event| event["createdAt"] == "2026-01-01T00:00:00Z"));
        store.split_stand_in_connection_intake(7).unwrap();
        assert_eq!(store.stand_in_events(7).unwrap(), events);
    }
}
