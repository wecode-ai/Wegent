// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Account-scoped projections for persisted stand-in work summaries.

use serde_json::{json, Value};

use super::personal_stand_in::{matches_delegation_account, project_delegation_result};

const TITLE_CHARS: usize = 80;

/// A work and its messages after removing records owned by another DingTalk account.
pub(crate) struct VisibleWork {
    pub work: Value,
    pub messages: Vec<Value>,
    pub hidden_messages_removed: bool,
}

/// Project a persisted work summary from the messages visible to its current account.
///
/// The store keeps summaries for efficient listing, but a work can contain records
/// from a previous DingTalk account. Callers returning content must use this projection
/// so that the hidden record cannot influence the summary, status, title, or actions.
pub(crate) fn project_visible_work(
    settings: &Value,
    mut work: Value,
    messages: Vec<Value>,
) -> Option<VisibleWork> {
    let raw_message_count = messages.len();
    let messages = visible_messages(settings, &work["roleId"], messages);
    if messages.is_empty() {
        return None;
    }
    let hidden_messages_removed = raw_message_count > messages.len();
    let work_source_visible = source_visible_to_account(settings, &work["roleId"], &work["source"]);
    if let Some(work) = work.as_object_mut() {
        if hidden_messages_removed {
            work.remove("error");
        }
        if hidden_messages_removed || !work_source_visible {
            work.remove("takenOverAt");
        }
    }

    let latest = messages.last().expect("visible messages are not empty");
    if latest["roleId"].is_string() {
        work["roleId"] = latest["roleId"].clone();
    }
    work["source"] = latest["source"].clone();
    work["messageCount"] = json!(messages.len());
    work["latestMessage"] = latest.clone();
    work["title"] = json!(title_from_message(latest));
    work["status"] = json!(visible_status(&messages));
    if let Some(updated_at) = ["at", "receivedAt", "createdAt"]
        .iter()
        .find_map(|key| latest.get(*key).filter(|value| !value.is_null()))
    {
        work["updatedAt"] = updated_at.clone();
    } else if let Some(created_at) = work.get("createdAt") {
        work["updatedAt"] = created_at.clone();
    }

    if work["source"]["delegated"] == true {
        work["delegationResult"] = project_delegation_result(&work, &messages);
        if !work["takenOverAt"].is_null() && work["status"] != "sending" {
            work["status"] = json!("sent");
        }
    } else if let Some(work) = work.as_object_mut() {
        work.remove("delegationResult");
        work.remove("takenOverAt");
    }
    work["refreshVersion"] = json!(visible_refresh_version(&work, &messages));

    Some(VisibleWork {
        work,
        messages,
        hidden_messages_removed,
    })
}

/// Keep only task fields safe to show beside an account-filtered work.
pub(crate) fn sanitize_task_summary(
    task: Value,
    work: &Value,
    hidden_messages_removed: bool,
) -> Value {
    let origin = task["runtimeHandle"]["origin"].clone();
    let transcript_id = task["runtimeHandle"]["cloudTranscript"]["transcriptId"].clone();
    let mut safe_origin = serde_json::Map::new();
    for key in [
        "type",
        "initiatedBy",
        "userId",
        "standInId",
        "roleName",
        "deviceId",
        "workId",
        "sourceTaskId",
        "askBeforeAct",
        "manual",
        "sourceProvider",
    ] {
        if !origin[key].is_null() {
            safe_origin.insert(key.into(), origin[key].clone());
        }
    }
    safe_origin.insert(
        "sourceProvider".into(),
        json!(super::personal_stand_in::source_provider(&work["source"])),
    );
    let mut runtime_handle = json!({"origin":safe_origin});
    if task["runtimeHandle"]["lastTurnId"].is_string() {
        runtime_handle["lastTurnId"] = task["runtimeHandle"]["lastTurnId"].clone();
    }
    if transcript_id.is_string() {
        runtime_handle["cloudTranscript"] = json!({"transcriptId":transcript_id});
    }
    let mut safe = serde_json::Map::new();
    safe.insert("title".into(), work["title"].clone());
    safe.insert(
        "status".into(),
        if hidden_messages_removed {
            json!(match work["status"].as_str() {
                Some("sent") => "done",
                Some("sending") => "running",
                Some("failed") => "failed",
                _ => "pending",
            })
        } else {
            task["status"].clone()
        },
    );
    safe.insert("updatedAt".into(), work["updatedAt"].clone());
    safe.insert("runtimeHandle".into(), runtime_handle);
    for key in [
        "taskId",
        "runtime",
        "workspacePath",
        "workspaceKind",
        "worktreeId",
        "threadId",
        "running",
        "continuable",
    ] {
        if !task[key].is_null() {
            safe.insert(key.into(), task[key].clone());
        }
    }
    if !hidden_messages_removed && !task["interactionStatus"].is_null() {
        safe.insert(
            "interactionStatus".into(),
            task["interactionStatus"].clone(),
        );
    }
    Value::Object(safe)
}

