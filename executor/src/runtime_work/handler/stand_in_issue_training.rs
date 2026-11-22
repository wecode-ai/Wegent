//! Public Issue comments are reviewed in the same project and role that received the Issue.
use super::stand_in::settings_error;
use super::stand_in_ingress::message_time;
use super::*;
use crate::task_runtime::personal_stand_in::{
    issue_training_source, project_role, training_source_granted,
};
use futures_util::{stream, StreamExt};
use std::collections::BTreeMap;

fn denied() -> AppIpcError {
    AppIpcError::new(
        "permission_denied",
        "Issue history is not available to this role",
    )
}

fn invalid() -> AppIpcError {
    AppIpcError::new("incomplete_history", "Invalid Issue comment history")
}

pub(super) fn issue_delivery_at_completion(
    link: &RuntimeTaskLink,
    turn: &Value,
    request: &ExecutionRequest,
) -> Option<Value> {
    let origin = request.extra.get("origin")?;
    let context = request.extra.get("standInDeliveryContext")?;
    let source = context.get("issueSource")?.as_object()?;
    if origin["type"] != "issue_dispatch"
        || origin["initiatedBy"] != "stand_in"
        || [
            "cloudProjectId",
            "projectStore",
            "loopItemId",
            "userId",
            "standInId",
        ]
        .iter()
        .any(|key| origin[*key] != turn["origin"][*key])
        || source.get("id") != origin.get("loopItemId")
        || source.get("profile") != origin.get("projectStore")
        || source.get("projectId") != origin.get("cloudProjectId")
    {
        return None;
    }
    let initial_turn = link.runtime_handle["turnIdsBySubtask"][&request.subtask_id] == turn["turn"];
    let trigger = initial_turn
        .then(|| {
            request
                .extra
                .get("issue_comment_trigger_id")
                .filter(|id| **id == turn["triggerCommentId"])
                .or_else(|| {
                    request
                        .extra
                        .get("standInMentionForReview")
                        .filter(|id| **id == origin["triggerCommentId"])
                })
                .and_then(Value::as_str)
        })
        .flatten();
    let versions = crate::task_runtime::mcp::stand_in_turn_versions(request);
    Some(
        json!({"source":source,"roleDeviceId":context["roleDeviceId"],"requestId":trigger,
        "ghostVersion":versions.as_ref().map(|v|&v.0),"memoryVersion":versions.as_ref().map(|v|&v.1)}),
    )
}

impl RuntimeWorkRpcHandler {
    pub(super) fn record_issue_training_delivery(
        &self,
        store: &LocalTaskStore,
        user: i64,
        report: &Value,
        native_id: Option<&str>,
    ) {
        let delivery = &report["publicTurn"]["trainingDelivery"];
        let (Some(device), Some(role)) = (
            delivery["roleDeviceId"].as_str(),
            report["origin"]["standInId"].as_str(),
        ) else {
            return;
        };
        let versions = delivery["ghostVersion"]
            .as_str()
            .zip(delivery["memoryVersion"].as_str());
        if store
            .record_training_reply(
                user,
                &self.device_id,
                device,
                role,
                &delivery["source"],
                delivery["requestId"].as_str().unwrap_or_default(),
                report["body"].as_str().unwrap_or_default(),
                native_id,
                versions,
            )
            .is_err()
        {
            log_executor_event("Stand-in Issue reply receipt unavailable", &[]);
        }
    }

    pub(super) async fn visible_issue_review_sources(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role_id: &str,
    ) -> Result<std::collections::HashSet<String>, AppIpcError> {
        let roles: Vec<_> = self
            .connection_learning_roles(store, user)?
            .into_iter()
            .filter(|role| role["id"] == role_id)
            .collect();
        if roles.is_empty() {
            return Ok(Default::default());
        }
        let needed = store
            .issue_rework_source_ids(user, role_id)
            .map_err(settings_error)?;
        if needed.is_empty() {
            return Ok(needed);
        }
        let bindings = self
            .issue_training_sources(store, user, &roles)?
            .into_iter()
            .filter(|binding| {
                needed.contains(&LocalTaskStore::training_source_id(
                    role_id,
                    &binding["source"],
                ))
            });
        Ok(stream::iter(bindings)
            .map(|binding| async move {
                let source = &binding["source"];
                self.authorize_issue_training_source(store, user, role_id, source)
                    .await
                    .ok()?;
                Some(LocalTaskStore::training_source_id(role_id, source))
            })
            .buffer_unordered(4)
            .filter_map(std::future::ready)
            .collect()
            .await)
    }

