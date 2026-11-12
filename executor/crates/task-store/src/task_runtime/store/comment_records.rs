use super::*;

impl LocalTaskStore {
    pub fn publish_stand_in_reply(
        &self,
        device: &str,
        task: &str,
        user: i64,
        origin: &Value,
        message: &str,
        body: &str,
    ) -> Result<LocalComment, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project = origin["cloudProjectId"].as_str().unwrap_or_default();
        let issue_id = origin["loopItemId"].as_str().unwrap_or_default();
        let issue =
            get_item_from(&transaction, issue_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
        let binding = get_binding_by_kind(&transaction, device, task, false)?
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        if issue.cloud_project_id.as_deref() != Some(project)
            || binding.cloud_project_id != project
            || binding.loop_item_id.as_deref() != Some(issue_id)
            || origin["userId"] != user
        {
            return Err(TaskRuntimeError::Invalid(
                "Stand-in Issue conversation owner does not match".into(),
            ));
        }
        chat_groups::require_participation(&transaction, project, issue_id, false)?;
        let sender = format!(
            "stand-in:{user}:{}",
            origin["standInId"].as_str().unwrap_or_default()
        );
        let existing = transaction.query_row(
            "SELECT message_id FROM loop_item_comments WHERE project_id=?1 AND task_id=?2 AND sender_type='agent' AND sender_id=?3 AND client_message_id=?4",
            params![project,issue_id,sender,message], |row| row.get::<_,String>(0),
        ).optional()?;
        if let Some(existing) = existing {
            let comment = comment_row(&transaction, &existing)?;
            if comment.content != body {
                return Err(TaskRuntimeError::Invalid(
                    "Public message identity has different content".into(),
                ));
            }
            return Ok(comment);
        }
        let comment = insert_comment(
            &transaction,
            &LocalCommentCreate {
                project_id: project.into(),
                task_id: issue_id.into(),
                client_message_id: Some(message.into()),
                sender_type: "agent".into(),
                sender_id: sender,
                sender_name: origin["roleName"]
                    .as_str()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or("Stand-in")
                    .into(),
                content: body.into(),
                metadata: json!({"execution_dispatch":"comment_only","stand_in":{"user_id":user,"role_id":origin["standInId"],"message_id":message}}),
                reply_to_message_id: None,
            },
            "completed",
        )?;
        transaction.commit()?;
        Ok(comment)
    }

