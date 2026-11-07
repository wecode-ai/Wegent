//! Logical conversations retain native history independently of their active thread.
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::response::RuntimeTaskLink;

pub(crate) const SESSIONS_KEY: &str = "conversationSessions";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationSession {
    pub thread_id: String,
    pub started_at: i64,
    pub closed_at: i64,
}

pub(crate) fn is_identity_conversation(link: &RuntimeTaskLink) -> bool {
    link.runtime == "codex"
        && !link.ephemeral
        && matches!(
            link.runtime_handle["origin"]["type"].as_str(),
            Some("stand_in_identity" | "stand_in_coordinator")
        )
}

pub(crate) fn closed_sessions(
    link: &RuntimeTaskLink,
) -> Result<Vec<ConversationSession>, serde_json::Error> {
    link.runtime_handle
        .get(SESSIONS_KEY)
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map(Option::unwrap_or_default)
}

pub(crate) fn is_closed_thread(link: &RuntimeTaskLink, thread: &str) -> bool {
    closed_sessions(link)
        .is_ok_and(|sessions| sessions.iter().any(|session| session.thread_id == thread))
}

/// Called only for a native thread admitted by the ordinary Runtime execution path.
pub(crate) fn bind_thread(link: &mut RuntimeTaskLink, thread: &str, now: i64) -> bool {
    if thread.is_empty() || link.thread_id.as_deref() == Some(thread) {
        return true;
    }
    if is_identity_conversation(link) {
        if is_closed_thread(link, thread) {
            return false;
        }
        if let Some(previous) = link.thread_id.as_ref() {
            if link
                .interaction_status
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            {
                return false;
            }
            let Ok(mut sessions) = closed_sessions(link) else {
                return false;
            };
            let started_at = sessions
                .last()
                .map_or(link.created_at, |session| session.closed_at);
            sessions.push(ConversationSession {
                thread_id: previous.clone(),
                started_at,
                closed_at: now,
            });
            link.runtime_handle[SESSIONS_KEY] = json!(sessions);
            if let Some(handle) = link.runtime_handle.as_object_mut() {
                handle.remove("threadPath");
                handle.remove("lastTurnId");
            }
            if let Some(state) = link.execution_state.as_mut() {
                state.latest_turn_id = None;
                state.turn_id = None;
                state.request_turn_id = None;
            }
        }
    }
    link.thread_id = Some(thread.to_owned());
    true
}

pub(crate) fn thread_ids(link: &RuntimeTaskLink) -> Result<Vec<String>, serde_json::Error> {
    let mut ids: Vec<_> = closed_sessions(link)?
        .into_iter()
        .map(|session| session.thread_id)
        .collect();
    if let Some(thread) = &link.thread_id {
        ids.push(thread.clone());
    }
    Ok(ids)
}

/// Old history must never borrow the active execution's state or buffered messages.
pub(crate) fn history_link(link: &RuntimeTaskLink, thread: &str) -> RuntimeTaskLink {
    let mut historical = link.clone();
    historical.thread_id = Some(thread.into());
    historical.running = false;
    historical.execution_state = None;
    historical.interaction_status = None;
    if let Some(handle) = historical.runtime_handle.as_object_mut() {
        for key in [
            "lastTurnId",
            "threadPath",
            "queuePosition",
            "cloudTranscript",
            "completedTranscriptMessages",
            "transcriptSnapshotMessages",
            "transcriptSnapshotPagination",
        ] {
            handle.remove(key);
        }
    }
    historical
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_work::store::RuntimeWorkStore;

    fn conversation() -> RuntimeTaskLink {
        RuntimeTaskLink {
            local_task_id: "stand-in-chat-7-primary".into(),
            thread_id: Some("first".into()),
            created_at: 100,
            runtime_handle: json!({"origin":{"type":"stand_in_identity","userId":7},"userMessagePresentations":[{"id":"original"}]}),
            ..Default::default()
        }
    }

    #[test]
    fn conversation_sessions_preserve_identity_and_native_history_across_restart() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime.json");
        let store = RuntimeWorkStore::new(path.clone());
        let mut link = conversation();
        assert!(bind_thread(&mut link, "second", 200));
        assert!(bind_thread(&mut link, "second", 250));
        assert!(bind_thread(&mut link, "third", 300));
        assert!(!bind_thread(&mut link, "first", 400));
        store.upsert_task(link.clone());
        let restored = RuntimeWorkStore::new(path)
            .get_task(&link.local_task_id)
            .unwrap();
        assert_eq!(thread_ids(&restored).unwrap(), ["first", "second", "third"]);
        assert_eq!(restored.thread_id.as_deref(), Some("third"));
        assert_eq!(
            restored.runtime_handle["userMessagePresentations"],
            link.runtime_handle["userMessagePresentations"]
        );
        assert_eq!(closed_sessions(&restored).unwrap()[0].started_at, 100);
        assert_eq!(closed_sessions(&restored).unwrap()[1].started_at, 200);
    }

    #[test]
    fn conversation_sessions_do_not_move_pending_approvals_or_modify_ordinary_tasks() {
        let mut link = conversation();
        link.interaction_status = Some("waitingForUserInput".into());
        let before = serde_json::to_value(&link).unwrap();
        assert!(!bind_thread(&mut link, "second", 200));
        assert_eq!(serde_json::to_value(&link).unwrap(), before);
        let mut ordinary = RuntimeTaskLink {
            thread_id: Some("first".into()),
            ..Default::default()
        };
        assert!(bind_thread(&mut ordinary, "second", 200));
        assert!(closed_sessions(&ordinary).unwrap().is_empty());
    }

    #[test]
    fn conversation_sessions_keep_logical_creation_time_on_native_refresh() {
        let projected = RuntimeTaskLink::from_thread_metadata(
            &json!({"id":"second", "createdAt":500, "status":{"type":"idle"}}),
            Some(conversation()),
            String::new(),
            false,
        );
        assert_eq!(projected.created_at, 100);
    }

    #[test]
    fn conversation_sessions_read_old_history_without_active_execution_overlays() {
        let mut link = conversation();
        link.running = true;
        link.interaction_status = Some("waitingForUserInput".into());
        link.runtime_handle["lastTurnId"] = json!("new-turn");
        link.runtime_handle["cloudTranscript"] = json!({"messages":[{"content":"current only"}]});
        let historical = history_link(&link, "old-thread");
        assert_eq!(historical.local_task_id, link.local_task_id);
        assert!(!historical.running);
        assert!(historical.interaction_status.is_none());
        assert!(historical.runtime_handle.get("lastTurnId").is_none());
        assert!(historical.runtime_handle.get("cloudTranscript").is_none());
        assert_eq!(link.runtime_handle["lastTurnId"], "new-turn");
    }
}
