use super::*;

impl LocalTaskStore {
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
            if matches!(status.as_str(), "pending" | "streaming") {
                move_runtime_comment_task_to_in_progress(&transaction, task_id, None)?;
            }
            let comment = comment_row(&transaction, &message_id)?;
            transaction.commit()?;
            return Ok(comment);
        }
        let agent = get_item_from(&transaction, agent_id, "chat_agent")?.ok_or_else(|| {
            TaskRuntimeError::Invalid("Robot is not active in this project".to_owned())
        })?;
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
