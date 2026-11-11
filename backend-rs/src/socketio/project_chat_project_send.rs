//! Project chat writes serialize with changes to their Thread owner.
use brz_mysql::MysqlTransaction;
use serde_json::{Map, Value, json};

use super::{SendRequest, ack_error, reply};
use crate::background_jobs::project::notifications;
use crate::board_snapshot::repository::ProjectAccess;
use crate::socketio::project_chat_mentions::{self, Mention};
use crate::socketio::project_chat_messages::{
    InsertMessage, existing_client_message, message_view, uuid4,
};
use crate::state::AppState;

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
    let reply = reply::resolve(state, request).await?;
    let mut mentions = request.mentions.clone();
    let mut metadata = Map::new();
    reply.apply_stand_in(&mut mentions, &mut metadata);
    let (recipients, mut target) = project_chat_mentions::recipients(
        state,
        user_id,
        access,
        request.task_id.as_deref(),
        &mentions,
    )
    .await?;
    metadata.insert("mentions".into(), json!(mentions));
    if !mentions.is_empty() && mentions.iter().all(Mention::is_user) {
        metadata.insert("execution_dispatch".into(), json!("comment_only"));
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
        reply_to_message_id: reply.reply_to.as_deref().unwrap_or_default(),
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
            let item = match crate::socketio::project_chat_write_scope::lock(
                tx,
                &request.project_id,
                request.task_id.as_deref(),
            )
            .await?
            {
                Ok(item) => item,
                Err(error) => return Ok(Err(error)),
            };
            let row = tx
                .execute(
                    crate::socketio::project_chat_messages::INSERT_MESSAGE_SQL,
                    crate::socketio::project_chat_messages::insert_message_args(&message),
                )
                .await?;
            let mut pending = Vec::with_capacity(recipients.len());
            for recipient in recipients
                .iter()
                .copied()
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
            if let Some(item_id) = request.task_id.as_deref() {
                if let Some(item) = item {
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
                for recipient in &recipients {
                    crate::stand_in_issue_events::enqueue_mention_on(
                        tx,
                        *recipient,
                        &request.project_id,
                        item_id,
                        &message_id,
                    )
                    .await?;
                }
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
            Ok(Ok((saved, pending)))
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, "project chat mention transaction failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })??;
    for notification in pending {
        notifications::deliver(state, notification).await;
    }
    Ok((message_view(&saved), true))
}
