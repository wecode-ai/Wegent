//! User-owned, versioned memories are independent of Codex threads and profile permissions.
use super::personal_stand_in::{read_personal, role_project_matches, stand_in_identities};
use super::*;
use sha2::{Digest, Sha256};

#[cfg(test)]
#[path = "stand_in_memory_recall_tests.rs"]
mod recall_tests;

#[cfg(test)]
#[path = "stand_in_memory_suppression_tests.rs"]
mod suppression_tests;

#[path = "stand_in_memory_rules.rs"]
mod rules;
use rules::suppress_memory;

fn forgotten_key(user: i64, scope: &Value, content: &str) -> String {
    // Scope key order must not change the identity of a forgotten fact.
    let scope: std::collections::BTreeMap<_, _> = scope.as_object().into_iter().flatten().collect();
    let fingerprint = Sha256::digest(json!([user, scope, content.trim()]).to_string());
    format!("stand-in-forgotten:{fingerprint:x}")
}

fn forgotten_evidence_key(user: i64, evidence: &Value) -> Option<String> {
    let task = evidence["taskId"].as_str()?;
    let message = evidence["messageId"].as_str()?;
    let fingerprint = Sha256::digest(json!([user, task, message]).to_string());
    Some(format!("stand-in-forgotten-evidence:{fingerprint:x}"))
}

impl LocalTaskStore {
    pub fn recall_stand_in_memories(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
        source: Option<&Value>,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        self.recall_stand_in_rows(user, device, role, source, self.stand_in_memories(user)?)
    }

    fn recall_stand_in_rows(
        &self,
        user: i64,
        device: &str,
        role: Option<&str>,
        source: Option<&Value>,
        rows: Vec<Value>,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let mut settings = self.personal_stand_in(user, device)?;
        let primary = role.map_or(true, |id| id == "@primary") && source.is_none();
        if !primary {
            if let Some(role) = role.filter(|id| *id != "@primary") {
                settings["roles"] = json!(settings["roles"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|row| row["id"] == role)
                    .cloned()
                    .collect::<Vec<_>>());
                settings["primary"] = Value::Null;
            } else if source.is_some_and(|scope| scope["kind"] != "project_coordinator") {
                settings["roles"] = json!([]);
            }
        }
        // Owner conversations may recall every source granted to this identity.
        // Source-bound work remains restricted to its exact source, and the
        // current role's grants below still exclude other identities' sources.
        let candidates = if source.is_none() {
            rows
        } else {
            visible_memory_rows(rows, role, source, false)
        };
        Ok(candidates
            .into_iter()
            .filter(|row| valid_scope(&settings, &row["scope"]))
            .filter(|row| {
                let scope = &row["scope"];
                // The project-bound caller is authorized by its project host.
                // Personal recall cannot borrow that separate authority merely
                // because the same user owns a coordinator memory record.
                scope["kind"] != "project_coordinator"
                    || source == Some(scope)
                    || project_scope_connected(&settings, scope)
            })
            .collect())
    }

    pub fn active_stand_in_memories(
        &self,
        user: i64,
        device: &str,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        self.recall_stand_in_memories(user, device, None, None)
    }

