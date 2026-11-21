//! Restore completed activity content without changing its timestamp convention.

use super::*;

#[cfg(test)]
pub(in crate::socketio) async fn verify_restored_activity_timestamp(
    mysql: &impl brz_mysql::Mysql,
    since: chrono::DateTime<Utc>,
) -> anyhow::Result<()> {
    mysql.execute("UPDATE project_chat_messages SET status='completed',metadata=JSON_REMOVE(metadata,'$.execution_id') WHERE message_id='timestamp-message'", ()).await?;
    mysql
        .with_transaction(async |tx| {
            let message: Message = tx
                .fetch_one(
                    "SELECT * FROM project_chat_messages WHERE message_id='timestamp-message'",
                    (),
                )
                .await?;
            let payload =
                json!({"subtaskId":"timestamp-turn","eventSeq":5,"data":{"value":"Final result"}});
            let identity = RuntimeIdentity {
                event_name: "response.completed",
                runtime_task_id: "timestamp-task".into(),
                payload: &payload,
            };
            let restored = restore_discovered_activity(
                tx,
                &["timestamp-device".into()],
                "timestamp-task",
                &identity,
                true,
                message,
                None,
            )
            .await?
            .expect("completed activity is restored");
            crate::socketio::issue_timestamp_tests::assert_current(
                &restored.message["updatedAt"],
                since,
            );
            crate::socketio::issue_timestamp_tests::assert_current(
                &restored.message["metadata"]["activity_at"],
                since,
            );
            assert_eq!(restored.message["content"], "Final result");
            Ok(())
        })
        .await?;
    Ok(())
}

/// Restore the completed activity after its discovery and identity checks.
pub(super) async fn restore_discovered_activity<T: MysqlTransaction>(
    transaction: &mut T,
    device_ids: &[String],
    task_id: &str,
    identity: &RuntimeIdentity<'_>,
    accepted_terminal: bool,
    mut activity: Message,
    mut execution: Option<ExecutionRow>,
) -> MysqlResult<Option<Projected>> {
    if has_execution_id(&activity) && execution.is_none() {
        return Ok(None);
    }
    if let Some(current) = execution.as_ref()
        && !accepted_terminal
        && !can_restore_reconciled_completion(transaction, current, identity, &activity).await?
    {
        return Ok(None);
    }
    if execution.is_none() || accepted_terminal {
        if let Some(current) = execution.as_ref() {
            execution = reload_execution(transaction, current.id).await?;
        }
        let current = completed_activity_for_turn(
            transaction,
            device_ids,
            task_id,
            runtime_turn_id(identity.payload),
            client_message_id(identity.payload),
            true,
            true,
        )
        .await?;
        let Some(current) = current else {
            return Ok(None);
        };
        if current.id != activity.id {
            return Ok(None);
        }
        activity = current;
    }
    let sequence = event_seq(identity.payload);
    if runtime_event_is_stale(&activity, sequence, accepted_terminal) {
        return Ok(None);
    }
    let content = final_text(identity.payload);
    let mut changed = false;
    if let Some(text) = content.as_deref() {
        activity.content = text.to_owned();
        changed = true;
        if let Some(turn_id) = runtime_turn_id(identity.payload) {
            let mut metadata = activity.metadata.0.as_object().cloned().unwrap_or_default();
            metadata.insert("runtime_turn_id".into(), json!(turn_id));
            activity.metadata = brz_mysql::Json(Value::Object(metadata));
        }
    } else if execution.is_some() && !accepted_terminal {
        return Ok(None);
    }
    if let (Some(row), Some(sequence)) = (execution.as_mut(), sequence)
        && sequence > row.last_event_seq.unwrap_or(0)
    {
        row.last_event_seq = Some(sequence);
        transaction
            .execute(
                "UPDATE loop_item_executions SET last_event_seq=? \
                 WHERE loop_item_executions.id=?",
                (sequence, row.id),
            )
            .await?;
    }
    changed |= record_runtime_sequence(&mut activity, sequence);
    if changed || accepted_terminal {
        let now = Utc::now().naive_utc();
        activity.updated_at =
            crate::socketio::project_chat_messages::activity_database_timestamp(now);
        if accepted_terminal {
            activity.metadata.0["activity_at"] = json!(now.and_utc().to_rfc3339());
        }
        transaction
            .execute(
                "UPDATE project_chat_messages SET content=?, metadata=?, updated_at=? \
                 WHERE project_chat_messages.id=?",
                (
                    activity.content.as_str(),
                    brz_mysql::Json(activity.metadata.0.clone()),
                    activity.updated_at,
                    activity.id,
                ),
            )
            .await?;
    }
    Ok(Some(Projected {
        message: projected_view(&activity),
        delta: false,
        terminal_activity: (accepted_terminal || content.is_some())
            .then(|| (Box::new(activity), accepted_terminal)),
    }))
}