/// Keep only messages whose own role and source match the active account.
pub(crate) fn visible_messages(
    settings: &Value,
    work_role: &Value,
    messages: Vec<Value>,
) -> Vec<Value> {
    messages
        .into_iter()
        .filter(|message| message_visible_to_account(settings, work_role, message))
        .collect()
}

pub(crate) fn message_visible_to_account(
    settings: &Value,
    work_role: &Value,
    message: &Value,
) -> bool {
    let role = if message["roleId"].is_string() {
        &message["roleId"]
    } else {
        work_role
    };
    source_visible_to_account(settings, role, &message["source"])
}

/// Legacy tasks may have no bindings. When bindings exist, every record must
/// still be present in the account-scoped message projection.
pub(crate) fn source_bindings_visible(
    settings: &Value,
    work_role: &Value,
    bindings: Option<&Value>,
    messages: &[Value],
) -> bool {
    match bindings {
        None => true,
        Some(Value::Array(bindings)) => bindings.iter().all(|binding| {
            if binding["source"].is_object() {
                return source_visible_to_account(settings, work_role, &binding["source"]);
            }
            binding["recordId"].as_str().is_some_and(|record_id| {
                messages
                    .iter()
                    .any(|message| message["recordId"] == record_id)
            })
        }),
        Some(_) => false,
    }
}

fn source_visible_to_account(settings: &Value, role: &Value, source: &Value) -> bool {
    source.is_object() && matches_delegation_account(settings, role, source)
}

fn title_from_message(message: &Value) -> String {
    let text = message["text"].as_str().unwrap_or_default().trim();
    if !text.is_empty() {
        return text.chars().take(TITLE_CHARS).collect();
    }
    message["source"]["name"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().take(TITLE_CHARS).collect())
        .unwrap_or_else(|| "Connected work".into())
}

fn visible_status(messages: &[Value]) -> &'static str {
    ["sending", "needs_grouping", "pending", "failed"]
        .into_iter()
        .find(|status| {
            messages
                .iter()
                .any(|message| message["dispatchStatus"] == *status)
        })
        .unwrap_or("sent")
}

/// A deterministic revision of the visible work detail state.
///
/// Dispatch and delegation transitions can change while the message timestamp and
/// count stay fixed. The UI uses this revision to refresh an expanded detail view.
fn visible_refresh_version(work: &Value, messages: &[Value]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    hash_text(&mut hash, work["status"].as_str().unwrap_or_default());
    hash_text(&mut hash, work["error"].as_str().unwrap_or_default());
    hash_text(&mut hash, work["takenOverAt"].as_str().unwrap_or_default());
    hash_delegation(&mut hash, &work["delegationResult"]);
    for message in messages {
        hash_text(&mut hash, message["recordId"].as_str().unwrap_or_default());
        hash_text(
            &mut hash,
            message["dispatchStatus"].as_str().unwrap_or_default(),
        );
        hash_text(&mut hash, &message["dispatchFailureCount"].to_string());
        hash_text(&mut hash, message["error"].as_str().unwrap_or_default());
        hash_text(
            &mut hash,
            message["takenOverAt"].as_str().unwrap_or_default(),
        );
        hash_delegation(&mut hash, &message["delegationResult"]);
        hash_text(&mut hash, "");
    }
    format!("{hash:016x}")
}