    pub fn page_stand_in_memories(
        memories: Vec<Value>,
        query: &str,
        cursor: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let query = query.to_lowercase();
        let matches: Vec<_> = memories
            .into_iter()
            .filter(|row| {
                row["content"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&query)
            })
            .collect();
        let fingerprint = format!("{:x}", Sha256::digest(json!([query, matches]).to_string()));
        let invalid = || {
            TaskRuntimeError::Invalid(
                "Memory search changed or cursor is invalid; restart without a cursor".into(),
            )
        };
        let (start, content_offset) = if let Some(cursor) = cursor {
            let decoded = cursor
                .strip_prefix("memory:v1:")
                .filter(|_| cursor.len() <= 1024)
                .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .ok_or_else(invalid)?;
            if decoded["fingerprint"] != fingerprint {
                return Err(invalid());
            }
            let start = decoded["offset"]
                .as_u64()
                .filter(|offset| *offset <= matches.len() as u64)
                .ok_or_else(invalid)? as usize;
            let content_offset = match decoded.get("contentOffset") {
                None => 0,
                Some(value) => value
                    .as_u64()
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(invalid)?,
            };
            (start, content_offset)
        } else {
            (0, 0)
        };
        let cursor_for = |offset, content_offset| {
            format!(
            "memory:v1:{}",
            URL_SAFE_NO_PAD.encode(json!({"fingerprint":fingerprint,"offset":offset,"contentOffset":content_offset}).to_string())
        )
        };
        if content_offset > 0 && start == matches.len() {
            return Err(invalid());
        }
        let mut items = Vec::new();
        let mut bytes = 1024;
        for row in matches.iter().skip(start).take(50) {
            let size = row.to_string().len();
            if bytes + size > 16000 {
                if items.is_empty() {
                    let text = row.to_string();
                    if content_offset >= text.len() || !text.is_char_boundary(content_offset) {
                        return Err(invalid());
                    }
                    // Budget the serialized string, including JSON escaping, not
                    // merely the source bytes. Never drop an oversized record.
                    let mut end = content_offset.saturating_add(8192).min(text.len());
                    loop {
                        while !text.is_char_boundary(end) {
                            end -= 1;
                        }
                        if json!(&text[content_offset..end]).to_string().len() <= 12000 {
                            break;
                        }
                        end = content_offset + (end - content_offset) / 2;
                    }
                    let complete = end == text.len();
                    let next = if !complete {
                        Some(cursor_for(start, end))
                    } else if start + 1 < matches.len() {
                        Some(cursor_for(start + 1, 0))
                    } else {
                        None
                    };
                    return Ok(
                        json!({"items":[],"itemChunk":{"content":&text[content_offset..end],"offset":content_offset,"totalContentBytes":text.len(),"complete":complete},"nextCursor":next,"totalCount":matches.len()}),
                    );
                }
                break;
            }
            if content_offset != 0 {
                return Err(invalid());
            }
            bytes += size;
            items.push(row.clone());
        }
        let end = start + items.len();
        let next = (end < matches.len()).then(|| cursor_for(end, 0));
        Ok(json!({"items":items,"nextCursor":next,"totalCount":matches.len()}))
    }

