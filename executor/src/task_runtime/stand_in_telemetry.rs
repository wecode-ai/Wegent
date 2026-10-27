//! Durable, content-free stand-in facts. Identity keys never leave this database.
use super::*;

const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MAX_EVENTS: i64 = 10_000;

pub(super) fn migrate(connection: &Connection) -> Result<(), TaskRuntimeError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS stand_in_telemetry_policy (
            user_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS stand_in_telemetry_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
            occurred_at INTEGER NOT NULL, event_name TEXT NOT NULL, properties TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS stand_in_telemetry_user_sequence
            ON stand_in_telemetry_events(user_id, sequence);
         CREATE TABLE IF NOT EXISTS stand_in_telemetry_runs (
            user_id INTEGER NOT NULL, task_id TEXT NOT NULL,
            run_id TEXT NOT NULL, phase TEXT NOT NULL, started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, waiting INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, task_id)
         );",
    )?;
    Ok(())
}

fn enabled(connection: &Connection, user: i64) -> Result<bool, TaskRuntimeError> {
    Ok(connection
        .query_row(
            "SELECT enabled FROM stand_in_telemetry_policy WHERE user_id=?1",
            [user],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(false))
}

fn prune(connection: &Connection, user: i64, at: i64) -> Result<(), TaskRuntimeError> {
    let expired = connection.execute(
        "DELETE FROM stand_in_telemetry_events WHERE user_id=?1 AND occurred_at<?2",
        params![user, at - RETENTION_MS],
    )?;
    let excess = connection.execute(
        "DELETE FROM stand_in_telemetry_events WHERE user_id=?1 AND sequence IN (
            SELECT sequence FROM stand_in_telemetry_events WHERE user_id=?1
            ORDER BY sequence DESC LIMIT -1 OFFSET ?2)",
        params![user, MAX_EVENTS],
    )?;
    connection.execute(
        "DELETE FROM stand_in_telemetry_runs WHERE user_id=?1 AND updated_at<?2",
        params![user, at - RETENTION_MS],
    )?;
    if expired + excess > 0 {
        crate::logging::log_executor_event(
            "stand-in telemetry queue pruned",
            &[("count", (expired + excess).to_string())],
        );
    }
    Ok(())
}

pub(super) fn append(
    connection: &Connection,
    user: i64,
    name: &str,
    properties: &Value,
    at: i64,
) -> Result<(), TaskRuntimeError> {
    if !enabled(connection, user)? {
        return Ok(());
    }
    connection.execute(
        "INSERT INTO stand_in_telemetry_events(user_id,event_id,occurred_at,event_name,properties)
         VALUES(?1,?2,?3,?4,?5)",
        params![
            user,
            Uuid::new_v4().to_string(),
            at,
            name,
            properties.to_string()
        ],
    )?;
    prune(connection, user, at)
}

pub(crate) fn origin_properties(origin: &Value) -> Value {
    let identity = if origin["standInId"] == "@primary"
        || (origin["standInId"].is_null() && origin["type"] == "stand_in_identity")
    {
        "primary"
    } else if origin["standInId"].is_string() {
        "role"
    } else {
        "unknown"
    };
    let source = match origin["type"].as_str() {
        Some("stand_in_identity") => "conversation",
        Some("issue_dispatch") => {
            if origin["projectStore"] == "cloud" {
                "cloud_project"
            } else {
                "local_project"
            }
        }
        Some("dingtalk_work") => "dingtalk",
        Some("connection_work") => {
            if origin["sourceProvider"] == personal_stand_in::DINGTALK_PROVIDER {
                "dingtalk"
            } else {
                "connection"
            }
        }
        _ => "unknown",
    };
    let trigger = if source == "conversation" {
        "conversation"
    } else if origin["manual"] == true || origin["trigger"] == "manual" {
        "manual"
    } else {
        "automatic"
    };
    json!({"domain":"stand_in","identity":identity,"source":source,"trigger":trigger,"executor_location":"unknown"})
}

