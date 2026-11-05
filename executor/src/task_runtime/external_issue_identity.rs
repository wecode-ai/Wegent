// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Local collaboration identity for Issues owned by an external provider.
//! Provider records remain authoritative and are never stored as task rows.

use super::*;

fn find(
    connection: &Connection,
    project: &str,
    issue: &str,
) -> Result<Option<(String, Value)>, TaskRuntimeError> {
    let row: Option<(String, String)> = connection.query_row(
        "SELECT id, metadata FROM loop_items WHERE resource_type='external_issue_identity' AND cloud_project_id=?1 AND source=?2 AND deleted_at IS NULL",
        params![project, issue], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    row.map(|(id, metadata)| {
        serde_json::from_str(&metadata)
            .map(|metadata| (id, metadata))
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
    })
    .transpose()
}

fn apply(item: &mut LoopItem, metadata: &Value) {
    if let Some(creator) = metadata["creator_user_id"].as_i64() {
        item.created_by_user_id = creator;
    }
    item.metadata["reporter_user_id"] = metadata["reporter_user_id"].clone();
    item.metadata["follower_user_ids"] = metadata["follower_user_ids"].clone();
    if let Some(assignment) = metadata.get("assignment") {
        item.assignee_user_id = assignment["user_id"].as_i64();
        item.assignee_agent_id = assignment["agent_id"].as_str().map(str::to_owned);
        item.metadata["collaboration_group"] = assignment["group"].clone();
        item.metadata["assignee_label"] = Value::Null;
    }
}

fn record_receipt(
    connection: &Connection,
    project: &str,
    identity: &str,
    issue: &str,
    user: i64,
    since: i64,
    event: &str,
) -> Result<bool, TaskRuntimeError> {
    use sha2::{Digest, Sha256};
    let receipt = format!(
        "{:x}",
        Sha256::digest(format!("issue-follow:{project}:{issue}:{user}:{since}:{event}").as_bytes())
    );
    let timestamp = now();
    Ok(connection.execute("INSERT OR IGNORE INTO loop_items(id,resource_type,cloud_project_id,loop_item_id,created_at,updated_at) VALUES (?1,'issue_follow_event',?2,?3,?4,?4)",params![receipt,project,identity,timestamp])? == 1)
}

impl LocalTaskStore {
    pub(crate) fn defer_external_scan(
        &self,
        project: &str,
        task: &str,
    ) -> Result<(), TaskRuntimeError> {
        self.connection()?.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.follow_poll.next_at',?1) WHERE resource_type='external_issue_identity' AND cloud_project_id=?2 AND source=?3",params![chrono::Utc::now().timestamp_millis()+300_000,project,task])?;
        Ok(())
    }
    pub(crate) fn aitable_assignment(
        &self,
        project: &LoopItem,
        user: Option<i64>,
        agent: Option<&str>,
        group: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        if usize::from(user.is_some()) + usize::from(agent.is_some()) + usize::from(group.is_some())
            > 1
            || user.is_some_and(|user| user <= 0)
        {
            return Err(TaskRuntimeError::Invalid(
                "Choose one valid Issue assignee".into(),
            ));
        }
        self.validate_external_assignee(project, agent, group)?;
        Ok(
            json!({"user_id":user,"agent_id":agent,"group":group.map(|group|collaboration_group(project,group)).transpose()?}),
        )
    }

    pub(crate) fn set_aitable_assignment(
        &self,
        mut item: LoopItem,
        assignment: Value,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let project = item
            .cloud_project_id
            .as_deref()
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (id, mut metadata) =
            find(&tx, project, &item.id)?.ok_or(TaskRuntimeError::TaskNotFound)?;
        let changed = metadata["assignment"] != assignment;
        metadata["assignment"] = assignment;
        tx.execute(
            "UPDATE loop_items SET metadata=?1 WHERE id=?2",
            params![metadata.to_string(), id],
        )?;
        if changed {
            let mut state = item.clone();
            state.id = id;
            state.metadata = metadata.clone();
            issue_notifications::notify_issue(&tx, &state, &item.id, "assignee", None, "")?;
        }
        tx.commit()?;
        apply(&mut item, &metadata);
        Ok(item)
    }

    pub(crate) fn followed_external_issues(
        &self,
    ) -> Result<Vec<(String, String, Value)>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT cloud_project_id, source, metadata FROM loop_items WHERE resource_type='external_issue_identity' AND deleted_at IS NULL AND json_array_length(json_extract(metadata,'$.follower_user_ids'))>0 AND COALESCE(json_extract(metadata,'$.follow_poll.next_at'),0)<=?1 ORDER BY COALESCE(json_extract(metadata,'$.follow_poll.next_at'),0),id LIMIT 100",
        )?;
        let rows = statement
            .query_map([chrono::Utc::now().timestamp_millis()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(project, task, metadata)| {
                let metadata: Value = serde_json::from_str(&metadata)
                    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
                Ok((project, task, metadata["follow_poll"].clone()))
            })
            .collect()
    }

    pub(crate) fn commit_external_event_page(
        &self,
        source: &LoopItem,
        item: &LoopItem,
        cursor: &Value,
        events: &[super::super::issue_follow_events::Event],
        next: &Value,
    ) -> Result<bool, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project = item
            .cloud_project_id
            .as_deref()
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let Some(current_project) = get_item_from(&tx, project, "project")? else {
            return Ok(false);
        };
        if current_project.metadata["task_provider"] != source.metadata["task_provider"]
            || current_project.metadata["provider_config"] != source.metadata["provider_config"]
        {
            return Ok(false);
        }
        let Some((id, mut metadata)) = find(&tx, project, &item.id)? else {
            return Ok(false);
        };
        if metadata["follow_poll"] != *cursor {
            return Ok(false);
        }
        for event in events {
            for user in metadata["follower_user_ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_i64)
            {
                let since = metadata["follower_since"][user.to_string()]
                    .as_i64()
                    .unwrap_or(i64::MAX);
                if event.occurred_at.is_some_and(|at| at + 999 < since) {
                    continue;
                }
                if !record_receipt(&tx, project, &id, &item.id, user, since, &event.identity)? {
                    continue;
                }
                let mut state = item.clone();
                state.id = id.clone();
                state.metadata = metadata.clone();
                state.metadata["follower_user_ids"] = json!([user]);
                issue_notifications::notify_issue(
                    &tx,
                    &state,
                    &item.id,
                    &event.kind,
                    event.comment_id.as_deref(),
                    &event.body,
                )?;
            }
        }
        metadata["follow_poll"] = next.clone();
        tx.execute(
            "UPDATE loop_items SET metadata=?1 WHERE id=?2",
            params![metadata.to_string(), id],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub(crate) fn create_external_comment(
        &self,
        create: &LocalCommentCreate,
        item: &LoopItem,
    ) -> Result<LocalComment, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let comment = insert_comment(&tx, create, "completed")?;
        if let Some((id, metadata)) = find(&tx, &create.project_id, &create.task_id)? {
            let mut state = item.clone();
            state.id = id;
            state.metadata = metadata;
            issue_notifications::notify_issue(
                &tx,
                &state,
                &create.task_id,
                "comment",
                Some(&comment.message_id),
                &comment.content,
            )?;
        }
        tx.commit()?;
        Ok(comment)
    }

    pub(crate) fn overlay_external_issue(
        &self,
        mut item: LoopItem,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let project = item
            .cloud_project_id
            .as_deref()
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let connection = self.connection()?;
        if let Some((_, metadata)) = find(&connection, project, &item.id)? {
            apply(&mut item, &metadata);
        }
        Ok(item)
    }

    pub(crate) fn overlay_external_issues(
        &self,
        mut items: Vec<LoopItem>,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let Some(first) = items.first() else {
            return Ok(items);
        };
        let project = first
            .cloud_project_id
            .clone()
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT source, metadata FROM loop_items WHERE resource_type='external_issue_identity' AND cloud_project_id=?1 AND deleted_at IS NULL",
        )?;
        let rows = statement.query_map([&project], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut identities = HashMap::new();
        for row in rows {
            let (id, metadata) = row?;
            identities.insert(
                id,
                serde_json::from_str::<Value>(&metadata)
                    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?,
            );
        }
        for item in &mut items {
            if item.cloud_project_id.as_deref() != Some(project.as_str()) {
                return Err(TaskRuntimeError::Invalid(
                    "External issues belong to different projects".into(),
                ));
            }
            if let Some(metadata) = identities.get(&item.id) {
                apply(item, metadata);
            }
        }
        Ok(items)
    }

    pub(crate) fn update_external_identity(
        &self,
        item: LoopItem,
        creator: Option<i64>,
        reporter: Option<i64>,
        follow: Option<(i64, bool)>,
    ) -> Result<LoopItem, TaskRuntimeError> {
        self.update_external_identity_with_baseline(item, creator, reporter, follow, &[])
    }

    pub(crate) fn update_external_identity_with_baseline(
        &self,
        mut item: LoopItem,
        creator: Option<i64>,
        reporter: Option<i64>,
        follow: Option<(i64, bool)>,
        baseline: &[super::super::issue_follow_events::Event],
    ) -> Result<LoopItem, TaskRuntimeError> {
        let project = item
            .cloud_project_id
            .as_deref()
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = find(&tx, project, &item.id)?;
        if existing.is_none()
            && creator.is_none()
            && reporter.is_none()
            && matches!(follow, Some((_, false)))
        {
            tx.commit()?;
            return Ok(item);
        }
        let (id, mut metadata) = existing.unwrap_or_else(|| {
            let creator = creator.unwrap_or(item.created_by_user_id);
            (Uuid::new_v4().to_string(), json!({"creator_user_id":creator,"reporter_user_id":creator,"follower_user_ids":[]}))
        });
        let mut new_subscription = None;
        if let Some(reporter) = reporter {
            metadata["reporter_user_id"] = json!(reporter);
        }
        if let Some((user, following)) = follow {
            let mut users = metadata["follower_user_ids"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            users.retain(|value| value.as_i64() != Some(user));
            if following {
                users.push(json!(user));
                let key = user.to_string();
                if !metadata["follower_since"].is_object() {
                    metadata["follower_since"] = json!({});
                }
                if metadata["follower_since"][&key].is_null() {
                    let since = chrono::Utc::now().timestamp_millis();
                    metadata["follower_since"][&key] = json!(since);
                    new_subscription = Some((user, since));
                }
            } else if let Some(since) = metadata["follower_since"].as_object_mut() {
                since.remove(&user.to_string());
            }
            metadata["follower_user_ids"] = json!(users);
        }
        let timestamp = now();
        tx.execute(
            "INSERT INTO loop_items(id,resource_type,cloud_project_id,source,metadata,created_at,updated_at) VALUES (?1,'external_issue_identity',?2,?3,?4,?5,?5) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",
            params![id, project, item.id, metadata.to_string(), timestamp],
        )?;
        if let Some((user, since)) = new_subscription {
            for event in baseline {
                record_receipt(&tx, project, &id, &item.id, user, since, &event.identity)?;
            }
        }
        tx.commit()?;
        apply(&mut item, &metadata);
        Ok(item)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_runtime::issue_follow_events::Event;

    fn setup() -> (tempfile::TempDir, LocalTaskStore, LoopItem) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "External".into(),
                project_key: Some("GH".into()),
                description: String::new(),
                task_provider: TaskProviderKind::Github,
                provider_config: json!({"repository":"acme/repo"}),
            })
            .unwrap();
        let mut issue = project.clone();
        issue.id = "GH-7".into();
        issue.resource_type = "task".into();
        issue.cloud_project_id = Some(project.id);
        issue.title = Some("Issue".into());
        issue.metadata = json!({});
        (directory, store, issue)
    }

    fn event(id: &str) -> Event {
        Event {
            identity: id.into(),
            kind: "comment".into(),
            occurred_at: None,
            comment_id: Some(id.into()),
            body: "Update".into(),
        }
    }

    fn commit(
        store: &LocalTaskStore,
        issue: &LoopItem,
        cursor: &Value,
        events: &[Event],
        next: &Value,
    ) -> bool {
        let project = store
            .get_project(issue.cloud_project_id.as_deref().unwrap())
            .unwrap();
        store
            .commit_external_event_page(&project, issue, cursor, events, next)
            .unwrap()
    }

    #[test]
    fn baseline_and_receipts_survive_restart_and_stale_pages() {
        let (directory, store, issue) = setup();
        let old = event("old");
        let new = event("new");
        store
            .update_external_identity_with_baseline(
                issue.clone(),
                Some(17),
                None,
                Some((17, true)),
                std::slice::from_ref(&old),
            )
            .unwrap();
        let next = json!({"stream":0,"token":2});
        assert!(commit(
            &store,
            &issue,
            &Value::Null,
            &[old.clone(), new.clone()],
            &next
        ));
        assert_eq!(store.list_issue_notifications(17).unwrap().len(), 1);
        assert!(!commit(
            &store,
            &issue,
            &Value::Null,
            std::slice::from_ref(&new),
            &next
        ));
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        assert!(commit(&store, &issue, &next, &[old, new], &Value::Null));
        let notifications = store.list_issue_notifications(17).unwrap();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0]["payload"]["commentId"], "new");
        assert_eq!(notifications[0]["payload"]["itemId"], issue.id);
    }

    #[test]
    fn unsubscribe_during_collection_and_resubscribe_never_replays_old_events() {
        let (_directory, store, issue) = setup();
        store
            .update_external_identity(issue.clone(), Some(17), None, Some((17, true)))
            .unwrap();
        store
            .update_external_identity(issue.clone(), None, None, Some((17, false)))
            .unwrap();
        let old = event("during-unfollow");
        assert!(commit(
            &store,
            &issue,
            &Value::Null,
            std::slice::from_ref(&old),
            &json!({"page":2})
        ));
        assert!(store.list_issue_notifications(17).unwrap().is_empty());
        store
            .update_external_identity_with_baseline(
                issue.clone(),
                None,
                None,
                Some((17, true)),
                std::slice::from_ref(&old),
            )
            .unwrap();
        assert!(commit(
            &store,
            &issue,
            &json!({"page":2}),
            &[old, event("after-refollow")],
            &Value::Null
        ));
        let notifications = store.list_issue_notifications(17).unwrap();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0]["payload"]["commentId"], "after-refollow");
    }

    #[test]
    fn aitable_assignment_is_owned_by_wework_and_never_changes_followers() {
        let (_directory, store, issue) = setup();
        let issue = store
            .update_external_identity(issue, Some(17), None, Some((17, true)))
            .unwrap();
        let assigned = store
            .set_aitable_assignment(issue, json!({"user_id":17,"agent_id":null,"group":null}))
            .unwrap();
        assert_eq!(assigned.assignee_user_id, Some(17));
        assert_eq!(assigned.metadata["follower_user_ids"], json!([17]));
        let reloaded = store.overlay_external_issue(assigned).unwrap();
        assert_eq!(reloaded.assignee_user_id, Some(17));
        let cleared = store
            .set_aitable_assignment(
                reloaded,
                json!({"user_id":null,"agent_id":null,"group":null}),
            )
            .unwrap();
        assert_eq!(cleared.assignee_user_id, None);
        assert_eq!(cleared.created_by_user_id, 17);
        assert_eq!(store.list_issue_notifications(17).unwrap().len(), 2);
    }

    #[test]
    fn source_change_during_collection_cannot_deliver_old_source_events() {
        let (_directory, store, issue) = setup();
        store
            .update_external_identity(issue.clone(), Some(17), None, Some((17, true)))
            .unwrap();
        let project = store
            .get_project(issue.cloud_project_id.as_deref().unwrap())
            .unwrap();
        let mut changed = project.metadata.clone();
        changed["provider_config"]["repository"] = json!("acme/other");
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET metadata=?1 WHERE id=?2",
                params![changed.to_string(), project.id],
            )
            .unwrap();
        assert!(!store
            .commit_external_event_page(
                &project,
                &issue,
                &Value::Null,
                &[event("from-old-source")],
                &json!({"page":2})
            )
            .unwrap());
        assert!(store.list_issue_notifications(17).unwrap().is_empty());
    }
}
