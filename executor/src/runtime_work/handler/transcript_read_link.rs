// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Bounded native reads must not copy an unrelated cached transcript under the task lock.
use super::super::transcript_work::Cancellation;
use super::transcript_overlays::{is_running_runtime_command, is_runtime_user_interaction};
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn reconcile_native_transcript_terminal(&self, task_id: &str, thread: &Value) {
        if thread["timeline"] != true || self.is_active_local_task(task_id) {
            return;
        }
        self.store.update_task_without_snapshot(task_id, |link| {
            if link.runtime != "codex"
                || link.running
                || link.status == "archived"
                || link.execution_state.is_some()
                || link.thread_id.as_deref() != thread["id"].as_str()
            {
                return;
            }
            let Some(turn) = thread["turns"]
                .as_array()
                .and_then(|turns| turns.last())
                .filter(|turn| {
                    turn["id"].as_str().is_some()
                        && turn["id"] == link.runtime_handle["lastTurnId"]
                        && turn["timelineCompleted"] == true
                })
            else {
                return;
            };
            let (status, turn_status) = match turn["status"].as_str() {
                Some("completed") => ("done", "completed"),
                Some("failed") => ("failed", "failed"),
                Some("interrupted" | "cancelled") => ("cancelled", "interrupted"),
                _ => return,
            };
            let Some(completed_at) = timestamp_ms_field(turn, "completedAt") else {
                return;
            };
            // Only the exact persisted native completion boundary repairs cold metadata.
            link.status = status.into();
            link.turn_status = Some(turn_status.into());
            link.completed_at = Some(completed_at);
            link.thread_status = "idle".into();
        });
    }

    pub(super) fn accepted_reconciliation_ids(
        &self,
        task_id: &str,
        response: &Value,
        requested: &[String],
    ) -> Option<Vec<String>> {
        let thread_id = response["threadId"].as_str()?;
        self.store
            .read_task(task_id, |link| {
                if runtime_session_id_from_link(link).as_deref() != Some(thread_id) {
                    return None;
                }
                let requested_ids = requested.iter().map(String::as_str).collect::<HashSet<_>>();
                let accepted = link.runtime_handle["userMessagePresentations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|presentation| {
                        presentation["turnId"]
                            .as_str()
                            .or_else(|| presentation["turn_id"].as_str())
                            .is_some_and(|turn_id| !turn_id.trim().is_empty())
                    })
                    .filter_map(|presentation| {
                        presentation["clientUserMessageId"]
                            .as_str()
                            .or_else(|| presentation["client_user_message_id"].as_str())
                    })
                    .filter(|id| requested_ids.contains(id))
                    .collect::<HashSet<_>>();
                Some(
                    requested
                        .iter()
                        .filter(|id| accepted.contains(id.as_str()))
                        .cloned()
                        .collect(),
                )
            })
            .flatten()
    }

    pub(super) fn transcript_read_link(
        &self,
        task_id: &str,
        bounded: bool,
    ) -> (Option<RuntimeTaskLink>, bool) {
        if bounded {
            let native = self
                .store
                .read_task(task_id, |link| {
                    (runtime_has_provider_transcript_reader(&link.runtime)
                        && !link.ephemeral
                        && runtime_session_id_from_link(link).is_some()
                        && !provider_transcript_is_unmaterialized(link))
                    .then(|| link.list_summary())
                })
                .flatten();
            if native.is_some() {
                return (native, true);
            }
        }
        (self.local_task_link(task_id), false)
    }

    pub(super) fn native_transcript_page_link(
        &self,
        task_id: &str,
        thread: &Value,
        cancellation: &Cancellation,
    ) -> Result<Option<RuntimeTaskLink>, AppIpcError> {
        self.store
            .read_task(task_id, |link| page_link(link, thread, cancellation))
            .transpose()
    }
}

pub(super) fn reconciliation_ids(payload: &Value) -> Result<Option<Vec<String>>, AppIpcError> {
    let Some(value) = payload.get("reconcileClientUserMessageIds") else {
        return Ok(None);
    };
    let values = value.as_array().ok_or_else(|| {
        AppIpcError::new("bad_request", "Reconciliation message IDs must be an array")
    })?;
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let id = value
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| {
                AppIpcError::new(
                    "bad_request",
                    "Reconciliation message IDs must be nonempty strings",
                )
            })?;
        if seen.insert(id) {
            ids.push(id.to_owned());
        }
    }
    Ok(Some(ids))
}