fn hash_delegation(hash: &mut u64, result: &Value) {
    for key in [
        "action",
        "status",
        "reason",
        "reasonCode",
        "attemptId",
        "channelTaskId",
        "receiptId",
        "submittedAt",
        "finishedAt",
        "deliveryReason",
        "deliveryReasonCode",
    ] {
        hash_text(hash, result[key].as_str().unwrap_or_default());
    }
    hash_text(
        hash,
        if result["takenOver"] == true {
            "true"
        } else {
            ""
        },
    );
}

fn hash_text(hash: &mut u64, text: &str) {
    for byte in text.bytes() {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
    *hash ^= 0xff;
    *hash = hash.wrapping_mul(0x100000001b3);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Value {
        json!({
            "primary": {"delegation": {"accountId": "account-new", "profile": "current"}}
        })
    }

    fn old_account_message() -> Value {
        json!({
            "recordId": "old-record",
            "roleId": "@primary",
            "text": "old-account content",
            "at": "2026-01-02T00:00:00Z",
            "dispatchStatus": "failed",
            "delegationResult": {"action":"reply","reason":"old-account decision"},
            "source": {
                "providerId": crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,
                "profile": "current",
                "accountId": "account-old",
                "kind": "direct",
                "id": "peer",
                "delegated": true
            }
        })
    }

    fn email_message() -> Value {
        json!({
            "recordId": "mail-record",
            "roleId": "@primary",
            "text": "current mailbox content",
            "at": "2026-01-01T00:00:00Z",
            "dispatchStatus": "sent",
            "source": {"providerId": "connection/email", "profile": "mailbox"}
        })
    }

    fn delegated_message(
        action: &str,
        dispatch_status: &str,
        delegation_status: &str,
        reason: &str,
    ) -> Value {
        json!({
            "recordId": "delegated-record",
            "roleId": "@primary",
            "text": "delegated content",
            "at": "2026-01-01T00:00:00Z",
            "dispatchStatus": dispatch_status,
            "delegationResult": {
                "action": action,
                "status": delegation_status,
                "reason": reason
            },
            "source": {
                "providerId": crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,
                "profile": "current",
                "accountId": "account-new",
                "kind": "direct",
                "id": "peer",
                "delegated": true
            }
        })
    }

    #[test]
    fn projection_keeps_current_mail_and_rebuilds_the_summary_from_visible_messages() {
        let work = json!({
            "id": "mixed",
            "roleId": "@primary",
            "title": "old-account content",
            "source": {"providerId":"connection/email","profile":"mailbox"},
            "latestMessage": old_account_message(),
            "messageCount": 2,
            "status": "failed",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-02T00:00:00Z",
            "error": "old-account failure",
            "delegationResult": {"reason":"stale result"}
        });

        let visible = project_visible_work(
            &settings(),
            work,
            vec![old_account_message(), email_message()],
        )
        .unwrap();

        assert_eq!(visible.messages, vec![email_message()]);
        assert_eq!(visible.work["title"], "current mailbox content");
        assert_eq!(visible.work["latestMessage"], email_message());
        assert_eq!(visible.work["messageCount"], 1);
        assert_eq!(visible.work["status"], "sent");
        assert_eq!(visible.work["updatedAt"], "2026-01-01T00:00:00Z");
        assert!(visible.work.get("error").is_none());
        assert!(visible.work.get("delegationResult").is_none());
        assert!(!visible.work.to_string().contains("old-account"));
    }

    #[test]
    fn projection_keeps_the_existing_error_when_no_messages_are_hidden() {
        let work = json!({
            "id":"visible",
            "roleId":"@primary",
            "source":{"providerId":"connection/email","profile":"mailbox"},
            "error":"Visible dispatch failed"
        });

        let visible = project_visible_work(&settings(), work, vec![email_message()]).unwrap();

        assert_eq!(visible.work["error"], "Visible dispatch failed");
    }

    #[test]
    fn projection_hides_work_when_every_message_belongs_to_the_old_account() {
        let work = json!({
            "id":"hidden",
            "roleId":"@primary",
            "source":{"providerId":"connection/email","profile":"mailbox"},
            "createdAt":"2026-01-01T00:00:00Z"
        });

        assert!(project_visible_work(&settings(), work, vec![old_account_message()]).is_none());
    }

    #[test]
    fn visible_messages_override_a_work_source_owned_by_the_old_account() {
        let work = json!({
            "id":"mixed",
            "roleId":"@primary",
            "title":"old-account content",
            "source": old_account_message()["source"],
            "latestMessage": old_account_message(),
            "messageCount": 2
        });

        let visible = project_visible_work(
            &settings(),
            work,
            vec![old_account_message(), email_message()],
        )
        .unwrap();

        assert_eq!(visible.work["source"], email_message()["source"]);
        assert_eq!(visible.work["title"], "current mailbox content");
        assert_eq!(visible.work["messageCount"], 1);
    }

    #[test]
    fn task_summary_drops_content_and_timing_derived_from_hidden_messages() {
        let work = json!({
            "title":"current mailbox content",
            "status":"sent",
            "updatedAt":"2026-01-01T00:00:00Z",
            "source":{"providerId":"connection/email","profile":"mailbox"}
        });
        let task = json!({
            "taskId":"mixed",
            "title":"old-account content",
            "status":"running",
            "interactionStatus":"waitingForApproval",
            "error":"old-account error",
            "runtime":"codex",
            "workspacePath":"/workspace",
            "running":true,
            "parent":{"title":"old-account parent"},
            "supervisor":{"message":"old-account supervisor"},
            "executionState":{"activeText":"old-account answer"},
            "runtimeHandle":{
                "origin":{"type":"connection_work","standInId":"@primary","workId":"mixed","sourceProvider":"old-account-provider"},
                "lastTurnId":"turn-7",
                "executionRequest":{"prompt":"old-account prompt"}
            },
            "createdAt":1,
            "updatedAt":2,
            "recencyAt":3,
            "completedAt":4
        });

        let task = sanitize_task_summary(task, &work, true);

        assert_eq!(task["title"], "current mailbox content");
        assert_eq!(task["status"], "done");
        assert_eq!(task["updatedAt"], "2026-01-01T00:00:00Z");
        assert_eq!(task["runtimeHandle"]["origin"]["workId"], "mixed");
        assert_eq!(
            task["runtimeHandle"]["origin"]["sourceProvider"],
            "connection/email"
        );
        assert_eq!(task["runtimeHandle"]["lastTurnId"], "turn-7");
        assert_eq!(task["taskId"], "mixed");
        assert_eq!(task["runtime"], "codex");
        assert_eq!(task["workspacePath"], "/workspace");
        assert_eq!(task["running"], true);
        for key in ["createdAt", "recencyAt", "completedAt"] {
            assert!(task.get(key).is_none());
        }
        for key in [
            "interactionStatus",
            "error",
            "parent",
            "supervisor",
            "executionState",
        ] {
            assert!(task.get(key).is_none(), "{key}");
        }
        assert!(!task.to_string().contains("old-account"));
    }

    #[test]
    fn task_summary_keeps_safe_lifecycle_state_when_no_messages_are_hidden() {
        let work = json!({
            "title":"current mailbox content",
            "status":"pending",
            "updatedAt":"2026-01-02T00:00:00Z"
        });
        let task = json!({
            "taskId":"visible",
            "status":"archived",
            "interactionStatus":"waitingForApproval",
            "updatedAt":1,
            "runtimeHandle":{"origin":{"type":"connection_work","workId":"visible"}}
        });

        let task = sanitize_task_summary(task, &work, false);

        assert_eq!(task["status"], "archived");
        assert_eq!(task["interactionStatus"], "waitingForApproval");
        assert_eq!(task["updatedAt"], "2026-01-02T00:00:00Z");
    }

    #[test]
    fn source_bindings_reject_records_outside_the_visible_message_set() {
        let visible = vec![email_message()];
        let settings = settings();
        let role = json!("@primary");
        let mail_source = email_message()["source"].clone();
        let old_source = old_account_message()["source"].clone();
        assert!(source_bindings_visible(&settings, &role, None, &visible));
        assert!(source_bindings_visible(
            &settings,
            &role,
            Some(&json!([{"recordId":"mail-record"}])),
            &visible
        ));
        assert!(source_bindings_visible(
            &settings,
            &role,
            Some(&json!([{"recordId":"moved-record","source":mail_source}])),
            &visible
        ));
        assert!(!source_bindings_visible(
            &settings,
            &role,
            Some(&json!([{"recordId":"old-record","source":old_source}])),
            &visible
        ));
        assert!(!source_bindings_visible(
            &settings,
            &role,
            Some(&json!([{"recordId":"mail-record"},{"recordId":"old-record"}])),
            &visible
        ));
        assert!(source_bindings_visible(
            &settings,
            &role,
            Some(&json!([])),
            &visible
        ));
        assert!(!source_bindings_visible(
            &settings,
            &role,
            Some(&json!({})),
            &visible
        ));
    }

    #[test]
    fn projection_shows_the_latest_handoff_and_keeps_earlier_receipts_and_owner_intervention() {
        let mut reply = delegated_message("reply", "sent", "sent", "Automatic reply sent");
        reply["delegationResult"]["receiptId"] = json!("delivery-receipt");
        let work = json!({"roleId":"@primary","source":reply["source"]});
        let later = delegated_message("needs_user", "sent", "complete", "Needs user decision");
        let visible = project_visible_work(&settings(), work.clone(), vec![reply, later]).unwrap();
        assert_eq!(visible.work["delegationResult"]["action"], "needs_user");
        assert_eq!(
            visible.messages[0]["delegationResult"]["receiptId"],
            "delivery-receipt"
        );

        let mut owner = delegated_message("skip", "sent", "complete", "The owner already replied");
        owner["delegationResult"]["reasonCode"] = json!("owner_intervened");
        let skipped = delegated_message("skip", "sent", "complete", "No reply needed");
        let visible = project_visible_work(&settings(), work, vec![owner, skipped]).unwrap();
        assert_eq!(
            visible.work["delegationResult"]["reasonCode"],
            "owner_intervened"
        );
    }

    #[test]
    fn projection_keeps_takeover_only_for_the_current_saved_delegation_account() {
        let message = delegated_message("reply", "pending", "complete", "Existing decision");
        let mut work = json!({"roleId":"@primary","source":message["source"]});
        let before =
            project_visible_work(&settings(), work.clone(), vec![message.clone()]).unwrap();
        work["takenOverAt"] = json!("2026-01-01T00:02:00Z");
        let visible =
            project_visible_work(&settings(), work.clone(), vec![message.clone()]).unwrap();
        assert_eq!(visible.work["status"], "sent");
        assert_eq!(visible.work["delegationResult"]["takenOver"], true);
        assert_ne!(
            visible.work["refreshVersion"],
            before.work["refreshVersion"]
        );

        work["source"] = old_account_message()["source"].clone();
        let visible = project_visible_work(&settings(), work, vec![message]).unwrap();
        assert_eq!(visible.work["status"], "pending");
        assert!(visible.work.get("takenOverAt").is_none());
        assert!(visible.work["delegationResult"].get("takenOver").is_none());
        assert_eq!(
            visible.work["refreshVersion"],
            before.work["refreshVersion"]
        );
    }

    #[test]
    fn refresh_version_tracks_visible_message_state_without_count_or_time_changes() {
        let work = json!({
            "id": "delegated",
            "roleId": "@primary",
            "source": delegated_message("reply", "sending", "submitting", "Sending reply")["source"],
            "createdAt": "2026-01-01T00:00:00Z"
        });
        let sent = delegated_message("reply", "sent", "sent", "Automatic reply sent");
        let mut with_receipt = sent.clone();
        with_receipt["delegationResult"]["receiptId"] = json!("delivery-receipt");
        let variants = [
            delegated_message("reply", "sending", "submitting", "Sending reply"),
            sent,
            with_receipt,
            delegated_message("reply", "sent", "unknown", "Reply delivery unconfirmed"),
            delegated_message("needs_user", "sent", "complete", "Needs user decision"),
        ];
        let versions = variants
            .iter()
            .map(|message| {
                let visible =
                    project_visible_work(&settings(), work.clone(), vec![message.clone()]).unwrap();
                assert_eq!(visible.work["messageCount"], 1);
                assert_eq!(visible.work["updatedAt"], "2026-01-01T00:00:00Z");
                visible.work["refreshVersion"].as_str().unwrap().to_owned()
            })
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(versions.len(), variants.len());
    }

    #[test]
    fn refresh_version_ignores_hidden_account_message_state() {
        let visible = delegated_message("reply", "sent", "sent", "Current account result");
        let work = json!({
            "id": "mixed",
            "roleId": "@primary",
            "source": visible["source"],
            "createdAt": "2026-01-01T00:00:00Z"
        });
        let mut hidden = old_account_message();
        let first = project_visible_work(
            &settings(),
            work.clone(),
            vec![hidden.clone(), visible.clone()],
        )
        .unwrap();
        hidden["dispatchStatus"] = json!("sent");
        hidden["delegationResult"]["status"] = json!("sent");
        hidden["delegationResult"]["reason"] = json!("Old account result updated");
        let second = project_visible_work(&settings(), work, vec![hidden, visible]).unwrap();

        assert_eq!(first.work["refreshVersion"], second.work["refreshVersion"]);
    }

    #[test]
    fn visible_takeover_preserves_an_uncertain_reply_and_updates_detail_revision() {
        let mut message = delegated_message("reply", "sent", "unknown", "Awaiting receipt");
        message["delegationResult"]["channelTaskId"] = json!("task-7");
        let work = json!({
            "id": "delegated",
            "roleId": "@primary",
            "source": message["source"]
        });
        let initial =
            project_visible_work(&settings(), work.clone(), vec![message.clone()]).unwrap();
        let mut taken_over = work;
        taken_over["takenOverAt"] = json!("2026-01-02T00:00:00Z");
        let visible =
            project_visible_work(&settings(), taken_over.clone(), vec![message.clone()]).unwrap();
        assert_eq!(visible.work["delegationResult"]["status"], "unknown");
        assert_eq!(visible.work["delegationResult"]["channelTaskId"], "task-7");
        assert_eq!(visible.work["delegationResult"]["takenOver"], true);
        assert_ne!(
            visible.work["refreshVersion"],
            initial.work["refreshVersion"]
        );

        let mut hidden_origin = taken_over.clone();
        hidden_origin["source"] = old_account_message()["source"].clone();
        let changed_source =
            project_visible_work(&settings(), hidden_origin, vec![message.clone()]).unwrap();
        assert!(changed_source.work["takenOverAt"].is_null());

        let mixed = project_visible_work(
            &settings(),
            taken_over,
            vec![old_account_message(), message],
        )
        .unwrap();
        assert!(mixed.work["takenOverAt"].is_null());
        assert!(mixed.work["delegationResult"]["takenOver"].is_null());
    }
}