    pub(super) fn issue_training_sources(
        &self,
        store: &LocalTaskStore,
        user: i64,
        roles: &[Value],
    ) -> Result<Vec<Value>, AppIpcError> {
        let mut sources = BTreeMap::new();
        let mut add = |role: &Value, project: &Value, storage: &Value, issue: &Value| {
            let (Some(project), Some(storage), Some(issue)) =
                (project.as_str(), storage.as_str(), issue.as_str())
            else {
                return;
            };
            if let Some(source) = issue_training_source(role, project, storage, issue) {
                let binding = json!({"roleId":role["id"],"source":source});
                sources.insert(
                    LocalTaskStore::training_source_id(
                        role["id"].as_str().unwrap_or_default(),
                        &source,
                    ),
                    binding,
                );
            }
        };
        if !roles
            .iter()
            .any(|role| role["collaboration"]["enabled"] == true)
        {
            return Ok(Vec::new());
        }
        for link in self.local_task_links(true) {
            let origin = &link.runtime_handle["origin"];
            if origin["type"] == "issue_dispatch"
                && origin["initiatedBy"] == "stand_in"
                && origin["publicConversation"] == true
                && origin["userId"] == user
                && !self.archived_link_is_deleted(&link)
            {
                if let Some(role) = roles.iter().find(|r| r["id"] == origin["standInId"]) {
                    add(
                        role,
                        &origin["cloudProjectId"],
                        &origin["projectStore"],
                        &origin["loopItemId"],
                    );
                }
            }
        }
        for row in store
            .observed_training_issues(user)
            .map_err(settings_error)?
        {
            if let Some(role) = roles.iter().find(|r| r["id"] == row["role"]) {
                add(role, &row["project"], &row["store"], &row["issue"]);
            }
        }
        Ok(sources.into_values().collect())
    }

    pub(super) async fn authorize_issue_training_source(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role_id: &str,
        source: &Value,
    ) -> Result<(), AppIpcError> {
        let role = self
            .connection_learning_roles(store, user)?
            .into_iter()
            .find(|r| r["id"] == role_id && training_source_granted(r, source))
            .ok_or_else(denied)?;
        let project = source["projectId"].as_str().ok_or_else(denied)?;
        let storage = source["profile"].as_str().ok_or_else(denied)?;
        if storage == "local" {
            return store
                .local_issue_review_visible(&role, source)
                .map_err(settings_error)?
                .then_some(())
                .ok_or_else(denied);
        }
        let issue = self
            .read_stand_in_issue(
                store,
                user,
                &json!({
                    "cloudProjectId":project,"projectStore":storage,"loopItemId":source["id"]
                }),
            )
            .await?;
        if super::personal_stand_in::matching_personal_roles(
            &[project_role(&role, user, project, storage)],
            &issue,
        )
        .is_empty()
        {
            return Err(denied());
        }
        Ok(())
    }