    pub fn list_comments(
        &self,
        project_id: &str,
        task_id: &str,
        after_sequence: i64,
    ) -> Result<Vec<LocalComment>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT c.id, c.message_id, c.client_message_id, c.project_id, c.task_id,
                    c.sender_type, c.sender_id, c.sender_name, c.message_type, c.content,
                    c.metadata, c.trigger_message_id, c.reply_to_message_id,
                    c.thread_root_message_id, c.status, c.sequence_number, c.created_at, c.updated_at,
                    e.status, e.observed_state, e.sync_state
             FROM loop_item_comments c
             LEFT JOIN loop_item_executions e
               ON e.id = json_extract(c.metadata, '$.execution_id')
              AND e.cloud_project_id = c.project_id AND e.loop_item_id = c.task_id
              AND c.sender_type = 'agent' AND e.agent_id = c.sender_id
             WHERE c.project_id = ?1 AND c.task_id = ?2 AND c.deleted_at IS NULL
               AND c.sequence_number > ?3
             ORDER BY c.sequence_number ASC",
        )?;
        let rows = statement.query_map(params![project_id, task_id, after_sequence], |row| {
            let mut comment = map_comment(row)?;
            if let Some(status) = row.get::<_, Option<String>>(18)? {
                let observed: String = row.get(19)?;
                let sync: String = row.get(20)?;
                comment.metadata["run_status"] =
                    json!(local_execution_display_state(&status, &observed, &sync));
            }
            Ok(comment)
        })?;
        let mut comments = Vec::new();
        for comment in rows {
            comments.push(comment?);
        }
        Ok(comments)
    }

    pub fn create_comment(
        &self,
        create: &LocalCommentCreate,
    ) -> Result<LocalComment, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !create.task_id.is_empty() {
            chat_groups::require_participation(
                &transaction,
                &create.project_id,
                &create.task_id,
                false,
            )?;
        } else {
            let owner = chat_groups::work_container_from(&transaction, &create.project_id)?
                .ok_or(TaskRuntimeError::ProjectNotFound)?;
            if owner.resource_type == "chat_group" && owner.status.as_deref() != Some("active") {
                return Err(TaskRuntimeError::Invalid("Chat group is archived".into()));
            }
        }
        let comment = insert_comment(&transaction, create, "completed")?;
        transaction.commit()?;
        Ok(comment)
    }

    pub fn start_runtime_comment(
        &self,
        input: &LocalRuntimeCommentStart<'_>,
    ) -> Result<LocalComment, TaskRuntimeError> {
        let LocalRuntimeCommentStart {
            project_id,
            task_id,
            agent_id,
            trigger_message_id,
            runtime_device_id,
            runtime_task_id,
            prompt,
            model,
        } = *input;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        chat_groups::require_participation(&transaction, project_id, task_id, true)?;
        let group_agent = if get_item_from(&transaction, project_id, "chat_group")?.is_some() {
            Some(task_resource_agent(
                &transaction,
                project_id,
                task_id,
                agent_id,
            )?)
        } else {
            None
        };
        if let Some((message_id, status)) = transaction
            .query_row(
                "SELECT message_id, status FROM loop_item_comments
                 WHERE project_id=?1 AND task_id=?2 AND sender_type='agent'
                   AND reply_to_message_id=?3
                   AND json_extract(metadata,'$.runtime_address.deviceId')=?4
                   AND json_extract(metadata,'$.runtime_address.taskId')=?5
                   AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
                params![
                    project_id,
                    task_id,
                    trigger_message_id,
                    runtime_device_id,
                    runtime_task_id
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            let comment = comment_row(&transaction, &message_id)?;
            if group_agent.is_some() && comment.sender_id != agent_id {
                return Err(TaskRuntimeError::Invalid(
                    "Runtime comment belongs to another Agent binding".into(),
                ));
            }
            if matches!(status.as_str(), "pending" | "streaming") {
                move_runtime_comment_task_to_in_progress(&transaction, task_id, None)?;
            }
            transaction.commit()?;
            return Ok(comment);
        }
        let agent = if let Some(agent) = group_agent {
            agent
        } else {
            get_item_from(&transaction, agent_id, "chat_agent")?.ok_or_else(|| {
                TaskRuntimeError::Invalid("Robot is not active in this project".to_owned())
            })?
        };
        let comment = insert_comment(
            &transaction,
            &LocalCommentCreate {
                project_id: project_id.to_owned(),
                task_id: task_id.to_owned(),
                client_message_id: None,
                sender_type: "agent".to_owned(),
                sender_id: agent_id.to_owned(),
                sender_name: agent
                    .title
                    .or(agent.name)
                    .unwrap_or_else(|| "AI".to_owned()),
                content: String::new(),
                metadata: json!({
                    "runtime_address": {
                        "deviceId": runtime_device_id,
                        "taskId": runtime_task_id,
                    },
                    "prompt": prompt,
                    "model": model,
                }),
                reply_to_message_id: Some(trigger_message_id.to_owned()),
            },
            "streaming",
        )?;
        move_runtime_comment_task_to_in_progress(&transaction, task_id, None)?;
        transaction.commit()?;
        Ok(comment)
    }

    pub fn fail_runtime_comment(
        &self,
        message_id: &str,
        error: &str,
    ) -> Result<LocalComment, TaskRuntimeError> {
        let connection = self.connection()?;
        connection.execute(
            "UPDATE loop_item_comments SET status='failed', content=?1, updated_at=?2
             WHERE message_id=?3 AND sender_type='agent' AND deleted_at IS NULL",
            params![error, now(), message_id],
        )?;
        comment_row(&connection, message_id)
    }

    pub fn update_agent_comment_for_execution(
        &self,
        execution_id: i64,
        status: &str,
        content: &str,
    ) -> Result<Option<LocalComment>, TaskRuntimeError> {
        let connection = self.connection()?;
        let execution = execution_row(&connection, execution_id)?;
        let runtime_address = match (&execution.runtime_device_id, &execution.runtime_task_id) {
            (Some(device_id), Some(task_id)) => Some(json!({
                "deviceId": device_id,
                "taskId": task_id,
            })),
            _ => None,
        };
        let changed = connection.execute(
            "UPDATE loop_item_comments
             SET status = ?1, content = ?2, updated_at = ?3
             WHERE deleted_at IS NULL
               AND json_extract(metadata, '$.execution_id') = ?4",
            params![status, content, now(), execution_id],
        )?;
        if changed == 0 {
            create_execution_comment(&connection, execution_id, status, content)?;
        }
        if let Some(address) = &runtime_address {
            connection.execute(
                "UPDATE loop_item_comments
                 SET metadata = json_set(metadata, '$.runtime_address', json(?1))
                 WHERE deleted_at IS NULL
                   AND json_extract(metadata, '$.execution_id') = ?2",
                params![address.to_string(), execution_id],
            )?;
        }
        let message_id = connection.query_row(
            "SELECT message_id FROM loop_item_comments
             WHERE deleted_at IS NULL
               AND json_extract(metadata, '$.execution_id') = ?1
             ORDER BY id ASC LIMIT 1",
            params![execution_id],
            |row| row.get::<_, String>(0),
        )?;
        let comment = comment_row(&connection, &message_id)?;
        issue_badges::update_stored_source(
            &connection,
            &comment.task_id,
            &format!("comment:{message_id}"),
            &comment.content,
        )?;
        Ok(Some(comment))
    }

    // ------------------------------------------------------------------
    // Local execution lifecycle
    // ------------------------------------------------------------------
}

