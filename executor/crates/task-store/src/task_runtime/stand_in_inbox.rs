//! Durable source cursors, message deduplication and role-owned work associations.
use super::personal_stand_in::{source_collection_namespace, source_namespace};
use super::*;
use sha2::{Digest, Sha256};

enum MessageGrouping<'a> {
    Known(Option<&'a str>),
    Uncertain(Option<&'a str>),
}

#[cfg(test)]
mod git_operation_tests {
    use super::*;
    #[test]
    fn definite_failure_can_retry_without_weakening_uncertain_or_owner_guards() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let action = json!({"profile":"account","instance":"https://github.com","repository":"org/repo","events":["*"]});
        let (id, _) = store
            .begin_git_subscription_operation(7, "hook", "request", &action)
            .unwrap();
        store.fail_unsent_git_operation(8, &id).unwrap();
        assert!(store
            .begin_git_subscription_operation(7, "hook", "new-request", &action)
            .is_err());
        store.fail_unsent_git_operation(7, &id).unwrap();
        let mut changed = action.clone();
        changed["repository"] = json!("other/repo");
        assert!(store
            .begin_git_subscription_operation(7, "hook", "request", &changed)
            .is_err());
        let (retry, previous) = store
            .begin_git_subscription_operation(7, "hook", "request", &action)
            .unwrap();
        assert_eq!(retry, id);
        assert!(previous.is_none());
        assert!(store
            .begin_git_subscription_operation(7, "hook", "new-request", &action)
            .is_err());
        store.fail_unsent_git_operation(7, &id).unwrap();
        assert!(store
            .begin_git_subscription_operation(7, "hook", "new-request", &action)
            .is_ok());
    }
    #[test]
    fn git_canonical_events_deduplicate_across_scopes_but_not_users_or_roles() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let source = json!({"providerId":"@wegent/dsh-connection-git/github","profile":"account","id":"repo","kind":"repository"});
        let mut personal = source.clone();
        personal["id"] = json!("personal");
        personal["kind"] = json!("personal");
        let message = json!({"id":"git-canonical:one","objectId":"comment:one","version":"1","text":"comment","at":"2026-01-01T00:00:00Z"});
        let first = store
            .ingest_stand_in_message(7, "role", &source, &message, None)
            .unwrap();
        let repeated = store
            .ingest_stand_in_message(7, "role", &personal, &message, None)
            .unwrap();
        assert_eq!(first["id"], repeated["id"]);
        assert_eq!(
            store
                .stand_in_messages(7, first["id"].as_str().unwrap())
                .unwrap()
                .len(),
            1
        );
        for (user, role) in [(8, "role"), (7, "other")] {
            let independent = store
                .ingest_stand_in_message(user, role, &personal, &message, None)
                .unwrap();
            assert_ne!(first["id"], independent["id"]);
        }
    }
    #[test]
    fn versioned_messages_keep_new_revisions_and_do_not_reopen_failed_or_completed_work() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let source = json!({"providerId":"any-plugin/events","profile":"account","kind":"repository","id":"42"});
        let mut message = json!({"id":"same-pr","objectId":"repository:42/pr:7","version":"checks-pass","text":"Checks passed","at":"2026-11-05T00:00:00Z"});
        let store = LocalTaskStore::open(&path).unwrap();
        let first = store
            .ingest_stand_in_message(7, "role", &source, &message, None)
            .unwrap();
        let record = store
            .known_stand_in_event_message(7, "role", &source, &message)
            .unwrap()
            .unwrap();
        store
            .update_stand_in_dispatch(
                7,
                first["id"].as_str().unwrap(),
                &[record["recordId"].as_str().unwrap().to_owned()],
                "failed",
                Some("retry later"),
            )
            .unwrap();
        drop(store);
        let store = LocalTaskStore::open(path).unwrap();
        message["id"] = json!("new-delivery-same-version");
        let repeated = store
            .ingest_stand_in_message(7, "role", &source, &message, None)
            .unwrap();
        assert_eq!(first["id"], repeated["id"]);
        assert_eq!(repeated["status"], "failed");
        for status in ["sending", "sent"] {
            store
                .update_stand_in_dispatch(
                    7,
                    first["id"].as_str().unwrap(),
                    &[record["recordId"].as_str().unwrap().to_owned()],
                    status,
                    None,
                )
                .unwrap();
            let repeated = store
                .ingest_stand_in_message(7, "role", &source, &message, None)
                .unwrap();
            assert_eq!(first["id"], repeated["id"]);
            assert_eq!(repeated["status"], status);
        }
        message["id"] = json!("same-pr");
        message["version"] = json!("checks-fail");
        let next = store
            .ingest_stand_in_message(7, "role", &source, &message, None)
            .unwrap();
        assert_ne!(first["id"], next["id"]);
        assert_eq!(next["status"], "pending");
        assert_ne!(
            record["recordId"],
            store
                .known_stand_in_event_message(7, "role", &source, &message)
                .unwrap()
                .unwrap()["recordId"]
        );
        assert!(store
            .known_stand_in_event_message(8, "role", &source, &message)
            .unwrap()
            .is_none());
        assert!(store
            .known_stand_in_event_message(7, "other-role", &source, &message)
            .unwrap()
            .is_none());
    }

    #[test]
    fn uncertain_git_writes_cannot_be_replayed_under_a_new_request_id() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let source = json!({"providerId":"@wegent/dsh-connection-git/github","profile":"account","id":"repo","kind":"repository","name":"org/repo"});
        let work = store
            .ingest_stand_in_message(
                7,
                "role",
                &source,
                &json!({"id":"event","text":"task","at":"2026-01-01T00:00:00Z"}),
                None,
            )
            .unwrap();
        let work = work["id"].as_str().unwrap();
        let action =
            json!({"profile":"account","path":"issues/1/comments","body":{"body":"reply"}});
        let (id, prior) = store
            .begin_git_operation(7, work, "request", &action)
            .unwrap();
        assert!(prior.is_none());
        assert!(store
            .begin_git_operation(7, work, "request", &action)
            .is_err());
        assert!(store
            .begin_git_operation(7, work, "new-request", &action)
            .is_err());
        assert!(store
            .begin_git_operation(8, work, "request", &action)
            .is_err());
        let mut disguised = action.clone();
        disguised["generation"] = json!("new-generation");
        disguised["unused"] = json!("not-part-of-the-remote-request");
        assert!(store
            .begin_git_operation(7, work, "another-request", &disguised)
            .is_err());
        let result = json!({"html_url":"https://github.com/org/repo/issues/1#issuecomment-1","updated_at":"2026-01-01T00:00:00Z","canonicalEventId":"git-canonical:sent"});
        store.complete_git_operation(7, &id, &result).unwrap();
        assert_eq!(
            store
                .begin_git_operation(7, work, "request", &action)
                .unwrap()
                .1,
            Some(result)
        );
        assert!(store
            .git_sent_event(7, "account", "git-canonical:sent")
            .unwrap());
        assert!(!store
            .git_sent_event(7, "account", "git-canonical:edited")
            .unwrap());
        assert!(!store
            .git_sent_event(8, "account", "git-canonical:sent")
            .unwrap());
    }
}

