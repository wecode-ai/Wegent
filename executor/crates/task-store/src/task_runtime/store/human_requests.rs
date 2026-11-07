//! Issue-owned questions survive app restarts independently of runtime progress.
use super::*;
use sha2::{Digest, Sha256};

pub struct IssueHumanRequestScope<'a> {
    pub project_id: &'a str,
    pub issue_id: &'a str,
}

impl LocalTaskStore {
    pub fn has_pending_issue_human_requests(
        &self,
        users: &[i64],
    ) -> Result<bool, TaskRuntimeError> {
        let connection = self.connection()?;
        pending_issue_human_requests_on(&connection, users)
    }

    pub fn pending_issue_human_requests_at(
        path: &Path,
        users: &[i64],
    ) -> Result<bool, TaskRuntimeError> {
        if !path
            .try_exists()
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?
        {
            return Ok(false);
        }
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        pending_issue_human_requests_on(&connection, users)
    }

    pub fn issue_human_request_inbox(&self, users: &[i64]) -> Result<Vec<Value>, TaskRuntimeError> {
        if users.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.connection()?;
        let mut statement = connection.prepare(&format!(
            "SELECT DISTINCT issue.metadata {}",
            human_request_index_scope(users)?
        ))?;
        let rows = statement.query_map(params_from_iter(users), |row| row.get::<_, String>(0))?;
        let mut requests = Vec::new();
        for row in rows {
            let metadata: Value = serde_json::from_str(&row?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            requests.extend(
                metadata["human_requests"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|request| {
                        (request["recipient_user_id"]
                            .as_i64()
                            .is_some_and(|user| users.contains(&user))
                            || (request["recipient_user_id"].is_null()
                                && request["responsible_user_id"]
                                    .as_i64()
                                    .is_some_and(|user| users.contains(&user))))
                            && matches!(request["status"].as_str(), Some("pending" | "answering"))
                    })
                    .cloned(),
            );
        }
        Ok(requests)
    }

    #[cfg(test)]
    fn accept_issue_human_reply(
        &self,
        project: &str,
        issue: &str,
        request: &str,
        user: i64,
        message: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let saved = claim_reply_on(&tx, project, issue, request, user, message)?;
        tx.commit()?;
        Ok(saved)
    }

    pub fn report_issue_human_request(
        &self,
        scope: IssueHumanRequestScope<'_>,
        device: &str,
        task: &str,
        item: &str,
        question: &str,
        questions: &[Value],
    ) -> Result<Value, TaskRuntimeError> {
        let IssueHumanRequestScope {
            project_id: project,
            issue_id: issue,
        } = scope;
        if [device, task, item, question]
            .iter()
            .any(|value| value.trim().is_empty())
            || question.len() > 20_000
        {
            return Err(TaskRuntimeError::Invalid(
                "Invalid question identity or content".into(),
            ));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let issue_row = get_item_from(&tx, issue, "task")?
            .filter(|row| row.cloud_project_id.as_deref() == Some(project))
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        require_open(&issue_row)?;
        let root: Option<(String,Option<String>)> = tx.query_row(
            "SELECT message_id,thread_root_message_id FROM loop_item_comments WHERE project_id=?1 AND task_id=?2 AND sender_type='agent' AND json_extract(metadata,'$.runtime_address.deviceId')=?3 AND json_extract(metadata,'$.runtime_address.taskId')=?4 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
            params![project,issue,device,task], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        let (source, root) = root.ok_or_else(|| {
            TaskRuntimeError::Invalid("Question has no owning Issue execution".into())
        })?;
        let root = root
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| source.clone());
        let id = format!("{:x}", Sha256::digest(format!("{device}\0{task}\0{item}")));
        let human_leader = issue_row
            .metadata
            .pointer("/collaboration_group/leader")
            .and_then(|leader| {
                (leader["kind"] == "human")
                    .then_some(leader["id"].as_str()?.parse::<i64>().ok()?)
                    .filter(|id| *id >= 0)
            });
        let responsible = issue_row
            .assignee_user_id
            .or(human_leader)
            .unwrap_or(issue_row.created_by_user_id);
        let responsible_name = if responsible == 0 {
            Some("local".to_owned())
        } else {
            issue_row
                .metadata
                .pointer("/collaboration_group/leader")
                .filter(|leader| {
                    leader["kind"] == "human"
                        && leader["id"].as_str().and_then(|id| id.parse::<i64>().ok())
                            == Some(responsible)
                })
                .and_then(|leader| leader["name"].as_str())
                .map(str::to_owned)
        };
        let mut metadata = issue_row.metadata;
        let mut all = metadata["human_requests"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if let Some(existing) = all.iter().find(|request| request["id"] == id) {
            return Ok(existing.clone());
        }
        let now = now();
        let request = json!({
            "id":id, "project_id":project, "issue_id":issue, "issue_title":issue_row.title,
            "root_comment_id":root, "source_message_id":source,
            "runtime_device_id":device, "runtime_task_id":task, "item_id":item, "question":question, "questions":questions,
            "recipient_user_id":null, "recipient_name":null, "responsible_user_id":responsible,"responsible_user_name":responsible_name,
            "blocks_progress":false, "status":"pending", "version":1, "created_at":now, "updated_at":now,
            "waiting_since":now,"events":[{"type":"requested","at":now,"to_user_id":responsible}]
        });
        all.push(request.clone());
        metadata["human_requests"] = json!(all);
        save_metadata(&tx, issue, &metadata)?;
        tx.commit()?;
        Ok(request)
    }

    pub fn set_issue_human_request_blocking(
        &self,
        scope: IssueHumanRequestScope<'_>,
        request: &str,
        version: i64,
        device: &str,
        task: &str,
        blocks_progress: bool,
    ) -> Result<Value, TaskRuntimeError> {
        let IssueHumanRequestScope {
            project_id: project,
            issue_id: issue,
        } = scope;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = get_item_from(&tx, issue, "task")?
            .filter(|row| row.cloud_project_id.as_deref() == Some(project))
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        require_open(&row)?;
        let mut metadata = row.metadata;
        let target = metadata["human_requests"]
            .as_array_mut()
            .and_then(|all| all.iter_mut().find(|target| target["id"] == request))
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        if target["runtime_device_id"] != device || target["runtime_task_id"] != task {
            return Err(TaskRuntimeError::Invalid(
                "Question belongs to another execution".into(),
            ));
        }
        if target["status"] != "pending" || target["version"].as_i64() != Some(version) {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let at = now();
        target["blocks_progress"] = json!(blocks_progress);
        target["version"] = json!(version + 1);
        target["updated_at"] = json!(at);
        record_event(
            target,
            json!({"type":"blocking_changed","at":at,"blocks_progress":blocks_progress}),
        );
        let saved = target.clone();
        save_metadata(&tx, issue, &metadata)?;
        tx.commit()?;
        Ok(saved)
    }

    pub fn list_issue_human_requests(
        &self,
        project: &str,
        issue: &str,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let issue = self.get_task(project, issue)?;
        Ok(issue.metadata["human_requests"]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    pub fn assign_issue_human_request(
        &self,
        scope: IssueHumanRequestScope<'_>,
        request: &str,
        version: i64,
        recipient: i64,
        name: &str,
        blocks_progress: Option<bool>,
    ) -> Result<Value, TaskRuntimeError> {
        let IssueHumanRequestScope {
            project_id: project,
            issue_id: issue,
        } = scope;
        if recipient < 0 || name.trim().is_empty() {
            return Err(TaskRuntimeError::Invalid("Assign a specific person".into()));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = get_item_from(&tx, issue, "task")?
            .filter(|row| row.cloud_project_id.as_deref() == Some(project))
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        require_open(&row)?;
        let mut metadata = row.metadata;
        let all = metadata["human_requests"]
            .as_array_mut()
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let target = all
            .iter_mut()
            .find(|target| target["id"] == request)
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        if target["version"].as_i64() != Some(version) || target["status"] != "pending" {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let previous = target["recipient_user_id"]
            .as_i64()
            .or_else(|| target["responsible_user_id"].as_i64());
        let at = now();
        if previous != Some(recipient) {
            target["waiting_since"] = json!(at);
        }
        record_event(
            target,
            json!({"type":"assigned","at":at,"from_user_id":previous,"to_user_id":recipient}),
        );
        target["recipient_user_id"] = json!(recipient);
        target["recipient_name"] = json!(name);
        if let Some(blocks) = blocks_progress {
            target["blocks_progress"] = json!(blocks);
        }
        target["version"] = json!(version + 1);
        target["updated_at"] = json!(at);
        let saved = target.clone();
        save_metadata(&tx, issue, &metadata)?;
        tx.commit()?;
        Ok(saved)
    }
}

fn record_event(request: &mut Value, event: Value) {
    let mut events = request["events"].as_array().cloned().unwrap_or_default();
    events.push(event);
    request["events"] = json!(events);
}

pub(super) fn claim_reply_on(
    connection: &Connection,
    project: &str,
    issue: &str,
    request: &str,
    user: i64,
    message: &str,
) -> Result<Value, TaskRuntimeError> {
    let row = get_item_from(connection, issue, "task")?
        .filter(|row| row.cloud_project_id.as_deref() == Some(project))
        .ok_or(TaskRuntimeError::TaskNotFound)?;
    require_open(&row)?;
    let comment = comment_row(connection, message)?;
    let mut metadata = row.metadata;
    let target = metadata["human_requests"]
        .as_array_mut()
        .and_then(|all| all.iter_mut().find(|target| target["id"] == request))
        .ok_or(TaskRuntimeError::TaskNotFound)?;
    if target["recipient_user_id"].as_i64() != Some(user)
        || comment.sender_id != user.to_string()
        || comment.project_id != project
        || comment.task_id != issue
        || comment
            .thread_root_message_id
            .as_deref()
            .or(comment.reply_to_message_id.as_deref())
            != target["root_comment_id"].as_str()
    {
        return Err(TaskRuntimeError::Invalid(
            "Answer is not authorized for this question".into(),
        ));
    }
    if target["status"] == "cancelled"
        || target["answer_message_id"]
            .as_str()
            .is_some_and(|id| id != message)
    {
        return Err(TaskRuntimeError::VersionConflict);
    }
    if target["status"] != "pending" {
        return Ok(target.clone());
    }
    target["answer_message_id"] = json!(message);
    target
        .as_object_mut()
        .expect("Question is an object")
        .remove("delivery_error");
    target["status"] = json!("answering");
    record_event(
        target,
        json!({"type":"answered","at":now(),"user_id":user,"message_id":message}),
    );
    target["version"] = json!(target["version"].as_i64().unwrap_or(1) + 1);
    target["updated_at"] = json!(now());
    let saved = target.clone();
    save_metadata(connection, issue, &metadata)?;
    Ok(saved)
}

fn require_open(issue: &LoopItem) -> Result<(), TaskRuntimeError> {
    if matches!(
        issue.status.as_deref(),
        Some("completed" | "cancelled" | "archived")
    ) {
        Err(TaskRuntimeError::Invalid("Issue has ended".into()))
    } else {
        Ok(())
    }
}

pub(super) fn settle_execution_reply(
    connection: &Connection,
    execution: &LocalExecution,
) -> Result<(), TaskRuntimeError> {
    update_execution_reply(connection, execution, true)
}

pub(super) fn reject_unstarted_execution_reply(
    connection: &Connection,
    execution: &LocalExecution,
) -> Result<(), TaskRuntimeError> {
    if execution.start_requested_at.is_some()
        || !matches!(execution.status.as_str(), "queued" | "claimed")
    {
        return Ok(());
    }
    update_execution_reply(connection, execution, false)
}

fn update_execution_reply(
    connection: &Connection,
    execution: &LocalExecution,
    accepted: bool,
) -> Result<(), TaskRuntimeError> {
    let Some(payload) = execution.execution_payload.as_ref() else {
        return Ok(());
    };
    let Some((request, message)) = payload["human_request_id"]
        .as_str()
        .zip(payload["trigger_message_id"].as_str())
    else {
        return Ok(());
    };
    let Some(row) = get_item_from(connection, &execution.loop_item_id, "task")? else {
        return Ok(());
    };
    let mut metadata = row.metadata;
    let Some(target) = metadata["human_requests"].as_array_mut().and_then(|all| {
        all.iter_mut().find(|target| {
            target["id"] == request
                && target["answer_message_id"] == message
                && target["status"] == "answering"
        })
    }) else {
        return Ok(());
    };
    if accepted && target["runtime_task_id"].as_str() != execution.runtime_task_id.as_deref() {
        return Err(TaskRuntimeError::Invalid(
            "Question execution binding changed".into(),
        ));
    }
    target["status"] = json!(if accepted { "resolved" } else { "pending" });
    if accepted {
        target
            .as_object_mut()
            .expect("Question is an object")
            .remove("delivery_error");
    } else {
        target["answer_message_id"] = Value::Null;
        target["delivery_error"] = json!("rejected");
    }
    record_event(
        target,
        json!({"type":if accepted { "accepted" } else { "delivery_rejected" },"at":now(),"message_id":message}),
    );
    target["updated_at"] = json!(now());
    target["version"] = json!(target["version"].as_i64().unwrap_or(1) + 1);
    save_metadata(connection, &execution.loop_item_id, &metadata)?;
    Ok(())
}

fn human_request_index_scope(users: &[i64]) -> Result<String, TaskRuntimeError> {
    if users.iter().any(|user| *user < 0) {
        return Err(TaskRuntimeError::Invalid(
            "Question viewer IDs must be non-negative".into(),
        ));
    }
    let placeholders = vec!["?"; users.len()].join(",");
    Ok(format!("FROM loop_items target JOIN loop_items issue ON issue.id=target.parent_id WHERE target.resource_type='human_request_index' AND target.assignee_user_id IN ({placeholders}) AND issue.resource_type='task' AND issue.deleted_at IS NULL AND issue.status NOT IN ('completed','cancelled','archived')"))
}

fn pending_issue_human_requests_on(
    connection: &Connection,
    users: &[i64],
) -> Result<bool, TaskRuntimeError> {
    if users.is_empty() {
        return Ok(false);
    }
    Ok(connection.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 {})",
            human_request_index_scope(users)?
        ),
        params_from_iter(users),
        |row| row.get(0),
    )?)
}

fn save_metadata(
    connection: &Connection,
    issue: &str,
    metadata: &Value,
) -> Result<(), TaskRuntimeError> {
    connection.execute(
        "UPDATE loop_items SET metadata=?1,version=version+1,updated_at=?2 WHERE id=?3",
        params![metadata.to_string(), now(), issue],
    )?;
    connection.execute(
        "DELETE FROM loop_items WHERE parent_id=?1 AND resource_type='human_request_index'",
        [issue],
    )?;
    for request in metadata["human_requests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|request| matches!(request["status"].as_str(), Some("pending" | "answering")))
    {
        let recipient = request["recipient_user_id"]
            .as_i64()
            .or_else(|| request["responsible_user_id"].as_i64());
        if let Some((recipient, id)) = recipient.zip(request["id"].as_str()) {
            let index = format!("{:x}", Sha256::digest(format!("human-request:{id}")));
            connection.execute("INSERT INTO loop_items (id,resource_type,parent_id,assignee_user_id,name,created_at,updated_at) VALUES (?1,'human_request_index',?2,?3,?4,?5,?5)",params![index,issue,recipient,id,now()])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (
        tempfile::TempDir,
        LocalTaskStore,
        LoopItem,
        LoopItem,
        LocalComment,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(
                serde_json::from_value(json!({"name":"Handoffs","project_key":"HAND"})).unwrap(),
            )
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Human decision"})).unwrap(),
            )
            .unwrap();
        let root = store
            .create_comment(&LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: issue.id.clone(),
                client_message_id: None,
                sender_type: "user".into(),
                sender_id: "0".into(),
                sender_name: "Local".into(),
                content: "Start".into(),
                metadata: json!({}),
                reply_to_message_id: None,
            })
            .unwrap();
        store
            .create_comment(&LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: issue.id.clone(),
                client_message_id: None,
                sender_type: "agent".into(),
                sender_id: "agent".into(),
                sender_name: "AI".into(),
                content: "Working".into(),
                metadata: json!({"runtime_address":{"deviceId":"device","taskId":"runtime"}}),
                reply_to_message_id: Some(root.message_id.clone()),
            })
            .unwrap();
        (directory, store, project, issue, root)
    }

    #[test]
    fn human_request_pending_hint_read_only_path_never_initializes_storage() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        assert!(!LocalTaskStore::pending_issue_human_requests_at(&path, &[0]).unwrap());
        assert!(!path.exists());
        let connection = Connection::open(&path).unwrap();
        connection.pragma_update(None, "user_version", 17).unwrap();
        drop(connection);
        assert!(LocalTaskStore::pending_issue_human_requests_at(&path, &[0]).is_err());
        let connection =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            17
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn human_request_pending_hint_uses_only_active_recipient_indexes() {
        let (_directory, store, project, issue, _) = fixture();
        assert!(!store.has_pending_issue_human_requests(&[0]).unwrap());
        let request = store
            .report_issue_human_request(
                IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id,
                },
                "device",
                "runtime",
                "hint",
                "Choose",
                &[],
            )
            .unwrap();
        assert!(store.has_pending_issue_human_requests(&[0]).unwrap());
        assert!(LocalTaskStore::pending_issue_human_requests_at(store.path(), &[0]).unwrap());
        assert!(!store.has_pending_issue_human_requests(&[7]).unwrap());
        store
            .assign_issue_human_request(
                IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id,
                },
                request["id"].as_str().unwrap(),
                1,
                7,
                "Other",
                None,
            )
            .unwrap();
        assert!(!store.has_pending_issue_human_requests(&[0]).unwrap());
        assert!(store.has_pending_issue_human_requests(&[7]).unwrap());
        assert!(store.has_pending_issue_human_requests(&[0, 7]).unwrap());
        assert!(LocalTaskStore::pending_issue_human_requests_at(store.path(), &[0, 7]).unwrap());
        assert_eq!(
            store.issue_human_request_inbox(&[0, 7, 7]).unwrap().len(),
            1
        );
        assert!(store.issue_human_request_inbox(&[0]).unwrap().is_empty());
        assert!(!store.has_pending_issue_human_requests(&[]).unwrap());
        assert!(store.issue_human_request_inbox(&[]).unwrap().is_empty());
        assert!(store.has_pending_issue_human_requests(&[-1]).is_err());
        let connection = store.connection().unwrap();
        connection
            .execute(
                "UPDATE loop_items SET metadata='{}' WHERE id=?1",
                [&issue.id],
            )
            .unwrap();
        drop(connection);
        assert!(
            store.has_pending_issue_human_requests(&[7]).unwrap(),
            "Hint must use its durable index without reading question metadata"
        );
        let connection = store.connection().unwrap();
        connection
            .execute(
                "UPDATE loop_items SET status='completed' WHERE id=?1",
                [&issue.id],
            )
            .unwrap();
        drop(connection);
        assert!(!store.has_pending_issue_human_requests(&[7]).unwrap());
    }

    #[test]
    fn human_request_blocking_changes_preserve_the_handoff_and_reject_other_executions() {
        let (_directory, store, project, issue, _) = fixture();
        let question = store
            .report_issue_human_request(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id,
                },
                "device",
                "runtime",
                "flag",
                "Choose scope",
                &[],
            )
            .unwrap();
        let id = question["id"].as_str().unwrap();
        for (device, task) in [("other", "runtime"), ("device", "other")] {
            assert!(store
                .set_issue_human_request_blocking(
                    crate::task_runtime::IssueHumanRequestScope {
                        project_id: &project.id,
                        issue_id: &issue.id
                    },
                    id,
                    1,
                    device,
                    task,
                    true
                )
                .is_err());
        }
        let changed = store
            .set_issue_human_request_blocking(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id,
                },
                id,
                1,
                "device",
                "runtime",
                true,
            )
            .unwrap();
        assert_eq!(changed["blocks_progress"], true);
        assert_eq!(changed["version"], 2);
        for key in [
            "waiting_since",
            "recipient_user_id",
            "responsible_user_id",
            "status",
            "root_comment_id",
        ] {
            assert_eq!(changed[key], question[key]);
        }
        assert_eq!(changed["events"][1]["type"], "blocking_changed");
        assert!(store
            .set_issue_human_request_blocking(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id
                },
                id,
                1,
                "device",
                "runtime",
                false
            )
            .is_err());
        let cleared = store
            .set_issue_human_request_blocking(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id,
                },
                id,
                2,
                "device",
                "runtime",
                false,
            )
            .unwrap();
        assert_eq!(cleared["blocks_progress"], false);
        assert_eq!(cleared["waiting_since"], question["waiting_since"]);
    }

    #[test]
    fn human_request_is_issue_owned_idempotent_and_restored() {
        let (directory, store, project, issue, root) = fixture();
        let first = store
            .report_issue_human_request(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id,
                },
                "device",
                "runtime",
                "question",
                "Choose scope",
                &[json!({"id":"scope","question":"Choose scope","options":[{"label":"Small"}]})],
            )
            .unwrap();
        assert_eq!(first["root_comment_id"], root.message_id);
        let assigned = store
            .assign_issue_human_request(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id,
                },
                first["id"].as_str().unwrap(),
                1,
                0,
                "Local",
                Some(true),
            )
            .unwrap();
        assert_eq!(assigned["blocks_progress"], true);
        assert_eq!(
            store
                .report_issue_human_request(
                    crate::task_runtime::IssueHumanRequestScope {
                        project_id: &project.id,
                        issue_id: &issue.id
                    },
                    "device",
                    "runtime",
                    "question",
                    "Choose scope",
                    &[],
                )
                .unwrap(),
            assigned
        );
        assert!(store
            .assign_issue_human_request(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id
                },
                first["id"].as_str().unwrap(),
                1,
                7,
                "Other",
                None
            )
            .is_err());
        drop(store);
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        assert_eq!(
            store.issue_human_request_inbox(&[0]).unwrap(),
            vec![assigned]
        );
        assert!(store.issue_human_request_inbox(&[7]).unwrap().is_empty());
    }

    #[test]
    fn human_request_rejects_foreign_sources_and_preserves_independent_questions() {
        let (_directory, store, project, issue, _) = fixture();
        assert!(store
            .report_issue_human_request(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id
                },
                "other-device",
                "runtime",
                "question",
                "Choose",
                &[],
            )
            .is_err());
        assert!(store
            .report_issue_human_request(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id
                },
                "device",
                "other-runtime",
                "question",
                "Choose",
                &[],
            )
            .is_err());
        for id in ["first", "second"] {
            store
                .report_issue_human_request(
                    crate::task_runtime::IssueHumanRequestScope {
                        project_id: &project.id,
                        issue_id: &issue.id,
                    },
                    "device",
                    "runtime",
                    id,
                    "Choose",
                    &[],
                )
                .unwrap();
        }
        assert_eq!(
            store
                .list_issue_human_requests(&project.id, &issue.id)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn human_request_answer_is_exact_and_queued_is_not_resolved() {
        let (_directory, store, project, issue, root) = fixture();
        let question = store
            .report_issue_human_request(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id,
                },
                "device",
                "runtime",
                "question",
                "Choose",
                &[],
            )
            .unwrap();
        let id = question["id"].as_str().unwrap();
        store
            .assign_issue_human_request(
                crate::task_runtime::IssueHumanRequestScope {
                    project_id: &project.id,
                    issue_id: &issue.id,
                },
                id,
                1,
                0,
                "Local",
                None,
            )
            .unwrap();
        let create = |body: &str| {
            store
                .create_comment(&LocalCommentCreate {
                    project_id: project.id.clone(),
                    task_id: issue.id.clone(),
                    client_message_id: None,
                    sender_type: "user".into(),
                    sender_id: "0".into(),
                    sender_name: "Local".into(),
                    content: body.into(),
                    metadata: json!({}),
                    reply_to_message_id: Some(root.message_id.clone()),
                })
                .unwrap()
        };
        let answer = create("Keep scope");
        assert!(store
            .accept_issue_human_reply(&project.id, &issue.id, id, 7, &answer.message_id)
            .is_err());
        let saved = store
            .accept_issue_human_reply(&project.id, &issue.id, id, 0, &answer.message_id)
            .unwrap();
        assert_eq!(saved["status"], "answering");
        assert_eq!(store.issue_human_request_inbox(&[0]).unwrap().len(), 1);
        assert!(store
            .accept_issue_human_reply(
                &project.id,
                &issue.id,
                id,
                0,
                &create("Duplicate").message_id
            )
            .is_err());
    }
}
