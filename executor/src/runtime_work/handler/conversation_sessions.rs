//! Session boundaries reuse Runtime history readers, native events and send admission.
use super::*;
use crate::runtime_work::conversation_sessions as sessions;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

const CURSOR_PREFIX: &str = "wework-session:v1:";

#[cfg(test)]
#[path = "conversation_sessions_tests.rs"]
mod tests;

#[derive(Deserialize, Serialize)]
struct SessionCursor {
    task: String,
    thread: String,
    native: Option<String>,
    ascending: bool,
}

fn invalid_cursor() -> AppIpcError {
    AppIpcError::new(
        "history_cursor_invalid",
        "Session cursor does not belong to this conversation",
    )
}

fn encode_cursor(task: &str, thread: &str, native: Option<String>, ascending: bool) -> String {
    let cursor = SessionCursor {
        task: task.into(),
        thread: thread.into(),
        native,
        ascending,
    };
    format!(
        "{CURSOR_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap())
    )
}

fn decode_cursor(cursor: &str) -> Result<Option<SessionCursor>, AppIpcError> {
    let Some(encoded) = cursor.strip_prefix(CURSOR_PREFIX) else {
        return Ok(None);
    };
    if encoded.len() > 16384 {
        return Err(invalid_cursor());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| invalid_cursor())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| invalid_cursor())
}

impl RuntimeWorkRpcHandler {
    pub(super) fn validate_session_start(
        &self,
        link: Option<&RuntimeTaskLink>,
        payload: &Value,
    ) -> Result<bool, AppIpcError> {
        if payload.get("startNewSession").is_none() {
            return Ok(false);
        }
        let start = payload["startNewSession"]
            .as_bool()
            .ok_or_else(|| AppIpcError::new("bad_request", "startNewSession must be a boolean"))?;
        if !start {
            return Ok(false);
        }
        let link = link
            .filter(|link| sessions::is_identity_conversation(link))
            .ok_or_else(|| {
                AppIpcError::new(
                    "bad_request",
                    "Session boundaries require a persistent stand-in conversation",
                )
            })?;
        if payload["expectedThreadId"].as_str() != link.thread_id.as_deref()
            || link.thread_id.is_none()
        {
            return Err(AppIpcError::new(
                "session_conflict",
                "The active conversation session changed; refresh before starting a session",
            ));
        }
        if self.is_busy_local_task(&link.local_task_id)
            || link.running
            || link
                .interaction_status
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            || link.goal_status.as_deref() == Some("active")
            || link.status == "archived"
            || request_user_input_response(payload).is_some()
            || super::tasks::retry_source_turn_id(payload).is_some()
        {
            return Err(AppIpcError::new(
                "session_busy",
                "Finish the current execution, questions and approvals before starting a session",
            ));
        }
        Ok(true)
    }