#[cfg(test)]
mod stand_in_reply_tests {
    use super::*;

    #[test]
    fn public_stand_in_reply_preserves_owned_conversations_after_reassignment() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Room"})).unwrap())
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Issue","assignee_user_id":7})).unwrap(),
            )
            .unwrap();
        let origin = json!({"userId":7,"cloudProjectId":project.id,"loopItemId":issue.id,"standInId":"review","roleName":"Review stand-in","humanAssignmentId":format!("{}-1",issue.id)});
        store
            .bind_task(
                &project.id,
                Some(&issue.id),
                None,
                serde_json::from_value(json!({"deviceId":"mac","taskId":"conversation"})).unwrap(),
                None,
            )
            .unwrap();
        let first = store
            .publish_stand_in_reply("mac", "conversation", 7, &origin, "first", "Received")
            .unwrap();
        assert_eq!(
            first.message_id,
            store
                .publish_stand_in_reply("mac", "conversation", 7, &origin, "first", "Received")
                .unwrap()
                .message_id
        );
        let result = store
            .publish_stand_in_reply("mac", "conversation", 7, &origin, "result", "Done")
            .unwrap();
        assert!(result.sequence_number > first.sequence_number);
        assert_eq!(first.sender_type, "agent");
        assert_eq!(first.metadata["execution_dispatch"], "comment_only");
        assert!(store
            .publish_stand_in_reply("mac", "conversation", 7, &origin, "first", "Changed")
            .is_err());
        let reassigned = store
            .update_task(
                &project.id,
                &issue.id,
                serde_json::from_value(json!({"version":issue.version,"assignee_user_id":8}))
                    .unwrap(),
            )
            .unwrap();
        store
            .publish_stand_in_reply("mac", "conversation", 7, &origin, "late", "Late")
            .unwrap();
        store
            .update_task(
                &project.id,
                &issue.id,
                serde_json::from_value(
                    json!({"version":reassigned.version,"assignee_user_id":null}),
                )
                .unwrap(),
            )
            .unwrap();
        store
            .publish_stand_in_reply(
                "mac",
                "conversation",
                7,
                &origin,
                "unassigned",
                "Still here",
            )
            .unwrap();
        assert!(store
            .publish_stand_in_reply("mac", "conversation", 8, &origin, "foreign", "Foreign")
            .is_err());
        store
            .unbind_task("mac", "conversation", Some(&issue.id))
            .unwrap();
        assert!(store
            .publish_stand_in_reply("mac", "conversation", 7, &origin, "unbound", "Unbound")
            .is_err());
        assert_eq!(
            store
                .list_comments(&project.id, &issue.id, 0)
                .unwrap()
                .len(),
            4
        );
    }
}