pub(crate) fn stand_in_record_key(prefix: &str, value: &Value) -> String {
    format!(
        "{prefix}:{:x}",
        Sha256::digest(value.to_string().as_bytes())
    )
}

fn read_record(
    connection: &Connection,
    id: &str,
    kind: &str,
) -> Result<Option<Value>, TaskRuntimeError> {
    Ok(get_item_from(connection, id, kind)?.map(|row| row.metadata))
}

fn write_record(
    connection: &Connection,
    id: &str,
    kind: &str,
    value: &Value,
) -> Result<(), TaskRuntimeError> {
    connection.execute("INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,?2,?3,?4,?4) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",params![id,kind,value.to_string(),now()])?;
    Ok(())
}

fn find_message(
    connection: &Connection,
    user: i64,
    role: &str,
    source: &Value,
    message: &str,
    immutable_only: bool,
) -> Result<Option<Value>, TaskRuntimeError> {
    let raw: Option<String> = connection.query_row(
        "SELECT metadata FROM loop_items WHERE resource_type='stand_in_message'
         AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.roleId')=?2
         AND json_extract(metadata,'$.source.profile')=?3 AND json_extract(metadata,'$.source.kind')=?4
         AND json_extract(metadata,'$.source.id')=?5 AND json_extract(metadata,'$.id')=?6 AND COALESCE(json_extract(metadata,'$.source.providerId'),?7)=?8 AND (?9=0 OR json_type(metadata,'$.objectId') IS NULL) ORDER BY created_at DESC,id DESC LIMIT 1",
        params![user, role, source["profile"].as_str(), source["kind"].as_str(), source["id"].as_str(), message, super::personal_stand_in::DINGTALK_PROVIDER, super::personal_stand_in::source_provider(source),immutable_only],
        |row| row.get(0),
    ).optional()?;
    raw.map(|raw| {
        serde_json::from_str(&raw).map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
    })
    .transpose()
}