    pub(super) fn read_transcript(
        &self,
        payload: Value,
    ) -> futures_util::future::BoxFuture<'_, Result<Value, AppIpcError>> {
        // Keep native reader futures out of every caller's authorization/transport frame.
        Box::pin(self.read_conversation_transcript(payload))
    }

    async fn read_conversation_transcript(&self, payload: Value) -> Result<Value, AppIpcError> {
        let task = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let Some(link) = self
            .store
            .get_task_summary(&task)
            .filter(sessions::is_identity_conversation)
        else {
            return self.read_thread_transcript(payload, None).await;
        };
        let ids = sessions::thread_ids(&link).map_err(|_| {
            AppIpcError::new(
                "invalid_session_state",
                "Conversation session history is invalid",
            )
        })?;
        if ids.is_empty() {
            return self.read_thread_transcript(payload, None).await;
        }
        let before = string_field(&payload, "beforeCursor")
            .or_else(|| string_field(&payload, "before_cursor"));
        let after = string_field(&payload, "afterCursor")
            .or_else(|| string_field(&payload, "after_cursor"));
        if before.is_some() && after.is_some() {
            return Err(invalid_cursor());
        }
        let cursor = before
            .as_deref()
            .or(after.as_deref())
            .map(decode_cursor)
            .transpose()?
            .flatten();
        let current = ids.last().unwrap();
        let requested = runtime_session_id_from_payload(&payload);
        let thread = if let Some(cursor) = &cursor {
            if cursor.task != task || cursor.ascending != after.is_some() {
                return Err(invalid_cursor());
            }
            cursor.thread.clone()
        } else if before.is_some() || after.is_some() {
            requested.clone().unwrap_or_else(|| current.clone())
        } else {
            current.clone()
        };
        let index = ids
            .iter()
            .position(|id| id == &thread)
            .ok_or_else(invalid_cursor)?;
        if requested.as_ref().is_some_and(|id| !ids.contains(id)) {
            return Err(invalid_cursor());
        }
        let all = payload["navigationOnly"] == true
            || payload["navigation_only"] == true
            || payload["includeFullContent"] == true
            || payload["include_full_content"] == true;
        if all && cursor.is_none() && before.is_none() && after.is_none() {
            return self.read_session_collection(payload, &link, &ids).await;
        }
        let mut page_payload = payload;
        for key in [
            "beforeCursor",
            "afterCursor",
            "before_cursor",
            "after_cursor",
        ] {
            page_payload.as_object_mut().unwrap().remove(key);
        }
        if let Some(cursor) = &cursor {
            if let Some(native) = &cursor.native {
                page_payload[if cursor.ascending {
                    "afterCursor"
                } else {
                    "beforeCursor"
                }] = json!(native);
            } else if cursor.ascending {
                page_payload["afterCursor"] = json!(
                    super::super::codex_transcript_search::first_history_cursor()
                        .map_err(|error| AppIpcError::new("history_cursor_invalid", error))?
                );
            }
        } else if let Some(native) = before.as_ref().or(after.as_ref()) {
            page_payload[if after.is_some() {
                "afterCursor"
            } else {
                "beforeCursor"
            }] = json!(native);
        }
        page_payload["sessionReadAscending"] = json!(after.is_some());
        let mut response = self.read_session_page(page_payload, &link, &thread).await?;
        for (ascending, key, has_more) in [
            (false, "beforeCursor", "hasMoreBefore"),
            (true, "afterCursor", "hasMoreAfter"),
        ] {
            let native = response[key].as_str().map(str::to_owned);
            let next = if native.is_some() {
                Some(encode_cursor(&task, &thread, native, ascending))
            } else {
                let neighbor = if ascending {
                    ids.get(index + 1)
                } else {
                    index.checked_sub(1).and_then(|index| ids.get(index))
                };
                neighbor.map(|thread| encode_cursor(&task, thread, None, ascending))
            };
            response[has_more] = json!(next.is_some());
            response[key] = json!(next);
        }
        Ok(response)
    }

    async fn read_session_page(
        &self,
        mut payload: Value,
        link: &RuntimeTaskLink,
        thread: &str,
    ) -> Result<Value, AppIpcError> {
        payload["threadId"] = json!(thread);
        let historical = link.thread_id.as_deref() != Some(thread);
        if historical {
            payload["refresh"] = json!(false);
            payload["forceRefresh"] = json!(false);
        }
        let mut page = self
            .read_thread_transcript(
                payload,
                historical.then(|| sessions::history_link(link, thread)),
            )
            .await?;
        page["sessionThreadId"] = json!(thread);
        // Clients continue the logical task; message metadata still identifies its native execution.
        page["threadId"] = json!(link.thread_id);
        if historical {
            page["running"] = json!(self.is_active_local_task(&link.local_task_id));
            page["contextUsage"] = Value::Null;
        }
        for key in ["messages", "turns", "turnNavigation"] {
            if let Some(items) = page[key].as_array_mut() {
                for item in items {
                    item["sessionThreadId"] = json!(thread);
                }
            }
        }
        Ok(page)
    }

    async fn read_session_collection(
        &self,
        payload: Value,
        link: &RuntimeTaskLink,
        ids: &[String],
    ) -> Result<Value, AppIpcError> {
        let mut result = json!({"messages":[],"turns":[],"turnNavigation":[]});
        for thread in ids {
            let page = self
                .read_session_page(payload.clone(), link, thread)
                .await?;
            let mut merged = page.clone();
            for key in ["messages", "turns", "turnNavigation"] {
                let mut rows = result[key].as_array().cloned().unwrap_or_default();
                rows.extend(page[key].as_array().cloned().unwrap_or_default());
                merged[key] = json!(rows);
            }
            result = merged;
        }
        Ok(result)
    }

    pub(super) async fn search_conversation_sessions(
        &self,
        payload: Value,
        link: &RuntimeTaskLink,
    ) -> Result<Value, AppIpcError> {
        let ids = sessions::thread_ids(link).map_err(|_| {
            AppIpcError::new(
                "invalid_session_state",
                "Conversation session history is invalid",
            )
        })?;
        let limit = integer_field(&payload, "limit")
            .and_then(|limit| usize::try_from(limit).ok())
            .filter(|limit| *limit > 0)
            .unwrap_or(250)
            .min(250);
        let mut matches = Vec::new();
        let mut capped = false;
        for thread in ids.iter().rev() {
            if matches.len() == limit {
                capped = true;
                break;
            }
            let mut request = payload.clone();
            request["threadId"] = json!(thread);
            request["limit"] = json!(limit - matches.len());
            let result = self.search_thread_transcript(request).await?;
            capped |= result["isCapped"] == true;
            for mut entry in result["matches"].as_array().cloned().unwrap_or_default() {
                if let Some(native) = entry["cursor"].as_str() {
                    entry["cursor"] = json!(encode_cursor(
                        &link.local_task_id,
                        thread,
                        Some(native.into()),
                        false
                    ));
                }
                entry["sessionThreadId"] = json!(thread);
                matches.push(entry);
            }
        }
        Ok(json!({"success":true,"totalMatches":matches.len(),"isCapped":capped,"matches":matches}))
    }
}