impl LocalTaskStore {
    pub(crate) fn configure_stand_in_telemetry(
        &self,
        user: i64,
        allow: bool,
        enabled_since: Option<i64>,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO stand_in_telemetry_policy VALUES(?1,?2) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled", params![user, allow])?;
        if !allow {
            tx.execute(
                "DELETE FROM stand_in_telemetry_events WHERE user_id=?1",
                [user],
            )?;
            tx.execute(
                "DELETE FROM stand_in_telemetry_runs WHERE user_id=?1",
                [user],
            )?;
        }
        if allow {
            if let Some(since) = enabled_since {
                tx.execute(
                    "DELETE FROM stand_in_telemetry_events WHERE user_id=?1 AND occurred_at<?2",
                    params![user, since],
                )?;
                tx.execute(
                    "DELETE FROM stand_in_telemetry_runs WHERE user_id=?1 AND updated_at<?2",
                    params![user, since],
                )?;
            }
        }
        prune(&tx, user, Utc::now().timestamp_millis())?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn list_stand_in_telemetry(&self, user: i64) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        prune(&connection, user, Utc::now().timestamp_millis())?;
        let mut statement = connection.prepare("SELECT event_id,occurred_at,event_name,properties FROM stand_in_telemetry_events WHERE user_id=?1 ORDER BY sequence LIMIT 100")?;
        let items = statement.query_map([user], |row| {
            let raw: String = row.get(3)?;
            let properties = serde_json::from_str::<Value>(&raw).map_err(|error| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error)))?;
            Ok(json!({"id":row.get::<_,String>(0)?,"occurredAt":row.get::<_,i64>(1)?,"name":row.get::<_,String>(2)?,"properties":properties}))
        })?.collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"items":items}))
    }

    pub(crate) fn ack_stand_in_telemetry(
        &self,
        user: i64,
        ids: &[String],
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for id in ids {
            tx.execute(
                "DELETE FROM stand_in_telemetry_events WHERE user_id=?1 AND event_id=?2",
                params![user, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn record_stand_in_fact(
        &self,
        user: i64,
        name: &str,
        properties: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        append(
            &connection,
            user,
            name,
            properties,
            Utc::now().timestamp_millis(),
        )
    }

    pub(crate) fn observe_stand_in_run(
        &self,
        user: i64,
        task: &str,
        turn: &str,
        running: bool,
        waiting: bool,
        result: Option<&str>,
        properties: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !enabled(&tx, user)? {
            return Ok(());
        }
        let at = Utc::now().timestamp_millis();
        let previous: Option<(String,String,i64,bool)> = tx.query_row(
            "SELECT run_id,phase,started_at,waiting FROM stand_in_telemetry_runs WHERE user_id=?1 AND task_id=?2",
            params![user,task], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).optional()?;
        let prior = previous.clone();
        let was_waiting = previous.as_ref().is_some_and(|(_, _, _, waiting)| *waiting);
        let fresh = running
            && previous.as_ref().map_or(true, |(id, phase, _, _)| {
                (turn.is_empty() && phase == "completed")
                    || (!turn.is_empty() && !id.is_empty() && id != turn)
            });
        let (mut id, mut phase, started) = if fresh {
            append(&tx, user, "stand_in_execution_started", properties, at)?;
            (turn.to_owned(), "running".to_owned(), at)
        } else if let Some((id, phase, started, _)) = previous {
            (id, phase, started)
        } else {
            return Ok(());
        };
        if id.is_empty() && !turn.is_empty() {
            id = turn.to_owned();
        }
        if waiting && !was_waiting {
            append(&tx, user, "stand_in_execution_waiting", properties, at)?;
        }
        if !running && phase != "completed" {
            if let Some(result) = result {
                let mut end = properties.clone();
                end["result"] = json!(result);
                end["duration_ms"] = json!((at - started).clamp(0, RETENTION_MS));
                append(&tx, user, "stand_in_execution_completed", &end, at)?;
                phase = "completed".into();
            }
        }
        if !fresh
            && prior
                .as_ref()
                .is_some_and(|(old_id, old_phase, _, old_waiting)| {
                    old_id == &id && old_phase == &phase && *old_waiting == waiting
                })
        {
            return Ok(());
        }
        tx.execute("INSERT INTO stand_in_telemetry_runs VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(user_id,task_id) DO UPDATE SET run_id=excluded.run_id,phase=excluded.phase,started_at=excluded.started_at,updated_at=excluded.updated_at,waiting=excluded.waiting",params![user,task,id,phase,started,at,waiting])?;
        tx.commit()?;
        Ok(())
    }
}

pub(super) fn configuration_changes(
    connection: &Connection,
    user: i64,
    before: &Value,
    after: &Value,
) {
    let identities = |value: &Value| {
        let mut rows = value["roles"].as_array().cloned().unwrap_or_default();
        if value["primary"].is_object() {
            let mut primary = value["primary"].clone();
            primary["id"] = json!("@primary");
            rows.push(primary);
        }
        rows
    };
    let old = identities(before);
    let new = identities(after);
    for role in &new {
        let previous = old.iter().find(|row| row["id"] == role["id"]);
        let mut actions = Vec::new();
        if let Some(previous) = previous {
            if previous["enabled"] != role["enabled"] {
                actions.push(if role["enabled"] == true {
                    "enable"
                } else {
                    "disable"
                });
            }
            let references = |value: &Value| -> HashSet<String> {
                value["connections"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|source| {
                        json!([
                            source["providerId"],
                            source["profile"],
                            source["kind"],
                            source["id"]
                        ])
                        .to_string()
                    })
                    .chain(
                        value["collaboration"]["projects"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(Value::to_string),
                    )
                    .collect()
            };
            let left = references(previous);
            let right = references(role);
            if right.difference(&left).next().is_some() {
                actions.push("connect");
            }
            if left.difference(&right).next().is_some() {
                actions.push("disconnect");
            }
            if [
                "name",
                "prompt",
                "preferences",
                "model",
                "modelOptions",
                "workspace",
                "collaboration",
                "connections",
                "agentId",
                "agentProject",
            ]
            .iter()
            .any(|key| previous[*key] != role[*key])
            {
                actions.push("update");
            }
        } else {
            actions.push("create");
        }
        for action in actions {
            configuration_event(connection, user, &role["id"], action);
        }
    }
    for role in &old {
        if !new.iter().any(|row| row["id"] == role["id"]) {
            configuration_event(connection, user, &role["id"], "delete");
        }
    }
}

fn configuration_event(connection: &Connection, user: i64, id: &Value, action: &str) {
    let mut properties = origin_properties(&json!({"standInId":id,"manual":true}));
    properties["action"] = json!(action);
    if append(
        connection,
        user,
        "stand_in_configuration_succeeded",
        &properties,
        Utc::now().timestamp_millis(),
    )
    .is_err()
    {
        crate::logging::log_executor_event("stand-in configuration telemetry failed", &[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, LocalTaskStore) {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        (root, store)
    }
    fn properties() -> Value {
        origin_properties(
            &json!({"type":"issue_dispatch","projectStore":"local","standInId":"role"}),
        )
    }
    fn facts(store: &LocalTaskStore, user: i64) -> Vec<Value> {
        store.list_stand_in_telemetry(user).unwrap()["items"]
            .as_array()
            .unwrap()
            .clone()
    }

    #[test]
    fn stand_in_telemetry_is_opt_in_and_account_scoped() {
        let (_root, store) = fixture();
        store
            .record_stand_in_fact(7, "stand_in_execution_started", &properties())
            .unwrap();
        assert!(facts(&store, 7).is_empty());
        store.configure_stand_in_telemetry(7, true, None).unwrap();
        store
            .record_stand_in_fact(7, "stand_in_execution_started", &properties())
            .unwrap();
        assert_eq!(facts(&store, 7).len(), 1);
        assert!(facts(&store, 8).is_empty());
        let id = facts(&store, 7)[0]["id"].as_str().unwrap().to_owned();
        store
            .ack_stand_in_telemetry(8, std::slice::from_ref(&id))
            .unwrap();
        assert_eq!(facts(&store, 7).len(), 1);
        store.configure_stand_in_telemetry(7, false, None).unwrap();
        assert!(facts(&store, 7).is_empty());
        store.configure_stand_in_telemetry(7, true, None).unwrap();
        assert!(facts(&store, 7).is_empty());
    }

    #[test]
    fn stand_in_telemetry_persists_and_ack_is_idempotent() {
        let (root, store) = fixture();
        store.configure_stand_in_telemetry(7, true, None).unwrap();
        store
            .observe_stand_in_run(7, "private-task", "turn", true, false, None, &properties())
            .unwrap();
        drop(store);
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        store
            .observe_stand_in_run(
                7,
                "private-task",
                "turn",
                false,
                false,
                Some("success"),
                &properties(),
            )
            .unwrap();
        let initial = facts(&store, 7);
        assert_eq!(initial.len(), 2);
        assert!(initial[1]["properties"]["duration_ms"].as_i64().unwrap() >= 0);
        assert!(!serde_json::to_string(&initial)
            .unwrap()
            .contains("private-task"));
        assert_eq!(facts(&store, 7), initial);
        let ids = initial
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        store.ack_stand_in_telemetry(7, &ids).unwrap();
        store.ack_stand_in_telemetry(7, &ids).unwrap();
        assert!(facts(&store, 7).is_empty());
    }

    #[test]
    fn stand_in_telemetry_deduplicates_native_turns_and_tracks_waiting_and_retry() {
        let (_root, store) = fixture();
        store.configure_stand_in_telemetry(7, true, None).unwrap();
        let observe = |turn, running, waiting, result| {
            store
                .observe_stand_in_run(7, "task", turn, running, waiting, result, &properties())
                .unwrap()
        };
        observe("", true, false, None);
        observe("one", true, false, None);
        observe("one", true, false, None);
        observe("one", true, true, None);
        observe("one", true, true, None);
        observe("one", true, false, None);
        observe("one", false, false, Some("failure"));
        observe("one", false, false, Some("failure"));
        observe("one", true, false, None);
        observe("two", true, false, None);
        observe("two", false, false, Some("cancelled"));
        let rows = facts(&store, 7);
        assert_eq!(
            rows.iter()
                .map(|row| row["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "stand_in_execution_started",
                "stand_in_execution_waiting",
                "stand_in_execution_completed",
                "stand_in_execution_started",
                "stand_in_execution_completed",
            ]
        );
        assert_eq!(rows[2]["properties"]["result"], "failure");
        assert_eq!(rows[4]["properties"]["result"], "cancelled");
    }

    #[test]
    fn stand_in_telemetry_completion_before_waiting_is_not_lost_or_duplicated() {
        let (_root, store) = fixture();
        store.configure_stand_in_telemetry(7, true, None).unwrap();
        for (running, waiting, result) in [
            (true, false, None),
            (false, false, Some("success")),
            (false, true, Some("success")),
            (false, true, Some("success")),
        ] {
            store
                .observe_stand_in_run(7, "task", "turn", running, waiting, result, &properties())
                .unwrap();
        }
        assert_eq!(facts(&store, 7).len(), 3);
    }

    #[test]
    fn stand_in_telemetry_configuration_diff_ignores_versions_and_rolls_back_proposals() {
        let (_root, store) = fixture();
        store.configure_stand_in_telemetry(7, true, None).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"][0]["enabled"] = json!(true);
        let saved = store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert_eq!(facts(&store, 7).len(), 1);
        assert_eq!(facts(&store, 7)[0]["properties"]["action"], "enable");
        store
            .save_personal_stand_in(7, "mac", saved.clone())
            .unwrap();
        assert_eq!(facts(&store, 7).len(), 1);
        let connection = store.connection().unwrap();
        let changed = json!({"roles":[]});
        connection.execute_batch("SAVEPOINT proposal").unwrap();
        configuration_changes(&connection, 7, &saved, &changed);
        connection
            .execute_batch("ROLLBACK TO proposal; RELEASE proposal")
            .unwrap();
        drop(connection);
        assert_eq!(facts(&store, 7).len(), 1);
    }

    #[test]
    fn stand_in_telemetry_pages_and_bounds_retention() {
        let (_root, store) = fixture();
        store.configure_stand_in_telemetry(7, true, None).unwrap();
        let connection = store.connection().unwrap();
        let at = Utc::now().timestamp_millis();
        connection.execute("INSERT INTO stand_in_telemetry_events(user_id,event_id,occurred_at,event_name,properties) VALUES(7,'expired',?1,'stand_in_execution_started','{}')",[at-RETENTION_MS-1]).unwrap();
        for _ in 0..105 {
            append(
                &connection,
                7,
                "stand_in_execution_started",
                &properties(),
                at,
            )
            .unwrap();
        }
        drop(connection);
        let first = facts(&store, 7);
        assert_eq!(first.len(), 100);
        assert!(first.iter().all(|row| row["id"] != "expired"));
        let ids = first
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        store.ack_stand_in_telemetry(7, &ids).unwrap();
        assert_eq!(facts(&store, 7).len(), 5);
    }
}

#[cfg(test)]
mod consent_tests {
    use super::*;
    #[test]
    fn stand_in_telemetry_drops_offline_facts_from_before_consent_was_renewed() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        store.configure_stand_in_telemetry(7, true, None).unwrap();
        let connection = store.connection().unwrap();
        let at = Utc::now().timestamp_millis();
        append(
            &connection,
            7,
            "stand_in_execution_started",
            &json!({}),
            at - 1000,
        )
        .unwrap();
        append(
            &connection,
            7,
            "stand_in_execution_completed",
            &json!({}),
            at,
        )
        .unwrap();
        drop(connection);
        store
            .configure_stand_in_telemetry(7, true, Some(at))
            .unwrap();
        let rows = store.list_stand_in_telemetry(7).unwrap();
        assert_eq!(rows["items"].as_array().unwrap().len(), 1);
        assert_eq!(rows["items"][0]["name"], "stand_in_execution_completed");
    }
}

#[cfg(test)]
mod retention_tests {
    use super::*;

    #[test]
    fn stand_in_telemetry_history_refresh_does_not_extend_completed_run_retention() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        store.configure_stand_in_telemetry(7, true, None).unwrap();
        let properties = origin_properties(&json!({"type":"stand_in_identity"}));
        store
            .observe_stand_in_run(7, "task", "turn", true, false, None, &properties)
            .unwrap();
        store
            .observe_stand_in_run(
                7,
                "task",
                "turn",
                false,
                false,
                Some("success"),
                &properties,
            )
            .unwrap();
        {
            let connection = store.connection().unwrap();
            connection
                .execute(
                    "UPDATE stand_in_telemetry_runs SET updated_at=?1",
                    [Utc::now().timestamp_millis() - RETENTION_MS - 1],
                )
                .unwrap();
        }
        store
            .observe_stand_in_run(
                7,
                "task",
                "turn",
                false,
                false,
                Some("success"),
                &properties,
            )
            .unwrap();
        store.list_stand_in_telemetry(7).unwrap();
        let count: i64 = store
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM stand_in_telemetry_runs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