fn find_event_message(
    connection: &Connection,
    user: i64,
    role: &str,
    source: &Value,
    message: &Value,
) -> Result<Option<Value>, TaskRuntimeError> {
    LocalTaskStore::validate_connection_message_version(message)?;
    if message.get("objectId").is_none() {
        return find_message(
            connection,
            user,
            role,
            source,
            message["id"].as_str().unwrap_or_default(),
            true,
        );
    }
    let raw: Option<String> = connection.query_row(
        "SELECT metadata FROM loop_items WHERE resource_type='stand_in_message'
         AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.roleId')=?2
         AND json_extract(metadata,'$.source.providerId')=?3 AND json_extract(metadata,'$.source.profile')=?4
         AND json_extract(metadata,'$.objectId')=?5 AND json_extract(metadata,'$.version')=?6 LIMIT 1",
        params![user,role,super::personal_stand_in::source_provider(source),source["profile"].as_str(),message["objectId"].as_str(),message["version"].as_str()], |row|row.get(0)
    ).optional()?;
    raw.map(|raw| {
        serde_json::from_str(&raw).map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
    })
    .transpose()
}

fn refresh_work(connection: &Connection, work: &mut Value) -> Result<(), TaskRuntimeError> {
    let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_message' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.workId')=?2 ORDER BY created_at DESC,id DESC")?;
    let rows = statement.query_map(
        params![work["userId"].as_i64(), work["id"].as_str()],
        |row| row.get::<_, String>(0),
    )?;
    let messages = rows
        .map(|raw| {
            serde_json::from_str::<Value>(&raw?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    work["messageCount"] = json!(messages.len());
    work["latestMessage"] = messages.first().cloned().unwrap_or(Value::Null);
    work["status"] = json!(["sending", "needs_grouping", "pending", "failed"]
        .into_iter()
        .find(|status| messages
            .iter()
            .any(|message| message["dispatchStatus"] == *status))
        .unwrap_or("sent"));
    work["updatedAt"] = json!(now());
    write_record(
        connection,
        work["id"].as_str().unwrap(),
        "stand_in_work",
        work,
    )
}

pub(super) fn queue_removed_git_connections(
    connection: &Connection,
    user: i64,
    previous: &Value,
    saved: &Value,
) -> Result<(), TaskRuntimeError> {
    use super::personal_stand_in::stand_in_identities;
    let active: std::collections::HashSet<String> = stand_in_identities(saved)
        .iter()
        .flat_map(|role| role["connections"].as_array().into_iter().flatten())
        .filter_map(|source| source["subscriptionId"].as_str().map(str::to_owned))
        .collect();
    for role in stand_in_identities(previous) {
        for source in role["connections"].as_array().into_iter().flatten() {
            let Some(subscription) = source["subscriptionId"]
                .as_str()
                .filter(|id| !active.contains(*id))
            else {
                continue;
            };
            let id = stand_in_record_key(
                "git-disconnect",
                &json!([user, subscription, source["generation"]]),
            );
            write_record(
                connection,
                &id,
                "stand_in_git_disconnect",
                &json!({"id":id,"userId":user,"subscriptionId":subscription,"generation":source["generation"]}),
            )?;
        }
    }
    Ok(())
}

impl LocalTaskStore {
    pub fn pending_git_disconnects(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        super::stand_in_processing::rows(&connection, "stand_in_git_disconnect", user)
    }
    pub fn finish_git_disconnect(&self, id: &str) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute(
            "DELETE FROM loop_items WHERE id=?1 AND resource_type='stand_in_git_disconnect'",
            params![id],
        )?;
        Ok(())
    }
    pub fn begin_git_operation(
        &self,
        user: i64,
        work: &str,
        request: &str,
        action: &Value,
    ) -> Result<(String, Option<Value>), TaskRuntimeError> {
        self.stand_in_work(user, work)?;
        self.begin_git_operation_record(user, work, request, action)
    }
    pub fn begin_git_subscription_operation(
        &self,
        user: i64,
        subscription: &str,
        request: &str,
        action: &Value,
    ) -> Result<(String, Option<Value>), TaskRuntimeError> {
        self.begin_git_operation_record(
            user,
            &format!("subscription:{subscription}"),
            request,
            action,
        )
    }
    fn begin_git_operation_record(
        &self,
        user: i64,
        work: &str,
        request: &str,
        action: &Value,
    ) -> Result<(String, Option<Value>), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let tx = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = stand_in_record_key("git-operation", &json!([user, work, request]));
        if let Some(row) = read_record(&tx, &id, "stand_in_git_operation")? {
            if row["action"] != *action {
                return Err(TaskRuntimeError::Invalid(
                    "Git operation ID was reused with different contents".into(),
                ));
            }
            if row["status"] == "succeeded" {
                return Ok((id, Some(row["result"].clone())));
            }
            if row["status"] != "failed" {
                return Err(TaskRuntimeError::Invalid(
                    "Git write outcome is uncertain; inspect the remote result before another write".into(),
                ));
            }
        }
        // Only fields that change the remote effect identify an uncertain write.
        // Request IDs, consumer generations and unused arguments cannot bypass it.
        let fields: &[&str] = if work.starts_with("subscription:") {
            &["profile", "instance", "repository", "callbackUrl", "events"]
        } else {
            &[
                "providerId",
                "profile",
                "instance",
                "repository",
                "method",
                "path",
                "body",
            ]
        };
        let mut contents = json!({});
        for field in fields {
            contents[*field] = action[*field].clone();
        }
        if let Some(events) = contents.get_mut("events").and_then(Value::as_array_mut) {
            events.sort_by_key(Value::to_string);
        }
        let action_key = stand_in_record_key("git-action", &contents);
        let uncertain:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM loop_items WHERE resource_type='stand_in_git_operation' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.workId')=?2 AND json_extract(metadata,'$.actionKey')=?3 AND json_extract(metadata,'$.status')='sending')",params![user,work,action_key],|row|row.get(0))?;
        if uncertain {
            return Err(TaskRuntimeError::Invalid("An identical Git write has an uncertain outcome; changing requestId cannot retry it".into()));
        }
        write_record(
            &tx,
            &id,
            "stand_in_git_operation",
            &json!({"id":id,"userId":user,"workId":work,"action":action,"actionKey":action_key,"status":"sending"}),
        )?;
        tx.commit()?;
        Ok((id, None))
    }

    pub fn complete_git_operation(
        &self,
        user: i64,
        id: &str,
        result: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let mut row = read_record(&connection, id, "stand_in_git_operation")?
            .filter(|r| r["userId"] == user)
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        row["status"] = json!("succeeded");
        row["result"] = result.clone();
        write_record(&connection, id, "stand_in_git_operation", &row)
    }

    pub fn fail_unsent_git_operation(&self, user: i64, id: &str) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.status','failed') WHERE id=?1 AND resource_type='stand_in_git_operation' AND json_extract(metadata,'$.userId')=?2 AND json_extract(metadata,'$.status')='sending'",
            params![id, user],
        )?;
        Ok(())
    }

    pub fn git_sent_event(
        &self,
        user: i64,
        profile: &str,
        event: &str,
    ) -> Result<bool, TaskRuntimeError> {
        let connection = self.connection()?;
        let found:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM loop_items WHERE resource_type='stand_in_git_operation' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.status')='succeeded' AND json_extract(metadata,'$.action.profile')=?2 AND json_extract(metadata,'$.result.canonicalEventId')=?3)",params![user,profile,event],|row|row.get(0))?;
        Ok(found)
    }

    pub fn stand_in_source_errors(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement=connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_source' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.error') IS NOT NULL ORDER BY updated_at DESC")?;
        let rows = statement.query_map(params![user], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            serde_json::from_str(&row?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect()
    }
    pub fn stand_in_source(&self, user: i64, source: &Value) -> Result<Value, TaskRuntimeError> {
        let key = stand_in_record_key(
            "stand-in-source",
            &json!([
                user,
                source_collection_namespace(source),
                source["kind"],
                source["id"]
            ]),
        );
        let connection = self.connection()?;
        Ok(read_record(&connection, &key, "stand_in_source")?.unwrap_or(Value::Null))
    }

    pub fn save_stand_in_source(
        &self,
        user: i64,
        source: &Value,
        state: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let key = stand_in_record_key(
            "stand-in-source",
            &json!([
                user,
                source_collection_namespace(source),
                source["kind"],
                source["id"]
            ]),
        );
        let mut state = state.clone();
        state["userId"] = json!(user);
        state["source"] = source.clone();
        let connection = self.connection()?;
        write_record(&connection, &key, "stand_in_source", &state)
    }

    pub fn stand_in_work(&self, user: i64, id: &str) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        read_record(&connection, id, "stand_in_work")?
            .filter(|work| work["userId"] == user)
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub fn list_stand_in_work(
        &self,
        user: i64,
        role: Option<&str>,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_work' AND json_extract(metadata,'$.userId')=?1 AND (?2 IS NULL OR json_extract(metadata,'$.roleId')=?2) ORDER BY updated_at DESC")?;
        let rows = statement.query_map(params![user, role], |row| row.get::<_, String>(0))?;
        rows.map(|raw| {
            serde_json::from_str(&raw?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect()
    }

    pub fn stand_in_messages(&self, user: i64, work: &str) -> Result<Vec<Value>, TaskRuntimeError> {
        self.stand_in_work(user, work)?;
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_message' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.workId')=?2 ORDER BY created_at,id")?;
        let rows = statement.query_map(params![user, work], |row| row.get::<_, String>(0))?;
        rows.map(|raw| {
            serde_json::from_str(&raw?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect()
    }

    pub fn known_stand_in_message(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        message: &str,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        find_message(&connection, user, role, source, message, false)
    }

    pub fn known_stand_in_event_message(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        message: &Value,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        find_event_message(&*self.connection()?, user, role, source, message)
    }

    pub fn ingest_stand_in_message(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        message: &Value,
        work_id: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        self.ingest_stand_in_message_record(
            user,
            role,
            source,
            message,
            MessageGrouping::Known(work_id),
        )
    }

    pub fn ingest_ungrouped_stand_in_message(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        message: &Value,
        error: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        self.ingest_stand_in_message_record(
            user,
            role,
            source,
            message,
            MessageGrouping::Uncertain(error),
        )
    }

    fn ingest_stand_in_message_record(
        &self,
        user: i64,
        role: &str,
        source: &Value,
        message: &Value,
        grouping: MessageGrouping<'_>,
    ) -> Result<Value, TaskRuntimeError> {
        let (work_id, status, error) = match grouping {
            MessageGrouping::Known(id) => (id, "pending", None),
            MessageGrouping::Uncertain(error) => (None, "needs_grouping", error),
        };
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::validate_connection_message_version(message)?;
        let identity = if message.get("objectId").is_some() {
            json!([
                user,
                role,
                super::personal_stand_in::source_provider(source),
                source["profile"],
                message["objectId"],
                message["version"]
            ])
        } else {
            json!([
                user,
                role,
                source_namespace(source),
                source["kind"],
                source["id"],
                message["id"]
            ])
        };
        let key = stand_in_record_key("stand-in-message", &identity);
        if let Some(existing) = find_event_message(&connection, user, role, source, message)? {
            let result = read_record(
                &connection,
                existing["workId"].as_str().unwrap_or_default(),
                "stand_in_work",
            )?
            .ok_or(TaskRuntimeError::TaskNotFound)?;
            connection.commit()?;
            return Ok(result);
        }
        let mut work = if let Some(id) = work_id {
            read_record(&connection, id, "stand_in_work")?
                .filter(|work| work["userId"] == user && work["roleId"] == role)
                .ok_or(TaskRuntimeError::TaskNotFound)?
        } else {
            let id = format!("stand-in-work-{}", Uuid::new_v4());
            json!({"id":id,"userId":user,"roleId":role,"source":source,"title":message["text"].as_str().unwrap_or("DingTalk message").chars().take(80).collect::<String>(),"taskId":id,"messageCount":0,"status":"pending","createdAt":now()})
        };
        let mut record = message.clone();
        record["recordId"] = json!(key);
        record["userId"] = json!(user);
        record["roleId"] = json!(role);
        record["workId"] = work["id"].clone();
        record["source"] = source.clone();
        record["dispatchStatus"] = json!(status);
        if status == "needs_grouping" {
            work["error"] = json!(error);
        }
        write_record(&connection, &key, "stand_in_message", &record)?;
        refresh_work(&connection, &mut work)?;
        connection.commit()?;
        Ok(work)
    }

    pub fn update_stand_in_dispatch(
        &self,
        user: i64,
        work: &str,
        ids: &[String],
        status: &str,
        error: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut work = read_record(&connection, work, "stand_in_work")?
            .filter(|work| work["userId"] == user)
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        for id in ids {
            let mut message = read_record(&connection, id, "stand_in_message")?
                .filter(|message| message["userId"] == user && message["workId"] == work["id"])
                .ok_or(TaskRuntimeError::TaskNotFound)?;
            message["dispatchStatus"] = json!(status);
            write_record(&connection, id, "stand_in_message", &message)?;
        }
        work["error"] = json!(error);
        refresh_work(&connection, &mut work)?;
        connection.commit()?;
        Ok(())
    }

    pub fn adjust_stand_in_message(
        &self,
        user: i64,
        work: &str,
        message_id: &str,
        target: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        self.organize_stand_in_messages(user, work, &[message_id.to_owned()], target)
    }

    pub fn organize_stand_in_messages(
        &self,
        user: i64,
        work: &str,
        ids: &[String],
        target: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        if ids.is_empty()
            || ids.len() > 1000
            || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
        {
            return Err(TaskRuntimeError::Invalid(
                "Select unique messages to organize".into(),
            ));
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut source = read_record(&connection, work, "stand_in_work")?
            .filter(|work| work["userId"] == user)
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let mut messages = ids
            .iter()
            .map(|id| {
                read_record(&connection, id, "stand_in_message")?
                    .filter(|row| row["userId"] == user && row["workId"] == work)
                    .ok_or(TaskRuntimeError::TaskNotFound)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut destination = if let Some(target) = target {
            read_record(&connection, target, "stand_in_work")?
                .filter(|row| {
                    row["userId"] == user
                        && row["roleId"] == source["roleId"]
                        && row["id"] != source["id"]
                })
                .ok_or(TaskRuntimeError::TaskNotFound)?
        } else {
            let id = format!("stand-in-work-{}", Uuid::new_v4());
            let message = &messages[0];
            json!({"id":id,"taskId":id,"userId":user,"roleId":source["roleId"],"source":message["source"],"title":message["text"].as_str().unwrap_or_default().chars().take(80).collect::<String>(),"messageCount":0,"status":"pending","createdAt":now()})
        };
        if source["status"] == "sending" || destination["status"] == "sending" {
            return Err(TaskRuntimeError::Invalid(
                "Wait for active work to finish before organizing messages".into(),
            ));
        }
        for (id, message) in ids.iter().zip(messages.iter_mut()) {
            if message.get("originalWorkId").is_none() {
                message["originalWorkId"] = source["id"].clone();
            }
            message["workId"] = destination["id"].clone();
            // Organization never authorizes replay of completed effects.
            if matches!(
                message["dispatchStatus"].as_str(),
                Some("pending" | "needs_grouping" | "failed")
            ) {
                message["dispatchStatus"] = json!("pending");
            }
            write_record(&connection, id, "stand_in_message", message)?;
        }
        refresh_work(&connection, &mut source)?;
        refresh_work(&connection, &mut destination)?;
        connection.commit()?;
        Ok(destination)
    }
}

#[cfg(test)]
mod organization_tests {
    use super::*;

    #[test]
    fn batch_merge_and_undo_are_atomic_preserve_effects_and_isolate_owners() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let source = json!({"id":"group","profile":"owner","kind":"group"});
        let work = store
            .ingest_stand_in_message(
                7,
                "review",
                &source,
                &json!({"id":"one","text":"First"}),
                None,
            )
            .unwrap();
        let id = work["id"].as_str().unwrap();
        store
            .ingest_stand_in_message(
                7,
                "review",
                &source,
                &json!({"id":"two","text":"Second"}),
                Some(id),
            )
            .unwrap();
        let target = store
            .ingest_stand_in_message(
                7,
                "review",
                &source,
                &json!({"id":"three","text":"Target"}),
                None,
            )
            .unwrap();
        let target_id = target["id"].as_str().unwrap();
        let ids: Vec<String> = store
            .stand_in_messages(7, id)
            .unwrap()
            .iter()
            .map(|message| message["recordId"].as_str().unwrap().to_owned())
            .collect();
        store
            .update_stand_in_dispatch(7, id, &ids, "sent", None)
            .unwrap();
        let mut invalid = ids.clone();
        invalid.push("missing".into());
        assert!(store
            .organize_stand_in_messages(7, id, &invalid, Some(target_id))
            .is_err());
        assert_eq!(store.stand_in_messages(7, id).unwrap().len(), 2);
        assert!(store
            .organize_stand_in_messages(8, id, &ids, Some(target_id))
            .is_err());
        let merged = store
            .organize_stand_in_messages(7, id, &ids, Some(target_id))
            .unwrap();
        assert_eq!(merged["messageCount"], 3);
        assert_eq!(store.stand_in_messages(7, id).unwrap().len(), 0);
        store
            .organize_stand_in_messages(7, target_id, &ids, Some(id))
            .unwrap();
        let restored = store.stand_in_messages(7, id).unwrap();
        assert_eq!(restored.len(), 2);
        assert!(restored
            .iter()
            .all(|message| message["dispatchStatus"] == "sent" && message["originalWorkId"] == id));
        assert_eq!(store.stand_in_messages(7, target_id).unwrap().len(), 1);
        assert_eq!(store.list_stand_in_work(7, None).unwrap().len(), 2);
    }
}