    pub fn visible_stand_in_memories(
        &self,
        user: i64,
        role: Option<&str>,
        source: Option<&Value>,
        manage: bool,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        Ok(visible_memory_rows(
            self.stand_in_memories(user)?,
            role,
            source,
            manage,
        ))
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
        let mut key = if id.is_empty() {
            format!("stand-in-memory:{}", Uuid::new_v4())
        } else {
            id.to_owned()
        };
        let mut previous =
            get_item_from(&connection, &key, "stand_in_memory")?.map(|row| row.metadata);
        if !id.is_empty() && previous.as_ref().map_or(true, |row| row["userId"] != user) {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        let mut version = previous
            .as_ref()
            .and_then(|row| row["version"].as_i64())
            .unwrap_or(0);
        if input["version"].as_i64().unwrap_or(0) != version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let forgotten = forgotten_key(user, scope, content);
        if input["restoreForgotten"] == true {
            let id = forgotten.replace("stand-in-forgotten:", "stand-in-forgetting-rule:");
            if let Some(rule) = get_item_from(&connection, &id, "stand_in_memory_rule")? {
                rules::remove_rule(&connection, user, &rule.metadata)?;
            }
        }
        if get_item_from(&connection, &forgotten, "stand_in_memory_tombstone")?.is_some() {
            if input["restoreForgotten"] != true {
                return Err(TaskRuntimeError::MemorySuppressed);
            }
            connection.execute(
                "DELETE FROM loop_items WHERE id=?1 AND resource_type='stand_in_memory_tombstone'",
                params![forgotten],
            )?;
        }
        for key in forgotten_evidence_key(user, &input["evidence"]).into_iter() {
            if get_item_from(&connection, &key, "stand_in_memory_tombstone")?.is_some() {
                if input["restoreForgotten"] != true {
                    return Err(TaskRuntimeError::MemorySuppressed);
                }
                connection.execute("DELETE FROM loop_items WHERE id=?1 AND resource_type='stand_in_memory_tombstone'", params![key])?;
            }
        }
        if previous.is_none() {
            // Repeated extraction of the same fact must not grow the memory store.
            // Compare parsed scopes: JSON object key order is not scope identity.
            let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.content')=?2 ORDER BY updated_at DESC,id")?;
            let rows =
                statement.query_map(params![user, content], |row| row.get::<_, String>(0))?;
            for raw in rows {
                let existing: Value = serde_json::from_str(&raw?)
                    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
                if existing["scope"] == *scope {
                    if !existing["evidence"].is_null() || input["evidence"].is_null() {
                        return Ok(existing);
                    }
                    // Enrich an existing fact without creating a duplicate or
                    // replacing an already recorded source during replay.
                    key = existing["id"].as_str().unwrap().to_owned();
                    version = existing["version"].as_i64().unwrap_or(0);
                    previous = Some(existing);
                    break;
                }
            }
            let count: i64 = connection.query_row("SELECT count(*) FROM loop_items WHERE resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?1", params![user], |row| row.get(0))?;
            if previous.is_none() && count >= 1000 {
                return Err(TaskRuntimeError::Invalid(
                    "Memory limit reached; remove unused memories first".into(),
                ));
            }
        }
        let timestamp = now();
        let changed = previous
            .as_ref()
            .is_some_and(|row| row["content"] != content || row["scope"] != *scope);
        if let Some(previous) = &previous {
            if changed {
                suppress_memory(&connection, user, previous)?;
            }
        }
        let mut source = input["sourceTaskId"]
            .as_str()
            .map(|id| json!(id.chars().take(256).collect::<String>()))
            .or_else(|| previous.as_ref().map(|row| row["sourceTaskId"].clone()))
            .unwrap_or(Value::Null);
        let mut evidence = input.get("evidence").cloned().or_else(|| {
            previous
                .as_ref()
                .and_then(|row| row.get("evidence").cloned())
        });
        // Panel edits carry the displayed row, including its old evidence.
        // That excerpt must not be presented as proof of a newly edited fact.
        if changed && input["restoreForgotten"] == true {
            source = Value::Null;
            evidence = None;
        } else if changed && !input["evidence"].is_object() {
            evidence = None;
        }
        if evidence
            .as_ref()
            .is_some_and(|value| value.to_string().len() > 8000)
        {
            return Err(TaskRuntimeError::Invalid(
                "Memory evidence exceeds 8000 bytes".into(),
            ));
        }
        let row = json!({"id":key,"userId":user,"scope":scope,"content":content,"version":version+1,"sourceTaskId":source,"evidence":evidence,"createdAt":previous.as_ref().map(|row|row["createdAt"].clone()).unwrap_or(json!(timestamp)),"updatedAt":timestamp});
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
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = get_item_from(&connection, id, "stand_in_memory")?
            .filter(|row| row.metadata["userId"] == user && row.metadata["version"] == version)
            .ok_or(TaskRuntimeError::VersionConflict)?;
        suppress_memory(&connection, user, &previous.metadata)?;
        let removed = connection.execute("DELETE FROM loop_items WHERE id=?1 AND resource_type='stand_in_memory' AND json_extract(metadata,'$.userId')=?2 AND json_extract(metadata,'$.version')=?3",params![id,user,version])?;
        if removed != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        connection.commit()?;
        Ok(())
    }
}

fn visible_memory_rows(
    rows: Vec<Value>,
    role: Option<&str>,
    source: Option<&Value>,
    manage: bool,
) -> Vec<Value> {
    let role = role.filter(|id| *id != "@primary");
    rows.into_iter()
        .filter(|row| {
            let scope = &row["scope"];
            (manage && role.is_none())
                || (source.is_none()
                    && (scope["kind"] == "personal"
                        || (scope["kind"] == "role" && scope["roleId"].as_str() == role)))
                || source.is_some_and(|source| scope == source)
        })
        .collect()
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
        Some("project_coordinator") => {
            scope.as_object().is_some_and(|row| row.len() == 3)
                && scope["id"].as_str().is_some_and(|id| !id.trim().is_empty())
                && matches!(scope["store"].as_str(), Some("local" | "cloud"))
        }
        Some("project") => {
            scope["id"].as_str().is_some_and(|id| !id.is_empty())
                && matches!(scope["store"].as_str(), Some("local" | "cloud"))
                && project_scope_connected(settings, scope)
        }
        Some("dingtalk" | "connection") => stand_in_identities(settings).iter().any(|role| {
            role["connections"].as_array().is_some_and(|rows| {
                rows.iter().any(|row| {
                    let mut expected = super::personal_stand_in::connection_memory_scope(row);
                    if row["scope"] == "all"
                        && scope["id"]
                            .as_str()
                            .is_some_and(|id| !id.is_empty() && id != "*")
                    {
                        expected["id"] = scope["id"].clone();
                    }
                    expected == *scope
                })
            })
        }),
        _ => false,
    }
}

