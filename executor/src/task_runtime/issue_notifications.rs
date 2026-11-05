//! Local Issue inbox entries commit with the change that generated them.

use super::*;

pub(super) fn notify_followers(
    connection: &Connection,
    task_id: &str,
    event: &str,
    comment_id: Option<&str>,
    body: &str,
) -> Result<(), TaskRuntimeError> {
    let Some(issue) = get_item_from(connection, task_id, "task")? else {
        return Ok(());
    };
    notify_issue(connection, &issue, task_id, event, comment_id, body)
}

pub(super) fn notify_issue(
    connection: &Connection,
    issue: &LoopItem,
    task_id: &str,
    event: &str,
    comment_id: Option<&str>,
    body: &str,
) -> Result<(), TaskRuntimeError> {
    let Some(project_id) = issue.cloud_project_id.as_deref() else {
        return Ok(());
    };
    let Some(project) = get_item_from(connection, project_id, "project")? else {
        return Ok(());
    };
    let title = match event {
        "comment" => "关注的 Issue 有新评论",
        "status" => "关注的 Issue 状态已变更",
        "assignee" => "关注的 Issue 负责人已变更",
        _ => {
            return Err(TaskRuntimeError::Invalid(
                "Unknown Issue notification".to_owned(),
            ))
        }
    };
    let timestamp = now();
    for user_id in issue.metadata["follower_user_ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_i64)
    {
        let enabled: Option<bool> = connection
            .query_row(
                "SELECT json_extract(metadata,'$.in_app') FROM loop_items WHERE id=?1 AND resource_type='issue_notification_preferences' AND user_id=?2",
                params![format!("local-issue-preferences:{user_id}"), user_id],
                |row| row.get(0),
            )
            .optional()?;
        if enabled == Some(false) {
            continue;
        }
        let id = format!("local-issue-notification:{}", Uuid::new_v4());
        let issue_title = issue.title.as_deref().unwrap_or_default();
        let payload = json!({"projectId":project_id,"projectName":project.name,"itemId":task_id,"itemTitle":issue_title,"itemStatus":issue.status,"commentId":comment_id,"event":event});
        let notification = json!({"id":id,"kind":"issue_follow","title":title,
            "body":if body.is_empty(){issue_title}else{body},
            "url":format!("wework://boards/local/{project_id}/issues/{task_id}"),
            "payload":payload,"created_at":timestamp,"read_at":null});
        connection.execute(
            "INSERT INTO loop_items(id,resource_type,cloud_project_id,loop_item_id,user_id,metadata,created_at,updated_at) VALUES (?1,'issue_notification',?2,?3,?4,?5,?6,?6)",
            params![id, project_id, issue.id, user_id, notification.to_string(), timestamp],
        )?;
    }
    Ok(())
}

impl LocalTaskStore {
    pub fn set_issue_notification_preference(
        &self,
        user_id: i64,
        in_app: bool,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let timestamp = now();
        connection.execute(
            "INSERT INTO loop_items(id,resource_type,user_id,metadata,created_at,updated_at) VALUES (?1,'issue_notification_preferences',?2,?3,?4,?4) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",
            params![format!("local-issue-preferences:{user_id}"), user_id, json!({"in_app":in_app}).to_string(), timestamp],
        )?;
        Ok(())
    }

    pub fn list_issue_notifications(&self, user_id: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT n.metadata FROM loop_items n JOIN loop_items p ON p.id=n.cloud_project_id JOIN loop_items i ON i.id=n.loop_item_id WHERE n.resource_type='issue_notification' AND n.user_id=?1 AND p.deleted_at IS NULL AND i.deleted_at IS NULL ORDER BY n.created_at DESC,n.id DESC",
        )?;
        let rows = statement.query_map(params![user_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            serde_json::from_str(&row?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .collect()
    }

    pub fn read_issue_notifications(
        &self,
        user_id: i64,
        notification_id: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        connection.execute(
            "UPDATE loop_items SET metadata=json_set(metadata,'$.read_at',?1),updated_at=?1 WHERE resource_type='issue_notification' AND user_id=?2 AND (?3 IS NULL OR id=?3) AND json_extract(metadata,'$.read_at') IS NULL",
            params![now(), user_id, notification_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_preference_survives_reload_and_is_scoped_to_the_follower() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Preferences".into(),
                project_key: Some("PREF".into()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Followed"})).unwrap(),
            )
            .unwrap();
        store
            .set_task_following(&project.id, &issue.id, 17, true)
            .unwrap();
        store
            .set_task_following(&project.id, &issue.id, 18, true)
            .unwrap();
        store.set_issue_notification_preference(17, false).unwrap();
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let issue = store.get_task(&project.id, &issue.id).unwrap();
        {
            let connection = store.connection().unwrap();
            notify_issue(&connection, &issue, &issue.id, "status", None, "").unwrap();
        }
        assert!(store.list_issue_notifications(17).unwrap().is_empty());
        assert_eq!(store.list_issue_notifications(18).unwrap().len(), 1);
        store.set_issue_notification_preference(17, true).unwrap();
        {
            let connection = store.connection().unwrap();
            notify_issue(&connection, &issue, &issue.id, "assignee", None, "").unwrap();
        }
        assert_eq!(store.list_issue_notifications(17).unwrap().len(), 1);
        assert_eq!(store.list_issue_notifications(18).unwrap().len(), 2);
    }

    #[test]
    fn local_inbox_does_not_drop_notifications_after_the_first_hundred() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Inbox".into(),
                project_key: Some("INBOX".into()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Followed"})).unwrap(),
            )
            .unwrap();
        let issue = store
            .set_task_following(&project.id, &issue.id, 17, true)
            .unwrap();
        let connection = store.connection().unwrap();
        for _ in 0..101 {
            notify_issue(&connection, &issue, &issue.id, "comment", None, "Update").unwrap();
        }
        drop(connection);
        assert_eq!(store.list_issue_notifications(17).unwrap().len(), 101);
        assert!(store.list_issue_notifications(18).unwrap().is_empty());
        store.read_issue_notifications(17, None).unwrap();
        assert!(store
            .list_issue_notifications(17)
            .unwrap()
            .iter()
            .all(|item| item["read_at"].is_string()));
    }
}
