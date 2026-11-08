//! Deterministic page traversal separates completed evidence from the current attempt.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;

fn pending_reads(args: &Value, page: &Value) -> Result<Vec<Value>, AppIpcError> {
    let mut next = Vec::new();
    let keys: &[&str] = if args["messageContentCursor"].is_string() {
        &["messageContentCursor"]
    } else if args["beforeCursor"].is_string() {
        &["beforeCursor"]
    } else if args["afterCursor"].is_string() {
        &["afterCursor"]
    } else {
        &["beforeCursor", "afterCursor"]
    };
    for key in keys {
        if let Some(cursor) = page[*key].as_str() {
            let mut read = json!({});
            read[*key] = json!(cursor);
            next.push(read);
        }
    }
    for message in page["messages"].as_array().into_iter().flatten() {
        if let Some(cursor) = message["messageContentCursor"].as_str() {
            next.push(json!({"messageContentCursor":cursor}));
        } else if message["contentComplete"] == false {
            return Err(AppIpcError::new(
                "incomplete_history",
                "Message content is incomplete without a continuation",
            ));
        }
    }
    if page
        .get("textContentMayBeIncomplete")
        .unwrap_or(&page["sourceContentMayBeIncomplete"])
        == true
    {
        return Err(AppIpcError::new(
            "incomplete_history",
            "Source history is truncated; progress was not advanced",
        ));
    }
    if args["messageContentCursor"].is_string()
        && page["contentComplete"] == false
        && !page["messageContentCursor"].is_string()
    {
        return Err(AppIpcError::new(
            "incomplete_history",
            "Content continuation is missing",
        ));
    }
    Ok(next)
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn memory_progress_operation(
        &self,
        identity: &StandInMcpIdentity,
        name: &str,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        if !identity.memory_review || identity.review || identity.readonly_worker {
            return Err(AppIpcError::new(
                "permission_denied",
                "Memory review identity required",
            ));
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        if name == "list_memory_sources" {
            let mut page = self
                .read_stand_in_conversations(identity, "list_tasks", args)
                .await?;
            let mut pending = Vec::new();
            for item in page["items"].as_array().into_iter().flatten() {
                let source = item["taskId"].as_str().unwrap_or_default();
                let state = store
                    .memory_review_progress(identity.user, source)
                    .map_err(super::stand_in::settings_error)?;
                let updated = item["updatedAt"].as_i64().unwrap_or(0);
                if updated == 0
                    || updated >= state["completedThrough"].as_i64().unwrap_or(0)
                    || self.local_task_link(source).is_some_and(|link| {
                        super::stand_in_memory_attachments::has_memory_attachments(&link, i64::MAX)
                    })
                {
                    pending.push(item.clone());
                }
            }
            page["items"] = json!(pending);
            return Ok(page);
        }
        let source = super::stand_in_tasks::required(args, "taskId")?;
        let gate = self.task_send_gate(&format!("memory-source:{}:{source}", identity.user));
        let _guard = gate.lock().await;
        let actor = self
            .local_task_link(&identity.task_id)
            .ok_or_else(|| AppIpcError::new("permission_denied", "Memory review is unavailable"))?;
        let through = self
            .scheduled_review_run_end(&actor, identity.user, true)?
            .timestamp_millis();
        let run = actor.runtime_handle["executionRequest"]["standInSchedule"]["runId"]
            .as_str()
            .ok_or_else(|| AppIpcError::new("permission_denied", "Missing memory review run"))?;
        let state = store
            .memory_review_progress(identity.user, source)
            .map_err(super::stand_in::settings_error)?;
        let version = state["version"].as_i64().unwrap_or(0);
        if name == "complete_memory_source" {
            // Revalidate the current source grant even when all earlier reads succeeded.
            self.read_stand_in_conversations(
                identity,
                "read_task",
                &json!({"taskId":source,"limit":1}),
            )
            .await?;
            let link = self
                .local_task_link(source)
                .ok_or_else(|| AppIpcError::new("permission_denied", "Source is unavailable"))?;
            self.verify_memory_attachment_coverage(identity, &link, through, &state, &store)
                .await?;
            return store
                .complete_memory_review_source(identity.user, source, run, version)
                .map_err(super::stand_in::settings_error);
        }
        let continuing =
            state["runId"] == run && state["readStarted"] == true && args["restart"] != true;
        let mut pending = if continuing {
            state["pending"].as_array().cloned().unwrap_or_default()
        } else {
            vec![json!({})]
        };
        let Some(mut read) = pending.pop() else {
            let writes = state["pendingWrites"].as_array().map_or(0, Vec::len);
            let link = self
                .local_task_link(source)
                .ok_or_else(|| AppIpcError::new("permission_denied", "Source is unavailable"))?;
            self.validate_history_delivery(identity, &link, &store)?;
            let attachments = super::stand_in_memory_attachments::unread_memory_attachment_count(
                &link, through, &state,
            );
            return Ok(
                json!({"readyToComplete":writes == 0 && attachments == 0,"historyReadComplete":true,"unreadAttachmentCount":attachments,"pendingWriteCount":writes,"taskId":source,"version":version}),
            );
        };
        read["taskId"] = json!(source);
        read["since"] = json!(chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
            state["completedThrough"].as_i64().unwrap_or(0)
        ));
        read["until"] = json!(chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
            through
        ));
        let page = self
            .read_stand_in_conversations(identity, "read_task", &read)
            .await?;
        let link = self
            .local_task_link(source)
            .ok_or_else(|| AppIpcError::new("permission_denied", "Source is unavailable"))?;
        if !super::stand_in_memory_attachments::page_attachments_are_bound(&link, through, &page) {
            return Err(AppIpcError::new(
                "incomplete_attachments",
                "History contains attachments without a readable upload binding",
            ));
        }
        pending.extend(pending_reads(&read, &page)?);
        let state = store
            .record_memory_review_page(identity.user, source, run, through, version, json!(pending))
            .map_err(super::stand_in::settings_error)?;
        let writes = state["pendingWrites"].as_array().map_or(0, Vec::len);
        let attachments = super::stand_in_memory_attachments::unread_memory_attachment_count(
            &link, through, &state,
        );
        Ok(
            json!({"page":page,"readArguments":read,"version":state["version"],"pendingWriteCount":writes,"historyReadComplete":pending.is_empty(),"unreadAttachmentCount":attachments,"readyToComplete":pending.is_empty() && writes == 0 && attachments == 0}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn memory_traversal_follows_content_and_forward_direction_without_navigation_loops() {
        let page = json!({"beforeCursor":"older","afterCursor":"newer","messages":[{"messageContentCursor":"rest"}]});
        assert_eq!(pending_reads(&json!({}), &page).unwrap().len(), 3);
        let next = pending_reads(&json!({"beforeCursor":"current"}), &page).unwrap();
        assert_eq!(
            next,
            vec![
                json!({"beforeCursor":"older"}),
                json!({"messageContentCursor":"rest"})
            ]
        );
        assert!(pending_reads(&json!({}), &json!({"sourceContentMayBeIncomplete":true})).is_err());
        assert!(pending_reads(
            &json!({}),
            &json!({
                "sourceContentMayBeIncomplete":true,"textContentMayBeIncomplete":false,
                "messages":[{"contentComplete":true,"unreadAttachmentCount":1}]
            })
        )
        .is_ok());
        assert!(
            pending_reads(&json!({}), &json!({"messages":[{"contentComplete":false}]})).is_err()
        );
    }
}
