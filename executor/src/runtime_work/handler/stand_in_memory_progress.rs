//! Deterministic page traversal separates completed evidence from the current attempt.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;
use wegent_local_task_store::store::IdentityReplyItem;

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
    if page["sourceContentMayBeIncomplete"] == true {
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
            if Self::is_training_list_cursor(args) {
                return self
                    .append_training_sources(&store, identity, args, json!({}))
                    .await;
            }
            let mut page = self
                .read_stand_in_conversations(identity, "list_tasks", args)
                .await?;
            let settings = store
                .configured_personal_stand_in(identity.user, &self.device_id)
                .map_err(super::stand_in::settings_error)?;
            let mut pending = Vec::new();
            for item in page["items"].as_array().into_iter().flatten() {
                let source = item["taskId"].as_str().unwrap_or_default();
                let state = store
                    .memory_review_progress(identity.user, source)
                    .map_err(super::stand_in::settings_error)?;
                let updated = item["updatedAt"].as_i64().unwrap_or(0);
                let reviewed = state["completedThrough"].as_i64().unwrap_or(0);
                let link = (item["kind"] == "identity")
                    .then(|| self.local_task_link(source))
                    .flatten();
                let observe = link.as_ref().is_some_and(|link| {
                    self.direct_learning_role(link, &settings, identity.user)
                        .is_some()
                        && timestamp_ms_field(&page, "windowEnd").is_some_and(|end| {
                            super::stand_in_identity_rework::identity_source_due(
                                link, reviewed, end,
                            )
                        })
                });
                if updated == 0 || updated >= reviewed || observe {
                    let mut item = item.clone();
                    if item["kind"] == "identity" {
                        item["trainingEligible"] =
                            json!(self.local_task_link(source).is_some_and(|link| {
                                super::stand_in_training::identity_learning_role(
                                    self, &link, &settings,
                                )
                                .is_some()
                            }));
                    }
                    pending.push(item);
                }
            }
            page["items"] = json!(pending);
            return self
                .append_training_sources(&store, identity, args, page)
                .await;
        }
        let source = super::stand_in_tasks::required(args, "taskId")?;
        let gate = self.task_send_gate(&format!("memory-source:{}:{source}", identity.user));
        if source.starts_with(super::stand_in_training_progress::SOURCE_PREFIX) {
            let _guard = tokio::time::timeout(Duration::from_secs(4), gate.lock())
                .await
                .map_err(|_| {
                    AppIpcError::new(
                        "source_busy",
                        "A read is already in progress for this source",
                    )
                })?;
            return self
                .training_progress_operation(&store, identity, name, args, source)
                .await;
        }
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
        let settings = store
            .configured_personal_stand_in(identity.user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let link = self.local_task_link(source);
        let role = link
            .as_ref()
            .and_then(|link| self.direct_learning_role(link, &settings, identity.user));
        if name == "complete_memory_source" {
            // Revalidate the current source grant even when all earlier reads succeeded.
            self.read_stand_in_conversations(
                identity,
                "read_task",
                &json!({"taskId":source,"limit":1}),
            )
            .await?;
            return store
                .complete_memory_review_source(
                    identity.user,
                    source,
                    run,
                    version,
                    role.is_some() && args["reworkReviewComplete"] == true,
                )
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
            return Ok(
                json!({"readyToComplete":writes == 0,"historyReadComplete":true,"pendingWriteCount":writes,"taskId":source,"version":version}),
            );
        };
        read["taskId"] = json!(source);
        let since = state["completedThrough"].as_i64().unwrap_or(0);
        read["since"] = json!(chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
            since
        ));
        read["until"] = json!(chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
            through
        ));
        let page = self
            .read_stand_in_conversations(identity, "read_task", &read)
            .await?;
        pending.extend(pending_reads(&read, &page)?);
        if let Some(role) = role {
            for message in page["messages"].as_array().into_iter().flatten() {
                if let (Some(turn_id), Some(item_id), Some(projected), Some(at)) = (
                    message["turnId"].as_str(),
                    message["nativeReplyItemId"].as_str(),
                    message["id"].as_str(),
                    timestamp_ms_field(message, "completedAt"),
                ) {
                    store
                        .observe_identity_training_reply(
                            identity.user,
                            role,
                            IdentityReplyItem {
                                task: source,
                                turn: turn_id,
                                item: item_id,
                            },
                            projected,
                            at,
                        )
                        .map_err(super::stand_in::settings_error)?;
                }
            }
        }
        let coverage = (role.is_some() && since < through && page["unknownTimestamps"] != true)
            .then_some(since);
        let state = store
            .record_memory_review_page(
                identity.user,
                source,
                run,
                through,
                version,
                json!(pending),
                coverage,
            )
            .map_err(super::stand_in::settings_error)?;
        let writes = state["pendingWrites"].as_array().map_or(0, Vec::len);
        Ok(
            json!({"page":page,"readArguments":read,"version":state["version"],"pendingWriteCount":writes,"historyReadComplete":pending.is_empty(),"readyToComplete":pending.is_empty() && writes == 0}),
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
        assert!(
            pending_reads(&json!({}), &json!({"messages":[{"contentComplete":false}]})).is_err()
        );
    }
}