fn page_link(
    link: &RuntimeTaskLink,
    thread: &Value,
    cancellation: &Cancellation,
) -> Result<RuntimeTaskLink, AppIpcError> {
    cancellation.check()?;
    let mut page = link.list_summary();
    let turns = thread["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let turn_ids = turns
        .iter()
        .filter_map(|turn| turn["id"].as_str())
        .collect::<HashSet<_>>();
    let prompt_turns = turns
        .iter()
        .filter(|turn| {
            turn["ownsUserPresentation"] == true
                || turn["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|item| item_type(item) == "usermessage")
        })
        .filter_map(|turn| turn["id"].as_str())
        .collect::<HashSet<_>>();
    let item_ids = turns
        .iter()
        .flat_map(|turn| {
            turn["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(move |item| Some((turn["id"].as_str()?, item["id"].as_str()?)))
        })
        .collect::<HashSet<_>>();
    let user_ids = turns
        .iter()
        .flat_map(|turn| {
            turn["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item_type(item) == "usermessage")
                .flat_map(|item| {
                    [
                        item["id"].as_str(),
                        item["clientId"].as_str(),
                        item["client_id"].as_str(),
                    ]
                })
                .flatten()
        })
        .collect::<HashSet<_>>();
    let mut presentations = Vec::new();
    for presentation in link.runtime_handle["userMessagePresentations"]
        .as_array()
        .into_iter()
        .flatten()
    {
        cancellation.check()?;
        let turn = presentation["turnId"]
            .as_str()
            .or_else(|| presentation["turn_id"].as_str());
        let client = presentation["clientUserMessageId"]
            .as_str()
            .or_else(|| presentation["client_user_message_id"].as_str());
        if turn.is_some_and(|id| prompt_turns.contains(id))
            || client.is_some_and(|id| user_ids.contains(id))
        {
            presentations.push(presentation.clone());
        }
    }
    page.runtime_handle["userMessagePresentations"] = Value::Array(presentations);
    if link.runtime_handle["completedTranscriptThreadId"] == link.thread_id.as_deref().unwrap_or("")
    {
        let mut messages = Vec::new();
        for message in link.runtime_handle["completedTranscriptMessages"]
            .as_array()
            .into_iter()
            .flatten()
        {
            cancellation.check()?;
            if let Some(message) = overlay_message(message, &turn_ids, &item_ids, cancellation)? {
                messages.push(message);
            }
        }
        page.runtime_handle["completedTranscriptMessages"] = Value::Array(messages);
    }
    Ok(page)
}

fn overlay_message(
    message: &Value,
    turns: &HashSet<&str>,
    native: &HashSet<(&str, &str)>,
    cancellation: &Cancellation,
) -> Result<Option<Value>, AppIpcError> {
    if message["role"] != "assistant" {
        return Ok(None);
    }
    let turn = message["turnId"].as_str().unwrap_or_default();
    let mut selected = Vec::new();
    let mut owns_overlay = false;
    for item in message["runtimeItems"].as_array().into_iter().flatten() {
        cancellation.check()?;
        let overlay = is_running_runtime_command(item)
            || (turns.contains(turn)
                && (is_runtime_user_interaction(item, turn)
                    || (item["type"] == "block"
                        && item["block"]["tool_name"] == "auto_approval_review")));
        if overlay {
            owns_overlay = true;
            selected.push(item.clone());
        } else if item["id"]
            .as_str()
            .is_some_and(|id| native.contains(&(turn, id)))
        {
            // The native page supplies the body; cached identities preserve neighboring order.
            selected.push(json!({"id":item["id"]}));
        }
    }
    if !owns_overlay {
        return Ok(None);
    }
    let mut projected = message
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| {
            !matches!(
                key.as_str(),
                "content" | "blocks" | "runtimeItems" | "fileChanges"
            )
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Map<_, _>>();
    projected.insert("content".to_owned(), json!(""));
    projected.insert("runtimeItems".to_owned(), Value::Array(selected));
    Ok(Some(Value::Object(projected)))
}

#[cfg(test)]
mod receipt_tests {
    use super::*;

    #[test]
    fn receipt_queries_preserve_absence_and_reject_invalid_identities() {
        assert_eq!(reconciliation_ids(&json!({})).unwrap(), None);
        assert_eq!(
            reconciliation_ids(&json!({"reconcileClientUserMessageIds":[]})).unwrap(),
            Some(vec![])
        );
        assert_eq!(
            reconciliation_ids(&json!({"reconcileClientUserMessageIds":["a","a","b"]})).unwrap(),
            Some(vec!["a".into(), "b".into()])
        );
        for invalid in [json!(null), json!([""]), json!([" "]), json!([1])] {
            let error =
                reconciliation_ids(&json!({"reconcileClientUserMessageIds":invalid})).unwrap_err();
            assert_eq!(error.code, "bad_request");
        }
    }
}
