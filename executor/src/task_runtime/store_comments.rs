// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl LocalTaskStore {
    pub fn start_runtime_comment(
        &self,
        create: &LocalCommentCreate,
    ) -> Result<LocalComment, TaskRuntimeError> {
        self.get_task(&create.project_id, &create.task_id)?;
        let device_id = create.metadata["runtime_address"]["deviceId"]
            .as_str()
            .ok_or_else(|| TaskRuntimeError::Invalid("Missing runtime device".into()))?;
        let task_id = create.metadata["runtime_address"]["taskId"]
            .as_str()
            .ok_or_else(|| TaskRuntimeError::Invalid("Missing runtime task".into()))?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let bound: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_items WHERE resource_type = 'execution'
             AND cloud_project_id = ?1 AND loop_item_id = ?2 AND device_id = ?3
             AND task_id = ?4 AND unlinked_at IS NULL AND deleted_at IS NULL)",
            params![create.project_id, create.task_id, device_id, task_id],
            |row| row.get(0),
        )?;
        if !bound {
            return Err(TaskRuntimeError::Invalid(
                "Task is not bound to this Issue".into(),
            ));
        }
        transaction.execute(
            "UPDATE loop_items SET metadata = json_set(COALESCE(metadata, '{}'), '$.conversation_only', 1)
             WHERE resource_type = 'execution' AND cloud_project_id = ?1 AND loop_item_id = ?2
             AND device_id = ?3 AND task_id = ?4 AND unlinked_at IS NULL AND deleted_at IS NULL",
            params![create.project_id, create.task_id, device_id, task_id],
        )?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT message_id FROM loop_item_comments WHERE project_id = ?1
             AND task_id = ?2 AND client_message_id = ?3 AND sender_type = 'agent'
             AND deleted_at IS NULL",
                params![create.project_id, create.task_id, create.client_message_id],
                |row| row.get(0),
            )
            .optional()?;
        let result = if let Some(id) = existing {
            comment_row(&transaction, &id)?
        } else {
            insert_comment(&transaction, create, "streaming")?
        };
        transaction.commit()?;
        Ok(result)
    }

    pub fn fail_runtime_comment(
        &self,
        project_id: &str,
        task_id: &str,
        message_id: &str,
        error: &str,
    ) -> Result<LocalComment, TaskRuntimeError> {
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE loop_item_comments SET status = 'failed', updated_at = ?1,
             metadata = json_set(metadata, '$.error', ?2)
             WHERE project_id = ?3 AND task_id = ?4 AND message_id = ?5
             AND sender_type = 'agent' AND deleted_at IS NULL",
            params![now(), error, project_id, task_id, message_id],
        )?;
        if changed == 0 {
            return Err(TaskRuntimeError::Invalid(
                "Activity does not belong to this Issue".into(),
            ));
        }
        comment_row(&connection, message_id)
    }

    pub fn finish_runtime_comments(
        &self,
        device_id: &str,
        task_id: &str,
        status: &str,
        content: &str,
    ) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        connection.execute(
            "UPDATE loop_item_comments SET status = ?1, content = ?2, updated_at = ?3
             WHERE sender_type = 'agent' AND status IN ('streaming', 'pending')
             AND json_extract(metadata, '$.runtime_address.deviceId') = ?4
             AND json_extract(metadata, '$.runtime_address.taskId') = ?5
             AND deleted_at IS NULL",
            params![status, content, now(), device_id, task_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_tasks_persist_turns_without_reopening_completed_issue() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Activity".into(),
                project_key: Some("ACT".into()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Completed Issue".into(),
                    description: String::new(),
                    status: "completed".into(),
                    priority: "medium".into(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let root = store
            .create_comment(&LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: issue.id.clone(),
                client_message_id: Some("root".into()),
                sender_type: "user".into(),
                sender_id: "1".into(),
                sender_name: "User".into(),
                content: "Start".into(),
                metadata: json!({}),
                reply_to_message_id: None,
            })
            .unwrap();
        let address = RuntimeTaskAddress {
            device_id: "device".into(),
            task_id: "runtime".into(),
            task_title: None,
            backend_task_id: None,
            workflow_node_id: None,
        };
        let mut response = LocalCommentCreate {
            project_id: project.id.clone(),
            task_id: issue.id.clone(),
            client_message_id: Some("turn-1".into()),
            sender_type: "agent".into(),
            sender_id: "runtime".into(),
            sender_name: "AI".into(),
            content: String::new(),
            metadata: json!({"runtime_address": {"deviceId": "device", "taskId": "runtime"}, "conversation_only": true}),
            reply_to_message_id: Some(root.message_id.clone()),
        };
        assert!(store.start_runtime_comment(&response).is_err());
        store
            .bind_task(&project.id, Some(&issue.id), None, address)
            .unwrap();
        let first = store.start_runtime_comment(&response).unwrap();
        assert_eq!(
            first.message_id,
            store.start_runtime_comment(&response).unwrap().message_id
        );
        assert_eq!(
            store
                .project_bound_task_status("device", "runtime", "running", 100)
                .unwrap(),
            0
        );
        store
            .finish_runtime_comments("device", "runtime", "completed", "First result")
            .unwrap();
        response.client_message_id = Some("turn-2".into());
        let second = store.start_runtime_comment(&response).unwrap();
        assert_ne!(first.message_id, second.message_id);
        store
            .finish_runtime_comments("device", "runtime", "completed", "Second result")
            .unwrap();
        let messages = store.list_comments(&project.id, &issue.id, 0).unwrap();
        assert_eq!(
            messages
                .iter()
                .find(|m| m.message_id == first.message_id)
                .unwrap()
                .content,
            "First result"
        );
        assert_eq!(
            messages
                .iter()
                .find(|m| m.message_id == second.message_id)
                .unwrap()
                .content,
            "Second result"
        );
        assert_eq!(
            store
                .get_task(&project.id, &issue.id)
                .unwrap()
                .status
                .as_deref(),
            Some("completed")
        );
        assert!(store
            .fail_runtime_comment(&project.id, "wrong-issue", &second.message_id, "error")
            .is_err());
        response.client_message_id = Some("turn-3".into());
        response.reply_to_message_id = Some("missing-root".into());
        assert!(store.start_runtime_comment(&response).is_err());
    }
}