fn project_scope_connected(settings: &Value, scope: &Value) -> bool {
    let (Some(id), Some(store)) = (scope["id"].as_str(), scope["store"].as_str()) else {
        return false;
    };
    stand_in_identities(settings)
        .iter()
        .any(|role| role_project_matches(role, id, store))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_recall_requires_a_current_grant_for_project_coordinator_memories() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.db")).unwrap();
        store.materialize_implicit_primary(7, "mac").unwrap();
        let scope = json!({"kind":"project_coordinator","id":"p","store":"local"});
        let saved = store
            .save_stand_in_memory(
                7,
                "mac",
                json!({
                    "scope":scope,"content":"Release reviews require the project lead."
                }),
            )
            .unwrap();
        assert!(store.active_stand_in_memories(7, "mac").unwrap().is_empty());
        assert_eq!(
            store
                .recall_stand_in_memories(7, "mac", None, Some(&scope))
                .unwrap(),
            vec![saved.clone()]
        );
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"]["collaboration"] = json!({"enabled":true,"allProjects":false,"projects":[{"id":"p","store":"cloud"}],"excludedProjects":[],"tags":[]});
        let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert!(store.active_stand_in_memories(7, "mac").unwrap().is_empty());
        settings["primary"]["collaboration"]["projects"][0]["store"] = json!("local");
        let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert_eq!(
            store.active_stand_in_memories(7, "mac").unwrap(),
            vec![saved.clone()]
        );
        settings["primary"]["collaboration"]["excludedProjects"] =
            json!([{"id":"p","store":"local"}]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert!(store.active_stand_in_memories(7, "mac").unwrap().is_empty());
        assert_eq!(store.stand_in_memories(7).unwrap(), vec![saved.clone()]);
        store
            .delete_stand_in_memory(7, saved["id"].as_str().unwrap(), 1)
            .unwrap();
        assert!(store.stand_in_memories(7).unwrap().is_empty());
    }

    #[test]
    fn memory_search_chunks_oversized_saved_records_without_losing_later_matches() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.db")).unwrap();
        let large = store.save_stand_in_memory(7,"mac",json!({
            "scope":{"kind":"personal"},"content":format!("{}中文", "\u{0001}".repeat(3990)),
            "evidence":{"excerpt":"证".repeat(2500)}
        })).unwrap();
        assert!(large.to_string().len() > 16000);
        let rows = vec![large.clone(), json!({"id":"next","content":"Next fact"})];
        let mut cursor = None;
        let mut reconstructed = String::new();
        let mut collected = Vec::new();
        let mut first_cursor = None;
        loop {
            let page = LocalTaskStore::page_stand_in_memories(rows.clone(), "", cursor.as_deref())
                .unwrap();
            assert!(page.to_string().len() <= 16000);
            if let Some(part) = page.get("itemChunk") {
                assert_eq!(
                    part["offset"].as_u64().unwrap() as usize,
                    reconstructed.len()
                );
                reconstructed.push_str(part["content"].as_str().unwrap());
                if part["complete"] == true {
                    collected.push(serde_json::from_str::<Value>(&reconstructed).unwrap());
                }
            }
            collected.extend(page["items"].as_array().unwrap().iter().cloned());
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if first_cursor.is_none() {
                first_cursor = cursor.clone();
            }
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(collected, rows);
        let mut changed = rows.clone();
        changed[0]["content"] = json!("corrected");
        assert!(
            LocalTaskStore::page_stand_in_memories(changed, "", first_cursor.as_deref()).is_err()
        );
        assert!(
            LocalTaskStore::page_stand_in_memories(rows, "Next", first_cursor.as_deref()).is_err()
        );
    }

    #[test]
    fn memory_search_pages_cover_every_match_with_bounded_evidence() {
        for evidence_size in [0, 2500] {
            let rows: Vec<_> = (0..123).map(|id| json!({
                "id":id,"content":"Weekly 偏好","evidence":{"excerpt":"据".repeat(evidence_size)}
            })).collect();
            let mut cursor = None;
            let mut collected = Vec::new();
            loop {
                let page = LocalTaskStore::page_stand_in_memories(
                    rows.clone(),
                    "WEEKLY",
                    cursor.as_deref(),
                )
                .unwrap();
                assert!(page.to_string().len() <= 16000);
                assert_eq!(page["totalCount"], 123);
                let items = page["items"].as_array().unwrap();
                assert!(!items.is_empty());
                assert!(items.len() <= 50);
                collected.extend(items.iter().cloned());
                cursor = page["nextCursor"].as_str().map(str::to_owned);
                if cursor.is_none() {
                    break;
                }
            }
            assert_eq!(collected, rows);
        }
    }

    #[test]
    fn memory_search_rejects_changed_results_query_and_invalid_cursors() {
        let rows: Vec<_> = (0..51)
            .map(|id| json!({"id":id,"content":"Weekly report"}))
            .collect();
        let page = LocalTaskStore::page_stand_in_memories(rows.clone(), "weekly", None).unwrap();
        let cursor = page["nextCursor"].as_str().unwrap();
        let next =
            LocalTaskStore::page_stand_in_memories(rows.clone(), "WEEKLY", Some(cursor)).unwrap();
        assert_eq!(next["items"], json!([rows[50]]));
        assert!(next["nextCursor"].is_null());
        let mut changed = rows.clone();
        changed[0]["content"] = json!("Weekly corrected report");
        for dataset in [changed, rows[1..].to_vec()] {
            assert!(
                LocalTaskStore::page_stand_in_memories(dataset, "weekly", Some(cursor)).is_err()
            );
        }
        assert!(
            LocalTaskStore::page_stand_in_memories(rows.clone(), "report", Some(cursor)).is_err()
        );
        for cursor in ["", "memory:v1:!", "memory:v1:e30", "unrecognized"] {
            assert!(
                LocalTaskStore::page_stand_in_memories(rows.clone(), "weekly", Some(cursor))
                    .is_err()
            );
        }
        let empty = LocalTaskStore::page_stand_in_memories(rows, "missing", None).unwrap();
        assert_eq!(empty, json!({"items":[],"nextCursor":null,"totalCount":0}));
    }

    #[test]
    fn forgotten_evidence_blocks_paraphrases_but_allows_new_statements() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.db")).unwrap();
        let mut input = json!({"scope":{"kind":"personal"},"content":"Prefer concise weekly reports",
            "evidence":{"taskId":"chat","messageId":"first","excerpt":"Keep my weekly reports short"}});
        let saved = store
            .save_stand_in_memory(1, "device", input.clone())
            .unwrap();
        assert_eq!(saved["evidence"], input["evidence"]);
        store
            .delete_stand_in_memory(1, saved["id"].as_str().unwrap(), 1)
            .unwrap();
        input["content"] = json!("Weekly reports should be brief");
        assert!(matches!(
            store.save_stand_in_memory(1, "device", input.clone()),
            Err(TaskRuntimeError::MemorySuppressed)
        ));
        input["evidence"]["messageId"] = json!("new-user-statement");
        assert!(store.save_stand_in_memory(1, "device", input).is_ok());
    }

    #[test]
    fn forgotten_and_corrected_facts_cannot_be_recreated_by_replaying_history() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.db");
        let store = LocalTaskStore::open(&path).unwrap();
        let input = json!({"scope":{"kind":"personal"},"content":"Birch owner is Lin"});
        let mut row = store
            .save_stand_in_memory(1, "device", input.clone())
            .unwrap();
        row["content"] = json!("Birch owner is Zhou");
        let corrected = store.save_stand_in_memory(1, "device", row).unwrap();
        assert!(store
            .save_stand_in_memory(1, "device", input.clone())
            .is_err());
        assert!(store
            .delete_stand_in_memory(1, corrected["id"].as_str().unwrap(), 1)
            .is_err());
        assert_eq!(store.stand_in_memories(1).unwrap(), vec![corrected.clone()]);
        store
            .delete_stand_in_memory(1, corrected["id"].as_str().unwrap(), 2)
            .unwrap();
        drop(store);
        let store = LocalTaskStore::open(path).unwrap();
        assert!(store.stand_in_memories(1).unwrap().is_empty());
        assert!(store
            .save_stand_in_memory(1, "device", input.clone())
            .is_err());
        let mut replay = input.clone();
        replay["content"] = corrected["content"].clone();
        assert!(store.save_stand_in_memory(1, "device", replay).is_err());
        assert!(store
            .save_stand_in_memory(2, "device", input.clone())
            .is_ok());
        let mut restored = input;
        restored["restoreForgotten"] = json!(true);
        let saved = store.save_stand_in_memory(1, "device", restored).unwrap();
        assert_eq!(saved["content"], "Birch owner is Lin");
        let connection = store.connection().unwrap();
        let mut statement = connection
            .prepare(
                "SELECT metadata FROM loop_items WHERE resource_type='stand_in_memory_tombstone'",
            )
            .unwrap();
        let metadata = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap();
        for row in metadata {
            let row = row.unwrap();
            assert!(!row.contains("Birch"));
            assert!(!row.contains("Zhou"));
        }
    }

    #[test]
    fn manual_memory_correction_does_not_reuse_the_old_excerpt_as_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.db")).unwrap();
        let original = json!({"scope":{"kind":"personal"},"content":"Birch owner is Lin",
            "sourceTaskId":"old-chat","evidence":{"taskId":"old-chat","messageId":"old-message","excerpt":"Birch owner is Lin"}});
        let mut row = store
            .save_stand_in_memory(7, "mac", original.clone())
            .unwrap();
        row["restoreForgotten"] = json!(true);
        let unchanged = store.save_stand_in_memory(7, "mac", row).unwrap();
        assert_eq!(unchanged["evidence"], original["evidence"]);
        let mut correction = unchanged;
        correction["restoreForgotten"] = json!(true);
        correction["content"] = json!("Birch owner is Zhou");
        let corrected = store.save_stand_in_memory(7, "mac", correction).unwrap();
        assert!(corrected["evidence"].is_null());
        assert!(corrected["sourceTaskId"].is_null());
        assert_eq!(corrected["version"], 3);
        let mut replay = original;
        replay["content"] = json!("Lin leads Birch");
        assert!(store.save_stand_in_memory(7, "mac", replay).is_err());
    }

    #[test]
    fn repeated_memory_enriches_missing_evidence_and_corrections_update_source() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.db")).unwrap();
        let mut input = json!({"scope":{"kind":"personal"},"content":"Prefer concise reports","sourceTaskId":"first"});
        let first = store
            .save_stand_in_memory(1, "device", input.clone())
            .unwrap();
        input["sourceTaskId"] = json!("verified-chat");
        input["evidence"] = json!({"taskId":"verified-chat","messageId":"message-1","excerpt":"Prefer concise reports"});
        let enriched = store
            .save_stand_in_memory(1, "device", input.clone())
            .unwrap();
        assert_eq!(enriched["id"], first["id"]);
        assert_eq!(enriched["version"], 2);
        assert_eq!(enriched["sourceTaskId"], input["sourceTaskId"]);
        assert_eq!(enriched["evidence"], input["evidence"]);
        assert_eq!(
            store.save_stand_in_memory(1, "device", input).unwrap(),
            enriched
        );
        assert_eq!(store.stand_in_memories(1).unwrap().len(), 1);
        let mut correction = enriched;
        correction["content"] = json!("Prefer detailed reports");
        correction["sourceTaskId"] = json!("correction-chat");
        correction["evidence"] = json!({"taskId":"correction-chat","messageId":"message-2","excerpt":"Prefer detailed reports"});
        let saved = store
            .save_stand_in_memory(1, "device", correction.clone())
            .unwrap();
        assert_eq!(saved["sourceTaskId"], correction["sourceTaskId"]);
        assert_eq!(saved["evidence"], correction["evidence"]);
        assert_eq!(saved["version"], 3);
    }

    #[test]
    fn repeated_memory_creation_reuses_exact_fact_only_within_owner_and_scope() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.db")).unwrap();
        let input = json!({"scope":{"kind":"personal"},"content":"Prefer concise Chinese","sourceTaskId":"first"});
        let first = store
            .save_stand_in_memory(1, "device", input.clone())
            .unwrap();
        let mut repeated = input.clone();
        repeated["content"] = json!("  Prefer concise Chinese  ");
        repeated["sourceTaskId"] = json!("second");
        assert_eq!(
            store.save_stand_in_memory(1, "device", repeated).unwrap(),
            first
        );
        assert_eq!(store.stand_in_memories(1).unwrap().len(), 1);
        let other = store
            .save_stand_in_memory(2, "device", input.clone())
            .unwrap();
        assert_ne!(first["id"], other["id"]);
        let mut project = input.clone();
        project["scope"] = json!({"kind":"project_coordinator","id":"project","store":"local"});
        let scoped = store
            .save_stand_in_memory(1, "device", project.clone())
            .unwrap();
        assert_ne!(first["id"], scoped["id"]);
        project["scope"] = json!({"store":"local","id":"project","kind":"project_coordinator"});
        assert_eq!(
            store.save_stand_in_memory(1, "device", project).unwrap(),
            scoped
        );
        let mut stale = input;
        stale["version"] = json!(1);
        assert!(store.save_stand_in_memory(1, "device", stale).is_err());
        assert_eq!(store.stand_in_memories(1).unwrap().len(), 2);
    }

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