    pub(super) async fn issue_training_page(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role: &str,
        source: &Value,
        since: i64,
        through: i64,
        cursor: Option<&str>,
    ) -> Result<Value, AppIpcError> {
        self.authorize_issue_training_source(store, user, role, source)
            .await?;
        let project = source["projectId"].as_str().ok_or_else(denied)?;
        let issue = source["id"].as_str().ok_or_else(denied)?;
        let since = since.max(message_time(&source["enabledAfter"])?);
        let (rows, more, gap) = if source["profile"] == "local" {
            let after = cursor
                .map(str::parse::<i64>)
                .transpose()
                .map_err(|_| invalid())?
                .unwrap_or(0);
            let (comments, _, more) = store
                .list_comment_page(project, issue, after, 30, false)
                .map_err(settings_error)?;
            let rows = comments.into_iter().map(|c| json!({
                "id":c.message_id,"body":c.content,"created_at":c.created_at,"sequence_number":c.sequence_number,
                "actor_user_id":c.actor_user_id,"generation_source":c.generation_source,
                "assistant_source_declared":!c.metadata["assistant_source"].is_null(),
                "confirmation_state":c.confirmation_state,"publication_source":c.publication_source,
                "reply_to_comment_id":c.reply_to_message_id,"root_comment_id":c.thread_root_message_id
            })).collect();
            (rows, more, false)
        } else {
            if cursor.is_some() {
                return Err(invalid());
            }
            let path = format!(
                "{}?limit=100",
                issue_path(&[
                    "v1",
                    "cloud-projects",
                    project,
                    "loop-items",
                    issue,
                    "activity-comments"
                ])?
            );
            let response = self.get_cloud_issue_as(user, &path).await?;
            let mut page =
                Self::read_runtime_response(reqwest::Method::GET, &path, response).await?;
            let rows = std::mem::take(page.as_array_mut().ok_or_else(invalid)?);
            // The cloud endpoint returns the latest page at sequence zero. Overflow cannot
            // prove that the whole observation window was read.
            let overflow = rows.len() >= 100
                && !rows
                    .iter()
                    .any(|r| comment_time(&r["created_at"]).is_ok_and(|t| t < since));
            (rows, false, overflow)
        };
        let next = if more {
            Some(
                rows.last()
                    .and_then(|r| r["sequence_number"].as_i64())
                    .ok_or_else(invalid)?
                    .to_string(),
            )
        } else {
            None
        };
        let mut messages = Vec::new();
        let owner = user.to_string();
        let mut topics: std::collections::HashMap<_, _> = rows
            .iter()
            .filter_map(|row| {
                let id = row["id"].as_str()?;
                Some((
                    id,
                    row["root_comment_id"]
                        .as_str()
                        .or(row["reply_to_comment_id"].as_str())
                        .unwrap_or(id),
                ))
            })
            .collect();
        for row in &rows {
            let at = comment_time(&row["created_at"])?;
            if at < since || at >= through {
                continue;
            }
            let id = row["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?;
            let body = row["body"].as_str().ok_or_else(invalid)?;
            if body.is_empty() {
                continue;
            }
            let actor = row["actor_user_id"].as_str();
            let human = row["generation_source"] == "human"
                && row["publication_source"] == "human"
                && row["assistant_source_declared"] != true
                && row["confirmation_state"] == "not_required";
            let native_parent = row["reply_to_comment_id"].as_str();
            let request = if row["generation_source"] == "ai" {
                store
                    .training_reply_request_id(user, role, source, id)
                    .map_err(settings_error)?
            } else {
                None
            };
            let parent = native_parent.or(request.as_deref());
            let native_root = row["root_comment_id"].as_str().unwrap_or(id);
            let root = if native_parent.is_none() && request.is_some() {
                request
                    .as_deref()
                    .and_then(|request| topics.get(request).copied())
            } else {
                topics.get(native_root).copied().or(Some(native_root))
            };
            // A stand-in reply can be published at the top level even when its
            // originating run has an explicit native question. Descendants quoting
            // that reply belong to that same verified question thread.
            if let Some(root) = root {
                topics.insert(id, root);
            }
            let author = if human && actor == Some(&owner) {
                "owner"
            } else if human && actor.is_some_and(|s| !s.is_empty()) {
                "participant"
            } else if row["generation_source"] == "ai"
                && store
                    .training_reply_matches(
                        user,
                        role,
                        source,
                        id,
                        at,
                        parent.unwrap_or_default(),
                        body,
                        root,
                    )
                    .map_err(settings_error)?
            {
                "assistant"
            } else {
                "unknown"
            };
            let participant = actor.filter(|_| author == "participant").map(|id| {
                LocalTaskStore::coordination_event_version(&json!([user, role, source, id]))
            });
            let text: String = body.chars().take(2400).collect();
            messages.push(json!({"id":id,"author":author,"at":at,"content":text,"truncated":text.len()!=body.len(),
                "conversationId":issue,"topicId":root,"quotedMessageId":parent,"participantKey":participant}));
        }
        self.authorize_issue_training_source(store, user, role, source)
            .await?;
        let mut page = json!({"messages":messages,"hasMore":more,"nextCursor":next,
            "reviewCoverage":if gap {"partial"} else {"complete"}});
        if gap {
            page["coverageGap"] = json!({"reason":"issue_comment_window_exceeds_history_page"});
        }
        Ok(page)
    }
}

pub(super) fn issue_path(segments: &[&str]) -> Result<String, AppIpcError> {
    if segments.iter().any(|s| matches!(*s, "" | "." | "..")) {
        return Err(denied());
    }
    let mut url = reqwest::Url::parse("https://localhost/").expect("valid URL");
    url.path_segments_mut()
        .expect("hierarchical URL")
        .extend(segments.iter().copied());
    Ok(url.path().to_owned())
}

fn comment_time(timestamp: &Value) -> Result<i64, AppIpcError> {
    // Backend serializes naive UTC datetimes without an offset; local native rows carry one.
    if let Some(value) = timestamp.as_str() {
        if let Ok(at) = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
            return Ok(at.and_utc().timestamp_millis());
        }
    }
    message_time(timestamp)
}
