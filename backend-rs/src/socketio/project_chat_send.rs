//! Transactional project-chat writes and their authorized recipient effects.
use super::*;

/// `ProjectChatService.send`: dedupe, reply context, insert, refresh, view.
pub(super) async fn send_message(
    state: &AppState,
    user_id: i64,
    user_name: &str,
    request: &SendRequest,
    access: &ProjectAccess,
) -> Result<(Value, bool), Value> {
    project_chat_mentions::validate_agents(state, &request.project_id, &request.mentions).await?;
    if let Some(existing) =
        existing_client_message(state, user_id, &request.client_message_id).await
    {
        if existing.project_id != request.project_id {
            return Err(ack_error(
                "MESSAGE_CONFLICT",
                "client_message_id already belongs to another project",
            ));
        }
        return Ok((message_view(&existing), false));
    }
    let reply = resolve_reply(state, request).await?;
    let stand_in_reply = reply.stand_in.filter(|_| request.mentions.is_empty());
    let inferred_mentions = stand_in_reply
        .as_ref()
        .map(|identity| {
            Mention::parse(Some(&json!([{
                "type":"user",
                "id":identity["user_id"].as_i64().unwrap().to_string(),
                "label":identity["name"],
            }])))
        })
        .transpose()
        .map_err(|error| ack_error("INVALID_MESSAGE", &error))?;
    let mentions = inferred_mentions.as_deref().unwrap_or(&request.mentions);
    let (recipients, mut target) = project_chat_mentions::recipients(
        state,
        user_id,
        access,
        request.task_id.as_deref(),
        mentions,
    )
    .await?;
    let mut metadata = Map::new();
    metadata.insert("mentions".into(), json!(mentions));
    if !mentions.is_empty() && mentions.iter().all(Mention::is_user) {
        metadata.insert("execution_dispatch".into(), json!("comment_only"));
    }
    if let Some(identity) = stand_in_reply {
        metadata.insert("stand_in_reply_to".into(), identity);
    }
    if let Some(model) = &request.model {
        metadata.insert("model".into(), Value::String(model.clone()));
    }
    let message_id = uuid4();
    let message = InsertMessage {
        message_id: &message_id,
        client_message_id: &request.client_message_id,
        project_id: &request.project_id,
        task_id: request.task_id.as_deref().unwrap_or_default(),
        sender_type: "user",
        sender_id: &user_id.to_string(),
        sender_name: user_name,
        message_type: "text",
        content: &request.content,
        metadata: Value::Object(metadata),
        trigger_message_id: "",
        reply_to_message_id: reply.message.as_deref().unwrap_or_default(),
        thread_root_message_id: reply.root.as_deref().unwrap_or_default(),
        agent_id: "",
        runtime_device_id: "",
        runtime_task_id: "",
        runtime_activity_key: "",
        status: "completed",
    };
    let preview = project_chat_mentions::preview(&request.content);
    let title = match target["itemTitle"]
        .as_str()
        .filter(|title| !title.is_empty())
    {
        Some(title) => format!("{user_name} 在「{title}」提到了你"),
        None => format!("{user_name} 在评论中提到了你"),
    };
    target["actorName"] = json!(user_name);
    target["commentId"] = json!(message_id);
    target["commentPreview"] = json!(preview);
    if let Some(reply_preview) = reply.preview.filter(|preview| !preview.is_empty()) {
        target["replyPreview"] = json!(reply_preview);
    }
    let (saved, pending) = state
        .mysql
        .with_transaction(async |tx| {
            let row = tx
                .execute(
                    crate::socketio::project_chat_messages::INSERT_MESSAGE_SQL,
                    crate::socketio::project_chat_messages::insert_message_args(&message),
                )
                .await?;
            if let Some(issue) = request.task_id.as_deref() {
                crate::socketio::project_chat_wakeups::enqueue(
                    tx,
                    &recipients,
                    &request.project_id,
                    issue,
                    &message_id,
                )
                .await?;
            }
            let mut pending = Vec::with_capacity(recipients.len());
            for recipient in recipients
                .into_iter()
                .filter(|recipient| *recipient != user_id)
            {
                pending.push(
                    notifications::create_on(
                        tx,
                        state,
                        recipient,
                        user_id,
                        "mention",
                        &title,
                        &preview,
                        target.clone(),
                    )
                    .await?,
                );
            }
            if let Some(item_id) = request.task_id.as_deref()
                && let Some(item) =
                    crate::background_jobs::project::store::locked(tx, "task", item_id).await?
                && item.cloud_project_id == request.project_id
            {
                let mut metadata = item.meta();
                crate::background_jobs::project::issues::update_change_request_source(
                    &mut metadata,
                    &format!("activity:{message_id}"),
                    &request.content,
                );
                crate::socketio::project_chat_snapshot::advance_content_revision(
                    metadata
                        .as_object_mut()
                        .expect("issue metadata is an object"),
                    user_id,
                );
                tx.execute(
                    "UPDATE loop_items SET metadata=?, version=version+1 WHERE id=?",
                    (brz_mysql::Json(metadata), item_id),
                )
                .await?;
            }
            let saved: crate::socketio::project_chat_messages::MessageRow = tx
                .fetch_optional(
                    format!(
                        "SELECT {} FROM project_chat_messages WHERE id = ? LIMIT 1",
                        crate::socketio::project_chat_messages::MESSAGE_COLUMNS
                    ),
                    (row.last_insert_id as i64,),
                )
                .await?
                .ok_or_else(|| brz_mysql::MysqlError::InvalidQuery {
                    reason: "message refresh lost the row".to_owned(),
                })?;
            Ok((saved, pending))
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, "project chat mention transaction failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })?;
    for notification in pending {
        notifications::deliver(state, notification).await;
    }
    Ok((message_view(&saved), true))
}

#[derive(Default)]
struct ReplyContext {
    message: Option<String>,
    root: Option<String>,
    preview: Option<String>,
    stand_in: Option<Value>,
}

async fn resolve_reply(state: &AppState, request: &SendRequest) -> Result<ReplyContext, Value> {
    let Some(reply_to) = request.reply_to_message_id.as_deref() else {
        return Ok(ReplyContext::default());
    };
    let Some(target) = load_message_by_message_id(state, &request.project_id, reply_to).await?
    else {
        return Err(ack_error(
            "SCOPE_NOT_FOUND",
            "reply target message not found",
        ));
    };
    if target.task_id != request.task_id.clone().unwrap_or_default() {
        return Err(ack_error(
            "INVALID_MESSAGE",
            "reply target belongs to a different task thread",
        ));
    }
    let root = if target.thread_root_message_id.is_empty() {
        target.message_id.clone()
    } else {
        target.thread_root_message_id.clone()
    };
    Ok(ReplyContext {
        message: Some(reply_to.to_string()),
        root: Some(root),
        preview: Some(project_chat_mentions::preview(&target.content)),
        stand_in: stand_in_recipient(&target.sender_type, &target.sender_name, &target.metadata()),
    })
}

fn stand_in_recipient(sender_type: &str, name: &str, metadata: &Value) -> Option<Value> {
    let identity = &metadata["stand_in"];
    (sender_type == "agent").then_some(())?;
    let user = identity["user_id"].as_i64()?;
    let role = identity["role_id"].as_str()?;
    Some(json!({"user_id":user,"role_id":role,"name":name}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_routing_requires_a_persisted_agent_identity_and_exact_integer_owner() {
        let metadata = json!({"stand_in":{"user_id":7,"role_id":"reviewer"}});
        assert_eq!(
            stand_in_recipient("agent", "Reviewer", &metadata),
            Some(json!({"user_id":7,"role_id":"reviewer","name":"Reviewer"}))
        );
        assert!(stand_in_recipient("user", "Spoofed", &metadata).is_none());
        assert!(stand_in_recipient("agent", "Reviewer", &json!({})).is_none());
        for user in [json!("7"), json!(7.5), json!(null), json!(true)] {
            assert!(
                stand_in_recipient(
                    "agent",
                    "Reviewer",
                    &json!({"stand_in":{"user_id":user,"role_id":"reviewer"}})
                )
                .is_none()
            );
        }
    }
}
