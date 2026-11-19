use super::record_rows::enrich_comment_actor;
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
        read_comment_rows(&connection, project_id, task_id, after_sequence, -1, false)
    }

    /// Return ascending comments with exact earlier/later flags from one bounded snapshot.
    pub fn list_comment_page(
        &self,
        project_id: &str,
        task_id: &str,
        after_sequence: i64,
        limit: usize,
        latest: bool,
    ) -> Result<(Vec<LocalComment>, bool, bool), TaskRuntimeError> {
        if after_sequence < 0 || !(1..=500).contains(&limit) {
            return Err(TaskRuntimeError::Invalid(
                "Invalid comment page range".into(),
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let mut comments = read_comment_rows(
            &transaction,
            project_id,
            task_id,
            after_sequence,
            (limit + 1) as i64,
            latest,
        )?;
        let has_later = !latest && comments.len() > limit;
        comments.truncate(limit);
        if latest {
            comments.reverse();
        }
        let earlier_boundary = comments.first().map_or(after_sequence, |comment| {
            comment.sequence_number.saturating_sub(1)
        });
        let has_earlier = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_item_comments
             WHERE project_id=?1 AND task_id=?2 AND deleted_at IS NULL
               AND sequence_number<=?3)",
            params![project_id, task_id, earlier_boundary],
            |row| row.get::<_, bool>(0),
        )?;
        transaction.commit()?;
        Ok((comments, has_earlier, has_later))
    }

    pub fn create_comment(
        &self,
        create: &LocalCommentCreate,
    ) -> Result<LocalComment, TaskRuntimeError> {
        self.create_comment_with_receipt(create, None)
    }

    pub fn create_comment_with_receipt(
        &self,
        create: &LocalCommentCreate,
        receipt: Option<&board_receipts::BoardWriteReceipt>,
    ) -> Result<LocalComment, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(receipt) = receipt {
            if let Some(result) = receipt.replay(&transaction)? {
                return Ok(result);
            }
        }
        let mut create = create.clone();
        if let Some(metadata) = create.metadata.as_object_mut() {
            metadata.remove("assistant_publication");
        }
        let comment = insert_comment(&transaction, &create, "completed")?;
        if let Some(receipt) = receipt {
            receipt.record(&transaction, &comment)?;
        }
        transaction.commit()?;
        Ok(comment)
    }

    pub fn publish_assistant_comment(
        &self,
        create: &LocalCommentCreate,
        device: &str,
        task: &str,
    ) -> Result<LocalComment, TaskRuntimeError> {
        if !create
            .client_message_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty())
        {
            return Err(TaskRuntimeError::Invalid(
                "Assistant publication requires a client message identity".into(),
            ));
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let binding =
            get_binding_by_kind(&tx, device, task, false)?.ok_or(TaskRuntimeError::TaskNotFound)?;
        let issue =
            get_item_from(&tx, &create.task_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
        // Native IPC runs as device owner 0; a connected account keeps its
        // actual author identity without gaining access to another owner's binding.
        if binding.cloud_project_id != create.project_id
            || binding.loop_item_id.as_deref() != Some(create.task_id.as_str())
            || issue.cloud_project_id.as_deref() != Some(create.project_id.as_str())
            || create.sender_type != "user"
            || (binding.task_user_id != 0 && create.sender_id != binding.task_user_id.to_string())
        {
            return Err(TaskRuntimeError::Invalid(
                "Assistant publication source does not match its owner and Issue".into(),
            ));
        }
        let publication = json!({"verified":true,"published_by":"human","binding_id":binding.id,"device_id":device,"task_id":task,"runtime_owner_user_id":binding.task_user_id});
        let existing = tx.query_row(
            "SELECT message_id FROM loop_item_comments WHERE project_id=?1 AND task_id=?2 AND sender_type='user' AND sender_id=?3 AND client_message_id=?4 AND deleted_at IS NULL",
            params![create.project_id, create.task_id, create.sender_id, create.client_message_id], |row| row.get::<_,String>(0),
        ).optional()?;
        if let Some(id) = existing {
            let comment = comment_row(&tx, &id)?;
            if comment.content != create.content
                || comment.metadata["assistant_publication"] != publication
            {
                return Err(TaskRuntimeError::Invalid(
                    "Publication identity has different content or source".into(),
                ));
            }
            return Ok(comment);
        }
        let mut create = create.clone();
        if !create.metadata.is_object() {
            create.metadata = json!({});
        }
        create.metadata["assistant_publication"] = publication;
        let comment = insert_comment(&tx, &create, "completed")?;
        tx.commit()?;
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

fn read_comment_rows(
    connection: &Connection,
    project_id: &str,
    task_id: &str,
    after_sequence: i64,
    limit: i64,
    latest: bool,
) -> Result<Vec<LocalComment>, TaskRuntimeError> {
    let direction = if latest { "DESC" } else { "ASC" };
    let mut statement = connection.prepare(&format!(
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
         ORDER BY c.sequence_number {direction} LIMIT ?4"
    ))?;
    let rows = statement.query_map(params![project_id, task_id, after_sequence, limit], |row| {
        let mut comment = map_comment(row)?;
        if let Some(status) = row.get::<_, Option<String>>(18)? {
            let observed: String = row.get(19)?;
            let sync: String = row.get(20)?;
            comment.metadata["run_status"] =
                json!(local_execution_display_state(&status, &observed, &sync));
        }
        Ok(comment)
    })?;
    let mut comments = rows.collect::<Result<Vec<_>, _>>()?;
    for comment in &mut comments {
        enrich_comment_actor(connection, comment)?;
    }
    Ok(comments)
}

#[cfg(test)]
mod stand_in_reply_tests {
    use super::super::runner_routing_tests::setup;
    use super::*;

    #[test]
    fn assistant_publication_validates_source_and_persists_provenance_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Room"})).unwrap())
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Issue"})).unwrap(),
            )
            .unwrap();
        store
            .bind_task(
                &project.id,
                Some(&issue.id),
                None,
                serde_json::from_value(json!({"deviceId":"mac","taskId":"private"})).unwrap(),
                None,
            )
            .unwrap();
        let mut input: LocalCommentCreate = serde_json::from_value(json!({"project_id":project.id,"task_id":issue.id,"client_message_id":"once","sender_type":"user","sender_id":"0","sender_name":"Owner","content":"Published summary","metadata":{}})).unwrap();
        for identity in [None, Some("".into()), Some("  ".into())] {
            let mut invalid = input.clone();
            invalid.client_message_id = identity;
            assert!(store
                .publish_assistant_comment(&invalid, "mac", "private")
                .is_err());
        }
        assert!(store
            .publish_assistant_comment(&input, "mac", "foreign")
            .is_err());
        assert!(store
            .list_comments(&project.id, &issue.id, 0)
            .unwrap()
            .is_empty());
        let published = store
            .publish_assistant_comment(&input, "mac", "private")
            .unwrap();
        assert_eq!(published.generation_source, "ai");
        assert_eq!(published.publication_source, "human");
        assert_eq!(published.confirmation_state, "authorized");
        let mut signed_in = input.clone();
        signed_in.client_message_id = Some("signed-in".into());
        signed_in.sender_id = "86".into();
        let signed_in = store
            .publish_assistant_comment(&signed_in, "mac", "private")
            .unwrap();
        assert_eq!(signed_in.actor_user_id.as_deref(), Some("86"));
        assert_eq!(signed_in.runtime_owner_user_id.as_deref(), Some("0"));
        assert_eq!(signed_in.generation_source, "ai");
        store.connection().unwrap().execute("UPDATE loop_items SET task_user_id=7 WHERE resource_type='execution' AND device_id='mac' AND task_id='private'", []).unwrap();
        let mut foreign = input.clone();
        foreign.sender_id = "86".into();
        assert!(store
            .publish_assistant_comment(&foreign, "mac", "private")
            .is_err());
        store.connection().unwrap().execute("UPDATE loop_items SET task_user_id=0 WHERE resource_type='execution' AND device_id='mac' AND task_id='private'", []).unwrap();
        assert_eq!(
            store
                .publish_assistant_comment(&input, "mac", "private")
                .unwrap()
                .message_id,
            published.message_id
        );
        input.content = "Changed summary".into();
        assert!(store
            .publish_assistant_comment(&input, "mac", "private")
            .is_err());
        input.client_message_id = Some("forged".into());
        input.metadata = json!({"assistant_publication":{"verified":true}});
        let ordinary = store.create_comment(&input).unwrap();
        assert_eq!(ordinary.generation_source, "human");
        assert_eq!(ordinary.confirmation_state, "not_required");
        assert_eq!(
            store
                .list_comments(&project.id, &issue.id, 0)
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn agent_runtime_owner_is_independent_from_its_trigger_actor() {
        for owner in [Some(0), Some(7), None] {
            let directory = tempfile::tempdir().unwrap();
            let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
            let project = store
                .create_project(serde_json::from_value(json!({"name":"Room"})).unwrap())
                .unwrap();
            let issue = store
                .create_task(
                    &project.id,
                    serde_json::from_value(json!({"title":"Issue"})).unwrap(),
                )
                .unwrap();
            let agent = store
                .create_chat_agent(
                    &project.id,
                    serde_json::from_value(json!({"name":"Shared agent"})).unwrap(),
                )
                .unwrap();
            store
                .connection()
                .unwrap()
                .execute(
                    "UPDATE loop_items SET created_by_user_id=?1 WHERE id=?2",
                    params![owner, agent.id],
                )
                .unwrap();
            let trigger = store.create_comment(&serde_json::from_value(json!({"project_id":project.id,"task_id":issue.id,"sender_type":"user","sender_id":"8","sender_name":"Trigger author","content":"Run","metadata":{}})).unwrap()).unwrap();
            let reply = store
                .start_runtime_comment(&LocalRuntimeCommentStart {
                    project_id: &project.id,
                    task_id: &issue.id,
                    agent_id: &agent.id,
                    trigger_message_id: &trigger.message_id,
                    runtime_device_id: "device",
                    runtime_task_id: "private",
                    prompt: None,
                    model: None,
                })
                .unwrap();
            let listed = store.list_comments(&project.id, &issue.id, 0).unwrap();
            let reply = listed
                .iter()
                .find(|row| row.message_id == reply.message_id)
                .unwrap();
            assert_eq!(reply.actor_user_id.as_deref(), Some("8"));
            assert_eq!(
                reply.runtime_owner_user_id.as_deref(),
                owner.map(|id| id.to_string()).as_deref()
            );
        }
    }

    #[test]
    fn comment_pages_reject_unbounded_or_invalid_ranges() {
        let (_directory, store, project, _agent, issue, _catalog) = setup();
        for limit in [0, 501, usize::MAX] {
            assert!(store
                .list_comment_page(&project.id, &issue.id, 0, limit, false)
                .is_err());
        }
        assert!(store
            .list_comment_page(&project.id, &issue.id, -1, 2, false)
            .is_err());
    }

    #[test]
    fn comment_pages_preserve_live_execution_activity_enrichment_and_authors() {
        let (_directory, store, project, agent, issue, _catalog) = setup();
        let execution = store
            .enqueue_execution(&project.id, &issue.id, &agent.id, json!({}), None)
            .unwrap();
        let check = |expected_status: &str| {
            let all = store.list_comments(&project.id, &issue.id, 0).unwrap();
            let expected = all
                .iter()
                .find(|comment| comment.metadata["execution_id"] == execution.id)
                .unwrap();
            for latest in [false, true] {
                let (page, earlier, later) = store
                    .list_comment_page(&project.id, &issue.id, 0, 2, latest)
                    .unwrap();
                let actual = page
                    .iter()
                    .find(|comment| comment.message_id == expected.message_id)
                    .unwrap();
                assert_eq!(actual.metadata["run_status"], expected_status);
                assert_eq!(actual.metadata, expected.metadata);
                assert_eq!(actual.sender_type, expected.sender_type);
                assert_eq!(actual.sender_id, expected.sender_id);
                assert_eq!(actual.sender_name, expected.sender_name);
                assert_eq!(actual.content, expected.content);
                assert!(!earlier);
                assert!(!later);
            }
        };
        check("queued");
        store.cancel_execution(execution.id, None).unwrap();
        check("cancelled");
    }

    #[test]
    fn comment_page_flags_use_visible_sequences_and_exclude_deleted_or_foreign_rows() {
        let (_directory, store, project, _agent, issue, _catalog) = setup();
        let mut comments = Vec::new();
        for index in 0..5 {
            comments.push(
                store
                    .create_comment(&LocalCommentCreate {
                        project_id: project.id.clone(),
                        task_id: issue.id.clone(),
                        client_message_id: None,
                        sender_type: "user".into(),
                        sender_id: "7".into(),
                        sender_name: "Reader".into(),
                        content: format!("Comment {index}"),
                        metadata: json!({}),
                        reply_to_message_id: None,
                    })
                    .unwrap(),
            );
        }
        let connection = store.connection().unwrap();
        connection
            .execute(
                "UPDATE loop_item_comments SET deleted_at=?1 WHERE message_id=?2 OR message_id=?3",
                params![now(), comments[0].message_id, comments[4].message_id],
            )
            .unwrap();
        drop(connection);
        let (first, earlier, later) = store
            .list_comment_page(&project.id, &issue.id, 0, 2, false)
            .unwrap();
        assert_eq!(first[0].message_id, comments[1].message_id);
        assert_eq!(first[1].message_id, comments[2].message_id);
        assert!(!earlier);
        assert!(later);
        let (latest, earlier, later) = store
            .list_comment_page(&project.id, &issue.id, 0, 2, true)
            .unwrap();
        assert_eq!(latest[0].message_id, comments[2].message_id);
        assert_eq!(latest[1].message_id, comments[3].message_id);
        assert!(earlier);
        assert!(!later);
        let (last, earlier, later) = store
            .list_comment_page(&project.id, &issue.id, first[1].sequence_number, 2, false)
            .unwrap();
        assert_eq!(last.len(), 1);
        assert_eq!(last[0].message_id, comments[3].message_id);
        assert!(earlier);
        assert!(!later);
        let (empty, earlier, later) = store
            .list_comment_page(
                &project.id,
                &issue.id,
                comments[4].sequence_number,
                2,
                false,
            )
            .unwrap();
        assert!(empty.is_empty());
        assert!(earlier);
        assert!(!later);
        let (foreign, earlier, later) = store
            .list_comment_page("another-project", &issue.id, 0, 2, false)
            .unwrap();
        assert!(foreign.is_empty());
        assert!(!earlier);
        assert!(!later);
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_item_comments SET deleted_at=?1 WHERE task_id=?2",
                params![now(), issue.id],
            )
            .unwrap();
        let (empty, earlier, later) = store
            .list_comment_page(
                &project.id,
                &issue.id,
                comments[4].sequence_number,
                2,
                false,
            )
            .unwrap();
        assert!(empty.is_empty());
        assert!(!earlier);
        assert!(!later);
    }

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
        assert_eq!(first.actor_user_id.as_deref(), Some("7"));
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
