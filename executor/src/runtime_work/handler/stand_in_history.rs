//! Conversation reads reuse native transcripts and revalidate live actor authority.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;
use crate::task_runtime::personal_stand_in::{connection_memory_scope, stand_in_connection};

fn denied() -> AppIpcError {
    AppIpcError::new(
        "permission_denied",
        "Conversation access is no longer authorized",
    )
}

pub(super) fn history_owned(link: &RuntimeTaskLink, user: i64) -> bool {
    link.runtime_handle["executionRequest"]["user_id"] == user
        && link.runtime_handle["origin"]
            .get("userId")
            .map_or(true, |owner| owner == user)
        && !link.ephemeral
        && !matches!(
            link.runtime_handle["origin"]["type"].as_str(),
            Some("stand_in_coordinator" | "stand_in_processing" | "project_coordinator")
        )
}

fn time(args: &Value, key: &str) -> Result<Option<i64>, AppIpcError> {
    args.get(key)
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_str()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|at| at.timestamp_millis())
                .ok_or_else(|| AppIpcError::new("bad_request", format!("Invalid {key}")))
        })
        .transpose()
}

pub(super) fn filter_history_page(page: &mut Value, since: Option<i64>, until: Option<i64>) {
    let mut unknown = false;
    if let Some(messages) = page["messages"].as_array_mut() {
        messages.retain(|message| {
            let at = timestamp_ms_field(message, "createdAt");
            unknown |= at.is_none();
            at.map_or(true, |at| {
                since.map_or(true, |start| at >= start) && until.map_or(true, |end| at < end)
            })
        });
    }
    // Canonical turns and navigation may contain text outside the selected window.
    if let Some(object) = page.as_object_mut() {
        object.retain(|key, _| {
            matches!(
                key.as_str(),
                "success"
                    | "code"
                    | "error"
                    | "taskId"
                    | "messages"
                    | "fullContent"
                    | "fullItemContent"
                    | "beforeCursor"
                    | "afterCursor"
                    | "hasMoreBefore"
                    | "hasMoreAfter"
            )
        });
    }
    page["unknownTimestamps"] = json!(unknown);
    page["contentMayBeTruncated"] =
        json!(page["fullContent"] != true && page["fullItemContent"] != true);
}

fn source_scope(source: &Value) -> Value {
    let mut scope = connection_memory_scope(source);
    scope["transport"] = source["transport"].clone();
    scope
}

struct ReadScope {
    source: Option<Value>,
    role: Value,
    coordinator_tasks: Option<HashSet<String>>,
    can_orchestrate: bool,
    window: Option<(i64, i64)>,
}

