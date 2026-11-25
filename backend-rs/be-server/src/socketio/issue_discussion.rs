// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use brz_mysql::{Json, MysqlError, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};
use wegent_project_coordination::project_store::{DATABASE_NOW_SQL, Node};

use super::project_chat_mentions::preview;
use super::project_chat_messages::{InsertMessage, insert_message_on};
use super::project_chat_snapshot::advance_content_revision;
use crate::background_jobs::project::{issues, notifications};

/// Persist a human comment and notices in the caller's authorized transaction.
pub(crate) async fn publish_comment_on(
    tx: &mut impl MysqlTransaction,
    message: &InsertMessage<'_>,
    actor: i64,
    issue: Option<&Node>,
    recipients: &[i64],
    mut target: Value,
) -> MysqlResult<(i64, Vec<notifications::Pending>)> {
    if let Some(issue) = issue
        && (issue.id != message.task_id || issue.cloud_project_id != message.project_id)
    {
        return Err(MysqlError::RowNotFound);
    }
    let row_id = insert_message_on(tx, message).await?;
    let mut notices = Vec::with_capacity(recipients.len());
    if !recipients.is_empty() {
        let body = preview(message.content);
        let sender = message.sender_name;
        let title = match target["itemTitle"]
            .as_str()
            .filter(|title| !title.is_empty())
        {
            Some(title) => format!("{sender} 在「{title}」提到了你"),
            None => format!("{sender} 在评论中提到了你"),
        };
        target["actorName"] = json!(sender);
        target["commentId"] = json!(message.message_id);
        target["commentPreview"] = json!(body);
        for recipient in recipients
            .iter()
            .copied()
            .filter(|recipient| *recipient != actor)
        {
            notices.push(
                notifications::create_on(
                    tx,
                    recipient,
                    actor,
                    "mention",
                    &title,
                    &body,
                    target.clone(),
                )
                .await?,
            );
        }
    }
    if let Some(issue) = issue {
        let mut metadata = issue.meta();
        issues::update_change_request_source(
            &mut metadata,
            &format!("activity:{}", message.message_id),
            message.content,
        );
        advance_content_revision(
            metadata
                .as_object_mut()
                .expect("issue metadata is an object"),
            actor,
        );
        tx.execute(
            format!("UPDATE loop_items SET metadata=?,version=version+1,updated_at={DATABASE_NOW_SQL} WHERE id=?"),
            (Json(metadata), issue.id.as_str()),
        )
        .await?;
    }
    Ok((row_id, notices))
}
