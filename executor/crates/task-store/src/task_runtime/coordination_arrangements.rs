//! Arrangement runs remain in AutomationStore; SQLite commits only routing intents.
use super::stand_in_inbox::stand_in_record_key;
use super::stand_in_processing::{write, ACTION};
use super::*;
use sha2::{Digest, Sha256};

const SNAPSHOT: &str = "stand_in_arrangement_snapshot";
const ROUTE: &str = "stand_in_arrangement_route";

impl LocalTaskStore {
    pub fn unfinished_arrangement_users(&self) -> Result<Vec<i64>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT DISTINCT json_extract(metadata,'$.userId') FROM loop_items WHERE resource_type=?1 AND json_extract(metadata,'$.kind')='run_arrangement' AND json_extract(metadata,'$.status') IN ('pending','sending')")?;
        let users = statement
            .query_map([ACTION], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(users)
    }
    pub fn arrangement_configuration_version(settings: &Value) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                json!([settings["version"], settings["primary"], settings["roles"]])
                    .to_string()
                    .as_bytes()
            )
        )
    }

    pub fn save_arrangement_snapshot(
        &self,
        user: i64,
        snapshot: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let mut record = snapshot.clone();
        record["id"] = json!(format!("stand-in-arrangements:{user}"));
        record["snapshotId"] = snapshot["id"].clone();
        record["userId"] = json!(user);
        write(&*self.connection()?, SNAPSHOT, &record)
    }

    pub fn commit_arrangement_route(
        &self,
        user: i64,
        device: &str,
        snapshot_id: &str,
        digest: &str,
        actions: &[Value],
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let route_id =
            stand_in_record_key("stand-in-arrangement-route", &json!([user, snapshot_id]));
        if let Some(receipt) = get_item_from(&connection, &route_id, ROUTE)? {
            if receipt.metadata["deviceId"] != device || receipt.metadata["digest"] != digest {
                return Err(TaskRuntimeError::Invalid(
                    "Arrangement routing was already committed with a different plan".into(),
                ));
            }
            return Ok(receipt.metadata["result"].clone());
        }
        let snapshot = get_item_from(
            &connection,
            &format!("stand-in-arrangements:{user}"),
            SNAPSHOT,
        )?
        .ok_or(TaskRuntimeError::TaskNotFound)?
        .metadata;
        let settings = super::personal_stand_in::read_personal(&connection, user, device)?;
        if snapshot["snapshotId"] != snapshot_id
            || snapshot["deviceId"] != device
            || snapshot["configurationVersion"]
                != Self::arrangement_configuration_version(&settings)
        {
            return Err(TaskRuntimeError::Invalid(
                "Arrangement snapshot changed or belongs to another device".into(),
            ));
        }
        if actions.len() > 100 {
            return Err(TaskRuntimeError::Invalid(
                "Too many arrangement routing actions".into(),
            ));
        }
        let mut selected = HashSet::new();
        let mut action_ids = Vec::new();
        for action in actions {
            if action["kind"] != "dispatch_arrangement"
                || action.as_object().map_or(true, |fields| {
                    fields.keys().any(|key| key != "kind" && key != "eventIds")
                })
            {
                return Err(TaskRuntimeError::Invalid(
                    "Unsupported arrangement routing action".into(),
                ));
            }
            let ids = action["eventIds"]
                .as_array()
                .filter(|ids| ids.len() == 1)
                .ok_or_else(|| {
                    TaskRuntimeError::Invalid(
                        "An arrangement action requires exactly one run".into(),
                    )
                })?;
            let id = ids[0]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| TaskRuntimeError::Invalid("Invalid arrangement run ID".into()))?;
            if !selected.insert(id) {
                return Err(TaskRuntimeError::Invalid(
                    "An arrangement run is consumed more than once".into(),
                ));
            }
            let run = snapshot["runs"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|run| run["id"] == id && run["userId"] == user)
                .ok_or_else(|| {
                    TaskRuntimeError::Invalid("Arrangement is outside this snapshot".into())
                })?;
            if !run["scheduledFor"]
                .as_str()
                .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
                .is_some_and(|at| at <= Utc::now())
            {
                return Err(TaskRuntimeError::Invalid(
                    "The arrangement deadline has not arrived".into(),
                ));
            }
            let arguments = json!({"runId":id,"automationId":run["automationId"],"automationVersion":run["automationVersion"],"roleId":run["roleId"],"configurationVersion":snapshot["configurationVersion"]});
            let action_id = stand_in_record_key(
                "stand-in-arrangement-action",
                &json!([user, id, snapshot["configurationVersion"]]),
            );
            if let Some(existing) = get_item_from(&connection, &action_id, ACTION)? {
                if existing.metadata["arguments"] != arguments {
                    return Err(TaskRuntimeError::Invalid(
                        "Arrangement command identity conflicts with its original input".into(),
                    ));
                }
            } else {
                write(
                    &connection,
                    ACTION,
                    &json!({"id":action_id,"userId":user,"contextId":format!("arrangements:{user}"),"kind":"run_arrangement","status":"pending","arguments":arguments,"createdAt":now()}),
                )?;
            }
            action_ids.push(action_id);
        }
        let result = json!({"accepted":true,"snapshotId":snapshot_id,"actionIds":action_ids});
        write(
            &connection,
            ROUTE,
            &json!({"id":route_id,"userId":user,"deviceId":device,"digest":digest,"result":result}),
        )?;
        connection.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, LocalTaskStore, Value) {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let settings = store.personal_stand_in(7, "device").unwrap();
        let snapshot = json!({"id":"snapshot","deviceId":"device","configurationVersion":LocalTaskStore::arrangement_configuration_version(&settings),"runs":[{"id":"run","userId":7,"roleId":"@primary","automationId":"automation","automationVersion":1,"scheduledFor":chrono::Utc::now().to_rfc3339()}]});
        store.save_arrangement_snapshot(7, &snapshot).unwrap();
        (root, store, snapshot)
    }

    fn action(id: &str) -> Value {
        json!({"kind":"dispatch_arrangement","eventIds":[id]})
    }

    #[test]
    fn router_cannot_dispatch_a_future_or_invalid_deadline() {
        for at in [json!("2099-01-01T00:00:00Z"), json!("invalid"), Value::Null] {
            let (_root, store, mut snapshot) = fixture();
            snapshot["runs"][0]["scheduledFor"] = at;
            store.save_arrangement_snapshot(7, &snapshot).unwrap();
            assert!(store
                .commit_arrangement_route(7, "device", "snapshot", "digest", &[action("run")])
                .is_err());
            assert!(store.stand_in_actions(7).unwrap().is_empty());
        }
    }

    #[test]
    fn replay_after_snapshot_replacement_keeps_exactly_one_original_intent() {
        let (_root, store, mut snapshot) = fixture();
        let first = store
            .commit_arrangement_route(7, "device", "snapshot", "digest", &[action("run")])
            .unwrap();
        snapshot["id"] = json!("new-snapshot");
        store.save_arrangement_snapshot(7, &snapshot).unwrap();
        assert_eq!(
            store
                .commit_arrangement_route(7, "device", "snapshot", "digest", &[action("run")])
                .unwrap(),
            first
        );
        store
            .commit_arrangement_route(7, "device", "new-snapshot", "new-digest", &[action("run")])
            .unwrap();
        assert_eq!(store.stand_in_actions(7).unwrap().len(), 1);
        assert!(store
            .commit_arrangement_route(7, "device", "snapshot", "changed", &[action("run")])
            .is_err());
        assert!(store
            .commit_arrangement_route(7, "other-device", "snapshot", "digest", &[action("run")])
            .is_err());
    }

    #[test]
    fn invalid_second_action_rolls_back_the_entire_plan() {
        for invalid in [
            action("foreign"),
            action("run"),
            json!({"kind":"assess","eventIds":["run"]}),
            json!({"kind":"dispatch_arrangement","eventIds":["run"],"taskId":"injected"}),
        ] {
            let (_root, store, _) = fixture();
            assert!(store
                .commit_arrangement_route(
                    7,
                    "device",
                    "snapshot",
                    "digest",
                    &[action("run"), invalid]
                )
                .is_err());
            assert!(store.stand_in_actions(7).unwrap().is_empty());
        }
    }

    #[test]
    fn owner_device_and_configuration_are_checked_inside_the_transaction() {
        let (_root, store, _) = fixture();
        assert!(store
            .commit_arrangement_route(8, "device", "snapshot", "digest", &[action("run")])
            .is_err());
        assert!(store
            .commit_arrangement_route(7, "other-device", "snapshot", "digest", &[action("run")])
            .is_err());
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        settings["primary"] = json!({"enabled":false,"prompt":"","preferences":""});
        store.save_personal_stand_in(7, "device", settings).unwrap();
        assert!(store
            .commit_arrangement_route(7, "device", "snapshot", "digest", &[action("run")])
            .is_err());
        assert!(store.stand_in_actions(7).unwrap().is_empty());
    }
}