impl RuntimeWorkRpcHandler {
    fn conversation_scope(
        &self,
        identity: &StandInMcpIdentity,
        store: &LocalTaskStore,
    ) -> Result<ReadScope, AppIpcError> {
        if identity.device != self.device_id || identity.project.is_some() {
            return Err(denied());
        }
        let actor = self.local_task_link(&identity.task_id).ok_or_else(denied)?;
        let origin = &actor.runtime_handle["origin"];
        if actor.ephemeral
            || self.archived_link_is_deleted(&actor)
            || actor.status == "archived"
            || actor.runtime_handle["executionRequest"]["user_id"] != identity.user
            || origin["userId"] != identity.user
            || origin["deviceId"] != self.device_id
            || origin["standInId"].as_str() != identity.role.as_deref()
            || origin["workId"].as_str() != identity.work.as_deref()
            || (origin["type"] == "stand_in_task") != identity.readonly_worker
        {
            return Err(denied());
        }
        let settings = store
            .personal_stand_in(identity.user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        if settings["executionDeviceId"] != self.device_id {
            return Err(denied());
        }
        let role = match identity.role.as_deref().filter(|id| *id != "@primary") {
            Some(id) => settings["roles"]
                .as_array()
                .and_then(|roles| roles.iter().find(|role| role["id"] == id))
                .ok_or_else(denied)?,
            None => &settings["primary"],
        };
        let coordinator = identity.coordinator_batch.is_some();
        if identity.review {
            if identity.work.is_some()
                || coordinator
                || identity.readonly_worker
                || !matches!(identity.role.as_deref(), None | Some("@primary"))
            {
                return Err(denied());
            }
            let end = self.review_run_end(&actor, identity.user)?;
            return Ok(ReadScope {
                source: None,
                role: role.clone(),
                coordinator_tasks: None,
                can_orchestrate: false,
                window: Some((
                    (end - chrono::Duration::days(7)).timestamp_millis(),
                    end.timestamp_millis(),
                )),
            });
        }
        let mut coordinator_tasks = None;
        if coordinator {
            let state = store
                .stand_in_processing_state(identity.user)
                .map_err(super::stand_in::settings_error)?;
            if origin["type"] != "stand_in_coordinator"
                || origin["batchId"].as_str() != identity.coordinator_batch.as_deref()
                || state["batchId"].as_str() != identity.coordinator_batch.as_deref()
            {
                return Err(denied());
            }
            coordinator_tasks = Some(
                state["snapshot"]["works"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|work| work["taskId"].as_str().map(str::to_owned))
                    .collect(),
            );
        } else if identity.readonly_worker {
            let delegation = &actor.runtime_handle["executionRequest"]["standInDelegation"];
            if !delegation.is_null()
                && (delegation["sourceTaskId"] != origin["sourceTaskId"]
                    || delegation["userId"] != identity.user)
            {
                return Err(denied());
            }

            let parent = self
                .local_task_link(origin["sourceTaskId"].as_str().ok_or_else(denied)?)
                .ok_or_else(denied)?;
            let parent_origin = &parent.runtime_handle["origin"];
            if !history_owned(&parent, identity.user)
                || self.archived_link_is_deleted(&parent)
                || parent.status == "archived"
                || parent_origin["type"] != "stand_in_identity"
                || parent_origin["deviceId"] != self.device_id
                || parent_origin["userId"] != identity.user
                || !matches!(parent_origin["standInId"].as_str(), None | Some("@primary"))
                || !matches!(identity.role.as_deref(), None | Some("@primary"))
                || identity.work.is_some()
            {
                return Err(denied());
            }
        } else if !matches!(
            origin["type"].as_str(),
            Some("stand_in_identity" | "connection_work" | "dingtalk_work")
        ) {
            return Err(denied());
        }
        let source = identity
            .work
            .as_deref()
            .map(|id| {
                let work = store
                    .stand_in_work(identity.user, id)
                    .map_err(super::stand_in::settings_error)?;
                if work["roleId"].as_str() != identity.role.as_deref() {
                    return Err(denied());
                }
                self.validate_history_source(store, identity.user, role, &work)?;
                Ok(source_scope(&work["source"]))
            })
            .transpose()?;
        if matches!(
            origin["type"].as_str(),
            Some("connection_work" | "dingtalk_work")
        ) && source.is_none()
        {
            return Err(denied());
        }
        Ok(ReadScope {
            source,
            role: role.clone(),
            coordinator_tasks,
            window: None,
            can_orchestrate: !identity.readonly_worker
                && identity.work.is_none()
                && matches!(identity.role.as_deref(), None | Some("@primary")),
        })
    }

    pub(super) fn authorize_work_source_read(
        &self,
        identity: &StandInMcpIdentity,
        requested: &Value,
    ) -> Result<Value, AppIpcError> {
        if identity.readonly_worker
            || identity.work.is_none()
            || identity.coordinator_batch.is_some()
        {
            return Err(denied());
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let scope = self.conversation_scope(identity, &store)?;
        let actor = self.local_task_link(&identity.task_id).ok_or_else(denied)?;
        if !matches!(
            actor.runtime_handle["origin"]["type"].as_str(),
            Some("connection_work" | "dingtalk_work")
        ) {
            return Err(denied());
        }
        let work = store
            .stand_in_work(identity.user, identity.work.as_deref().unwrap())
            .map_err(super::stand_in::settings_error)?;
        if work["taskId"] != identity.task_id {
            return Err(denied());
        }
        let mut source = stand_in_connection(&scope.role, &work["source"])
            .ok_or_else(denied)?
            .clone();
        for key in ["id", "kind", "profile", "name"] {
            source[key] = work["source"][key].clone();
        }
        source.as_object_mut().ok_or_else(denied)?.remove("scope");
        if source["id"] == "*"
            || (!requested.is_null()
                && (!requested.is_object()
                    || ["providerId", "profile", "kind", "id"]
                        .iter()
                        .any(|key| requested[*key] != source[*key])
                    || requested.get("scope").is_some()
                    || requested
                        .get("transport")
                        .is_some_and(|transport| transport != &source["transport"])))
        {
            return Err(denied());
        }
        Ok(source)
    }

    fn validate_history_source(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role: &Value,
        work: &Value,
    ) -> Result<(), AppIpcError> {
        if stand_in_connection(role, &work["source"]).is_none() {
            return Err(denied());
        }
        for message in store
            .stand_in_messages(user, work["id"].as_str().ok_or_else(denied)?)
            .map_err(super::stand_in::settings_error)?
        {
            if stand_in_connection(role, &message["source"]).is_none()
                || source_scope(&message["source"]) != source_scope(&work["source"])
            {
                return Err(denied());
            }
        }
        Ok(())
    }

    fn conversation_visible(
        &self,
        link: &RuntimeTaskLink,
        identity: &StandInMcpIdentity,
        scope: &ReadScope,
        store: &LocalTaskStore,
    ) -> bool {
        if (identity.review && link.local_task_id == identity.task_id)
            || !history_owned(link, identity.user)
            || self.archived_link_is_deleted(link)
        {
            return false;
        }
        if scope.coordinator_tasks.as_ref().is_some_and(|tasks| {
            link.runtime_handle["origin"]["type"] == "stand_in_identity"
                || !tasks.contains(&link.local_task_id)
        }) {
            return false;
        }
        let Some(source) = &scope.source else {
            return true;
        };
        let origin = &link.runtime_handle["origin"];
        if !matches!(
            origin["type"].as_str(),
            Some("connection_work" | "dingtalk_work")
        ) || origin["standInId"].as_str() != identity.role.as_deref()
        {
            return false;
        }
        let Ok(work) = store.stand_in_work(
            identity.user,
            origin["workId"].as_str().unwrap_or(&link.local_task_id),
        ) else {
            return false;
        };
        work["roleId"].as_str() == identity.role.as_deref()
            && source_scope(&work["source"]) == *source
            && self
                .validate_history_source(store, identity.user, &scope.role, &work)
                .is_ok()
    }

    pub(super) async fn read_stand_in_conversations(
        &self,
        identity: &StandInMcpIdentity,
        name: &str,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let scope = self.conversation_scope(identity, &store)?;
        for key in [
            "cursor",
            "beforeCursor",
            "afterCursor",
            "messageContentCursor",
        ] {
            if args.get(key).is_some_and(|value| !value.is_string()) {
                return Err(AppIpcError::new(
                    "bad_request",
                    format!("{key} must be a string"),
                ));
            }
        }
        let mut since = time(args, "since")?;
        let mut until = time(args, "until")?;
        if let Some((start, end)) = scope.window {
            if since.is_some_and(|at| at < start || at >= end)
                || until.is_some_and(|at| at > end || at <= start)
            {
                return Err(denied());
            }
            since = Some(since.unwrap_or(start));
            until = Some(until.unwrap_or(end));
        }
        if since.zip(until).is_some_and(|(start, end)| start >= end) {
            return Err(AppIpcError::new("bad_request", "since must precede until"));
        }
        let limit = match args.get("limit") {
            None => 50,
            Some(value) => value
                .as_u64()
                .filter(|value| (1..=50).contains(value))
                .ok_or_else(|| AppIpcError::new("bad_request", "limit must be 1-50"))?
                as usize,
        };
        if name == "read_task" {
            let id = super::stand_in_tasks::required(args, "taskId")?;
            let link = self
                .local_task_link(id)
                .filter(|link| self.conversation_visible(link, identity, &scope, &store))
                .ok_or_else(denied)?;
            let mut page = self
                .read_bounded_history(identity, &link, args, limit, since, until)
                .await?;
            if let Some((start, end)) = scope.window {
                page["windowStart"] = json!(
                    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(start)
                );
                page["windowEnd"] =
                    json!(chrono::DateTime::<chrono::Utc>::from_timestamp_millis(end));
            }
            return Ok(page);
        }
        let mut links: Vec<_> = self
            .local_task_links(true)
            .into_iter()
            .filter(|link| {
                self.conversation_visible(link, identity, &scope, &store)
                    && since.map_or(true, |start| {
                        link.updated_at == 0 || link.updated_at >= start
                    })
                    && until.map_or(true, |end| link.created_at == 0 || link.created_at < end)
            })
            .collect();
        links.sort_by(|a, b| a.local_task_id.cmp(&b.local_task_id));
        let cursor = args["cursor"].as_str().unwrap_or("");
        let mut remaining = links
            .into_iter()
            .filter(|link| link.local_task_id.as_str() > cursor);
        let page: Vec<_> = remaining.by_ref().take(limit).collect();
        let has_more = remaining.next().is_some();
        let next = has_more
            .then(|| page.last().map(|link| link.local_task_id.clone()))
            .flatten();
        Ok(
            json!({"items":page.iter().map(|link|json!({"taskId":link.local_task_id,"title":link.title,"status":link.status,
            "interactionStatus":link.interaction_status,"createdAt":link.created_at,"updatedAt":link.updated_at,"kind":if link.runtime_handle["origin"]["type"]=="stand_in_identity" {"identity"} else {"task"},
            "canContinue":scope.can_orchestrate && super::stand_in_tasks::owns_task(link,identity.user) && link.status!="archived" && link.interaction_status.is_none() && is_codex_runtime(&link.runtime)})).collect::<Vec<_>>(),"hasMore":has_more,"nextCursor":next,"windowStart":scope.window.and_then(|(start,_)|chrono::DateTime::<chrono::Utc>::from_timestamp_millis(start)),"windowEnd":scope.window.and_then(|(_,end)|chrono::DateTime::<chrono::Utc>::from_timestamp_millis(end))}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, RuntimeWorkRpcHandler, StandInMcpIdentity) {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let settings = store.personal_stand_in(7, "mac").unwrap();
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let identity = StandInMcpIdentity {
            task_id: "identity".into(),
            user: 7,
            device: "mac".into(),
            role: Some("default".into()),
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            readonly_worker: false,
        };
        handler.upsert_local_task(link(
            "identity",
            7,
            json!({"type":"stand_in_identity","userId":7,"deviceId":"mac","standInId":"default"}),
        ));
        (root, handler, identity)
    }

    fn link(id: &str, user: i64, origin: Value) -> RuntimeTaskLink {
        RuntimeTaskLink {
            local_task_id: id.into(),
            runtime: "codex".into(),
            title: id.into(),
            updated_at: 2000,
            created_at: 1000,
            runtime_handle: json!({"origin":origin,"executionRequest":{"user_id":user}}),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn ordinary_paused_role_lists_owned_conversations_with_time_and_pagination() {
        let (_root, handler, identity) = fixture();
        for index in 0..61 {
            handler.upsert_local_task(link(&format!("task-{index:03}"), 7, json!({})));
        }
        handler.upsert_local_task(link("foreign", 8, json!({})));
        handler.upsert_local_task(link("private", 7, json!({"type":"stand_in_coordinator"})));
        let mut ephemeral = link("ephemeral", 7, json!({}));
        ephemeral.ephemeral = true;
        handler.upsert_local_task(ephemeral);
        let first = handler
            .read_stand_in_conversations(
                &identity,
                "list_tasks",
                &json!({"limit":50,"since":"1970-01-01T00:00:01Z","until":"1970-01-01T00:00:03Z"}),
            )
            .await
            .unwrap();
        assert_eq!(first["items"].as_array().unwrap().len(), 50);
        assert_eq!(first["hasMore"], true);
        assert_eq!(first["items"][0]["kind"], "identity");
        assert_eq!(first["items"][0]["canContinue"], false);
        let next = handler
            .read_stand_in_conversations(
                &identity,
                "list_tasks",
                &json!({"cursor":first["nextCursor"]}),
            )
            .await
            .unwrap();
        assert_eq!(next["items"].as_array().unwrap().len(), 12);
        assert_eq!(next["hasMore"], false);
        assert!(next["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["canContinue"] == false));
        let old = handler
            .read_stand_in_conversations(
                &identity,
                "list_tasks",
                &json!({"since":"1970-01-01T00:00:03Z"}),
            )
            .await
            .unwrap();
        assert!(old["items"].as_array().unwrap().is_empty());
        assert!(handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({"since":"invalid"}))
            .await
            .is_err());
        for key in ["cursor", "beforeCursor", "afterCursor"] {
            assert_eq!(
                handler
                    .read_stand_in_conversations(&identity, "list_tasks", &json!({key:123}))
                    .await
                    .unwrap_err()
                    .code,
                "bad_request"
            );
        }
        for user in [8, -1] {
            let mut foreign = identity.clone();
            foreign.user = user;
            assert!(handler
                .read_stand_in_conversations(&foreign, "list_tasks", &json!({}))
                .await
                .is_err());
        }
        let mut changed = handler.local_task_link("identity").unwrap();
        changed.runtime_handle["origin"]["standInId"] = json!("new-role");
        handler.upsert_local_task(changed);
        assert!(handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn delegated_worker_inherits_only_live_primary_personal_read_scope() {
        let (_root, handler, mut identity) = fixture();
        handler.upsert_local_task(link(
            "primary",
            7,
            json!({"type":"stand_in_identity","userId":7,"deviceId":"mac","standInId":"@primary"}),
        ));
        handler.upsert_local_task(link("worker",7,json!({"type":"stand_in_task","userId":7,"deviceId":"mac","standInId":"@primary","sourceTaskId":"primary"})));
        identity.task_id = "worker".into();
        identity.role = Some("@primary".into());
        identity.readonly_worker = true;
        let page = handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
            .await
            .unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 3);
        assert!(page["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["canContinue"] == false));
        for field in ["userId", "deviceId", "type", "standInId"] {
            let mut parent = handler.local_task_link("primary").unwrap();
            let saved = parent.clone();
            parent.runtime_handle["origin"][field] = json!("foreign");
            handler.upsert_local_task(parent);
            assert!(
                handler
                    .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
                    .await
                    .is_err(),
                "{field}"
            );
            handler.upsert_local_task(saved);
        }
        let mut parent = handler.local_task_link("primary").unwrap();
        parent.status = "archived".into();
        handler.upsert_local_task(parent);
        assert!(handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
            .await
            .is_err());
    }

    #[test]
    fn source_work_source_reads_revalidate_actor_and_only_its_original_resource() {
        let (_root, handler, mut identity) = fixture();
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let source = json!({"providerId":"test-provider","profile":"account","kind":"inbox","id":"selected","name":"Selected","policy":{"automatic":true,"askBeforeAct":true}});
        let mut other = source.clone();
        other["id"] = json!("other");
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"][0]["connections"] = json!([source, other]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let work = store
            .ingest_stand_in_message(
                7,
                "default",
                &source,
                &json!({"id":"event","at":"2026-01-01T00:00:00Z","text":"Question"}),
                None,
            )
            .unwrap();
        let id = work["id"].as_str().unwrap();
        let actor = link(
            id,
            7,
            json!({"type":"connection_work","userId":7,"deviceId":"mac","standInId":"default","workId":id}),
        );
        handler.upsert_local_task(actor.clone());
        identity.task_id = id.into();
        identity.work = Some(id.into());
        let bound = handler
            .authorize_work_source_read(&identity, &Value::Null)
            .unwrap();
        assert_eq!(bound["id"], "selected");
        assert!(handler
            .authorize_work_source_read(&identity, &source)
            .is_ok());
        assert!(handler
            .authorize_work_source_read(&identity, &other)
            .is_err());
        for field in ["type", "userId", "deviceId", "standInId", "workId"] {
            let mut changed = actor.clone();
            changed.runtime_handle["origin"][field] = json!("foreign");
            handler.upsert_local_task(changed);
            assert!(
                handler
                    .authorize_work_source_read(&identity, &Value::Null)
                    .is_err(),
                "{field}"
            );
            handler.upsert_local_task(actor.clone());
        }
        for denied_identity in [
            StandInMcpIdentity {
                readonly_worker: true,
                ..identity.clone()
            },
            StandInMcpIdentity {
                user: 8,
                ..identity.clone()
            },
            StandInMcpIdentity {
                device: "other-device".into(),
                ..identity.clone()
            },
        ] {
            assert!(handler
                .authorize_work_source_read(&denied_identity, &Value::Null)
                .is_err());
        }
        let mut changed = actor.clone();
        changed.runtime_handle["executionRequest"]["user_id"] = json!(8);
        handler.upsert_local_task(changed);
        assert!(handler
            .authorize_work_source_read(&identity, &Value::Null)
            .is_err());
        handler.upsert_local_task(actor.clone());
        let mut copied = actor.clone();
        copied.local_task_id = "copied-work-context".into();
        handler.upsert_local_task(copied);
        let mut copied_identity = identity.clone();
        copied_identity.task_id = "copied-work-context".into();
        assert!(handler
            .authorize_work_source_read(&copied_identity, &Value::Null)
            .is_err());
        let mut revoked = store.personal_stand_in(7, "mac").unwrap();
        revoked["roles"][0]["connections"] = json!([other]);
        store.save_personal_stand_in(7, "mac", revoked).unwrap();
        assert!(handler
            .authorize_work_source_read(&identity, &Value::Null)
            .is_err());
    }

    #[tokio::test]
    async fn source_work_reads_only_current_role_and_exact_connected_scope() {
        let (_root, handler, mut identity) = fixture();
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let source = json!({"providerId":"test-provider","profile":"account","kind":"inbox","id":"inbox","name":"Inbox","policy":{"automatic":true,"askBeforeAct":true}});
        let mut other = source.clone();
        other["id"] = json!("other");
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"][0]["connections"] = json!([source, other]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let work = store
            .ingest_stand_in_message(
                7,
                "default",
                &source,
                &json!({"id":"message","at":"2026-01-01T00:00:00Z","text":"hello"}),
                None,
            )
            .unwrap();
        let id = work["id"].as_str().unwrap();
        handler.upsert_local_task(link(id,7,json!({"type":"connection_work","userId":7,"deviceId":"mac","standInId":"default","workId":id})));
        let elsewhere = store
            .ingest_stand_in_message(
                7,
                "default",
                &other,
                &json!({"id":"other-message","at":"2026-01-01T00:00:00Z","text":"other"}),
                None,
            )
            .unwrap();
        let other_id = elsewhere["id"].as_str().unwrap();
        handler.upsert_local_task(link(other_id,7,json!({"type":"connection_work","userId":7,"deviceId":"mac","standInId":"default","workId":other_id})));
        identity.task_id = id.into();
        identity.work = Some(id.into());
        let page = handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
            .await
            .unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert_eq!(page["items"][0]["taskId"], id);
        assert!(handler
            .read_stand_in_conversations(&identity, "read_task", &json!({"taskId":"identity"}))
            .await
            .is_err());
        assert!(handler
            .read_stand_in_conversations(&identity, "read_task", &json!({"taskId":other_id}))
            .await
            .is_err());
        let mut revoked = store.personal_stand_in(7, "mac").unwrap();
        revoked["roles"][0]["connections"] = json!([]);
        store.save_personal_stand_in(7, "mac", revoked).unwrap();
        assert!(handler
            .read_stand_in_conversations(&identity, "list_tasks", &json!({}))
            .await
            .is_err());
    }
}
