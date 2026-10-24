//! User-owned, versioned memories are independent of Codex threads and profile permissions.
use super::personal_stand_in::{read_personal, role_project_matches, stand_in_identities};
use super::*;

impl LocalTaskStore {
    pub fn visible_stand_in_memories(
        &self,
        user: i64,
        role: Option<&str>,
        source: Option<&Value>,
        manage: bool,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let role = role.filter(|id| *id != "@primary");
        Ok(self
            .stand_in_memories(user)?
            .into_iter()
            .filter(|row| {
                let scope = &row["scope"];
                (manage && role.is_none())
                    || (source.is_none()
                        && (scope["kind"] == "personal"
                            || (scope["kind"] == "role" && scope["roleId"].as_str() == role)))
                    || source.is_some_and(|source| scope == source)
            })
            .collect())
    }

    pub fn stand_in_memories(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?1 ORDER BY updated_at DESC,id")?;
        let rows = statement.query_map(params![user], |row| row.get::<_, String>(0))?;
        rows.map(|raw| {
            serde_json::from_str(&raw?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect()
    }

    pub fn save_stand_in_memory(
        &self,
        user: i64,
        device: &str,
        input: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let content = input["content"]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty() && text.len() <= 4000)
            .ok_or_else(|| {
                TaskRuntimeError::Invalid("Memory content must contain 1–4000 bytes".into())
            })?;
        let scope = &input["scope"];
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let settings = read_personal(&connection, user, device)?;
        if !valid_scope(&settings, scope) {
            return Err(TaskRuntimeError::Invalid(
                "Memory scope is not connected to this stand-in".into(),
            ));
        }
        let id = input["id"].as_str().unwrap_or_default();
        let key = if id.is_empty() {
            format!("stand-in-memory:{}", Uuid::new_v4())
        } else {
            id.to_owned()
        };
        let previous = get_item_from(&connection, &key, "stand_in_memory")?.map(|row| row.metadata);
        if !id.is_empty() && previous.as_ref().is_none_or(|row| row["userId"] != user) {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        let version = previous
            .as_ref()
            .and_then(|row| row["version"].as_i64())
            .unwrap_or(0);
        if input["version"].as_i64().unwrap_or(0) != version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if previous.is_none() {
            let count: i64 = connection.query_row("SELECT count(*) FROM loop_items WHERE resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?1", params![user], |row| row.get(0))?;
            if count >= 1000 {
                return Err(TaskRuntimeError::Invalid(
                    "Memory limit reached; remove unused memories first".into(),
                ));
            }
        }
        let timestamp = now();
        let source = previous
            .as_ref()
            .map(|row| row["sourceTaskId"].clone())
            .unwrap_or_else(|| {
                input["sourceTaskId"]
                    .as_str()
                    .map(|id| json!(id.chars().take(256).collect::<String>()))
                    .unwrap_or(Value::Null)
            });
        let row = json!({"id":key,"userId":user,"scope":scope,"content":content,"version":version+1,"sourceTaskId":source,"createdAt":previous.as_ref().map(|row|row["createdAt"].clone()).unwrap_or(json!(timestamp)),"updatedAt":timestamp});
        connection.execute("INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_memory',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at", params![key,row.to_string(),timestamp])?;
        connection.commit()?;
        Ok(row)
    }

    pub fn delete_stand_in_memory(
        &self,
        user: i64,
        id: &str,
        version: i64,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let removed = connection.execute("DELETE FROM loop_items WHERE id=?1 AND resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?2 AND json_extract(metadata,'$.version')=?3",params![id,user,version])?;
        if removed != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        Ok(())
    }
}

fn valid_scope(settings: &Value, scope: &Value) -> bool {
    match scope["kind"].as_str() {
        Some("personal") => scope.as_object().is_some_and(|row| row.len() == 1),
        Some("role") => {
            scope.as_object().is_some_and(|row| row.len() == 2)
                && settings["roles"]
                    .as_array()
                    .is_some_and(|roles| roles.iter().any(|role| role["id"] == scope["roleId"]))
        }
        Some("project") => {
            scope["id"].as_str().is_some_and(|id| !id.is_empty())
                && matches!(scope["store"].as_str(), Some("local" | "cloud"))
                && stand_in_identities(settings).iter().any(|role| {
                    role_project_matches(
                        role,
                        scope["id"].as_str().unwrap(),
                        scope["store"].as_str().unwrap(),
                    )
                })
        }
        Some("dingtalk") => stand_in_identities(settings).iter().any(|role| {
            role["dingtalk"].as_array().is_some_and(|rows| {
                rows.iter().any(|row| {
                    row["id"] == scope["id"]
                        && row["profile"] == scope["profile"]
                        && row["kind"] == scope["conversationKind"]
                })
            })
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stand_in_memories_persist_isolate_users_and_reject_stale_edits() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.db");
        let store = LocalTaskStore::open(&path).unwrap();
        let row = store.save_stand_in_memory(1,"device",json!({"scope":{"kind":"personal"},"content":"Prefer concise Chinese","sourceTaskId":"chat-1"})).unwrap();
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        assert_eq!(store.stand_in_memories(1).unwrap(), vec![row.clone()]);
        assert!(store.stand_in_memories(2).unwrap().is_empty());
        let mut updated = row.clone();
        updated["content"] = json!("Prefer detailed Chinese");
        assert!(store
            .save_stand_in_memory(2, "device", updated.clone())
            .is_err());
        let saved = store
            .save_stand_in_memory(1, "device", updated.clone())
            .unwrap();
        assert!(store.save_stand_in_memory(1, "device", updated).is_err());
        assert!(store
            .delete_stand_in_memory(1, row["id"].as_str().unwrap(), 1)
            .is_err());
        store
            .delete_stand_in_memory(1, saved["id"].as_str().unwrap(), 2)
            .unwrap();
        assert!(store.stand_in_memories(1).unwrap().is_empty());
    }

    #[test]
    fn stand_in_memories_reject_unknown_roles_connections_and_empty_content() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.db")).unwrap();
        for scope in [
            json!({"kind":"role","roleId":"missing"}),
            json!({"kind":"dingtalk","id":"unknown"}),
            json!({"kind":"project","id":"unknown","store":"local"}),
        ] {
            assert!(store
                .save_stand_in_memory(1, "device", json!({"scope":scope,"content":"test"}))
                .is_err());
        }
        assert!(store
            .save_stand_in_memory(
                1,
                "device",
                json!({"scope":{"kind":"personal"},"content":" "})
            )
            .is_err());
    }

    #[test]
    fn stand_in_memories_only_expose_personal_own_role_and_exact_source() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.db")).unwrap();
        let connection = store.connection().unwrap();
        for (id, scope) in [
            ("personal", json!({"kind":"personal"})),
            ("role-a", json!({"kind":"role","roleId":"a"})),
            ("role-b", json!({"kind":"role","roleId":"b"})),
            (
                "group-one",
                json!({"kind":"dingtalk","id":"one","profile":"me","conversationKind":"group"}),
            ),
            (
                "group-two",
                json!({"kind":"dingtalk","id":"two","profile":"me","conversationKind":"group"}),
            ),
        ] {
            connection.execute("INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_memory',?2,?3,?3)",params![id,json!({"id":id,"userId":1,"scope":scope,"content":id}).to_string(),now()]).unwrap();
        }
        drop(connection);
        let source =
            json!({"kind":"dingtalk","id":"one","profile":"me","conversationKind":"group"});
        let rows = store
            .visible_stand_in_memories(1, Some("a"), Some(&source), false)
            .unwrap();
        let ids: HashSet<_> = rows.iter().map(|row| row["id"].as_str().unwrap()).collect();
        assert_eq!(ids, HashSet::from(["group-one"]));
        assert_eq!(
            store
                .visible_stand_in_memories(1, None, None, false)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .visible_stand_in_memories(1, None, None, true)
                .unwrap()
                .len(),
            5
        );
    }

    #[test]
    fn deleting_last_role_keeps_primary_memories_and_does_not_recreate_default_role() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.db");
        let store = LocalTaskStore::open(&path).unwrap();
        let memory = store
            .save_stand_in_memory(
                1,
                "device",
                json!({"scope":{"kind":"personal"},"content":"Keep this preference"}),
            )
            .unwrap();
        let mut settings = store.personal_stand_in(1, "device").unwrap();
        settings["primary"] =
            json!({"enabled":true,"prompt":"Coordinate work","preferences":"Concise"});
        settings["roles"] = json!([]);
        let saved = store.save_personal_stand_in(1, "device", settings).unwrap();
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let read = store.personal_stand_in(1, "device").unwrap();
        assert_eq!(read, saved);
        assert_eq!(read["roles"], json!([]));
        assert_eq!(store.stand_in_memories(1).unwrap(), vec![memory]);
    }
}
