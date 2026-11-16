// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) struct TranscriptProjectionInput {
    pub(super) payload: Value,
    pub(super) thread: Value,
    pub(super) local_task_id: String,
    pub(super) thread_id: String,
    pub(super) local_link: Option<RuntimeTaskLink>,
    pub(super) direct_thread_override: bool,
    pub(super) search_match_requested: bool,
    pub(super) full_item_content: bool,
    pub(super) limit: Option<usize>,
    pub(super) before_cursor: Option<String>,
    pub(super) after_cursor: Option<String>,
    pub(super) page_before_cursor: Option<String>,
    pub(super) page_after_cursor: Option<String>,
    pub(super) refresh: bool,
    pub(super) running_hint: bool,
    pub(super) started_at: Instant,
    pub(super) include_full_content: bool,
    pub(super) conversation_context_only: bool,
    pub(super) bounded_native_page: bool,
    pub(super) historical_session: bool,
}

impl RuntimeWorkRpcHandler {
    pub(super) fn project_transcript_response(
        &self,
        input: TranscriptProjectionInput,
        cancellation: &super::super::transcript_work::Cancellation,
    ) -> Result<Value, AppIpcError> {
        let TranscriptProjectionInput {
            payload,
            mut thread,
            local_task_id,
            thread_id,
            mut local_link,
            mut direct_thread_override,
            search_match_requested,
            full_item_content,
            limit,
            before_cursor,
            after_cursor,
            page_before_cursor,
            page_after_cursor,
            refresh,
            running_hint,
            started_at,
            include_full_content,
            conversation_context_only,
            bounded_native_page,
            mut historical_session,
        } = input;
        let handler = self;
        if let Some(link) = local_link.as_ref().filter(|link| {
            super::super::conversation_sessions::is_identity_conversation(link)
                && handler
                    .store
                    .read_task(&local_task_id, |latest| {
                        latest.thread_id.as_deref() != Some(thread_id.as_str())
                    })
                    .unwrap_or(false)
        }) {
            historical_session = true;
            direct_thread_override = true;
            local_link = Some(super::super::conversation_sessions::history_link(
                link, &thread_id,
            ));
        }
        // Native history reads can overlap terminal events. Merge the latest
        // completed items and execution state rather than the pre-read snapshot.
        let mut local_link = if historical_session {
            local_link
        } else {
            let fresh = if bounded_native_page {
                handler.store.get_task_summary(&local_task_id)
            } else {
                handler.local_task_link(&local_task_id)
            };
            fresh.or(local_link)
        };
        let local_execution_running =
            !historical_session && handler.is_active_local_task(&local_task_id);
        if let Some(workspace_path) = local_link
            .as_ref()
            .map(|link| link.workspace_path.as_str())
            .filter(|path| !path.is_empty())
        {
            if let Some(thread) = thread.as_object_mut() {
                thread.insert("cwd".to_owned(), Value::String(workspace_path.to_owned()));
            }
        }
        if let Some(link) = local_link.as_ref().filter(|_| !direct_thread_override) {
            normalize_overload_recovery_thread(&mut thread, &link.runtime_handle);
            let superseded = superseded_transcript_turn_ids(&link.runtime_handle);
            if let Some(turns) = thread.get_mut("turns").and_then(Value::as_array_mut) {
                turns.retain(|turn| {
                    string_field(turn, "id").map_or(true, |id| !superseded.contains(id.as_str()))
                });
            }
        }
        let presentation_page_turn_ids = thread
            .get("turns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|turn| string_field(turn, "id"))
            .collect::<Vec<_>>();
        let presentation_page_messages = local_link
            .as_ref()
            .filter(|_| !direct_thread_override || historical_session)
            .map(|_| super::super::transcript::transcript_page_identity(&thread));
        if !direct_thread_override && !search_match_requested {
            if before_cursor.is_none() && after_cursor.is_none() {
                handler.reconcile_native_transcript_terminal(&local_task_id, &thread);
            }
            handler.merge_active_codex_transcript_cancellable(
                &local_task_id,
                &mut thread,
                cancellation,
            )?;
            handler.repair_legacy_task_activity_time(&local_task_id, &thread);
        }
        if historical_session {
            local_link = handler
                .native_transcript_page_link(&local_task_id, &thread, cancellation)?
                .map(|link| super::super::conversation_sessions::history_link(&link, &thread_id))
                .or(local_link);
        } else if bounded_native_page && !direct_thread_override {
            local_link = handler
                .native_transcript_page_link(&local_task_id, &thread, cancellation)?
                .or(local_link);
        }
        let workspace_path = local_link
            .as_ref()
            .map(|link| link.workspace_path.clone())
            .filter(|path| !path.trim().is_empty())
            .or_else(|| string_field(&thread, "cwd"))
            .or_else(|| string_field(&payload, "workspacePath"))
            .or_else(|| string_field(&payload, "workspace_path"))
            .unwrap_or_default();

        let context_usage = transcript_context_usage(&thread);
        let projection = super::super::transcript::project_transcript_cancellable(
            &thread,
            &handler.device_id,
            full_item_content,
            payload["transcriptProtocolVersion"] == 2,
            cancellation,
        )?;
        let mut native_turns = projection.turns;
        let mut messages = projection.messages;
        if let Some(link) = local_link
            .as_ref()
            .filter(|_| !direct_thread_override || historical_session)
        {
            if thread.get("timeline").and_then(Value::as_bool) != Some(true) {
                merge_latest_completed_transcript_messages(
                    &mut messages,
                    link,
                    before_cursor.as_deref(),
                    after_cursor.as_deref(),
                );
            }
            let mut presentations =
                native_page_user_presentations(user_message_presentations(link), &thread);
            if search_match_requested {
                // Search slices restore metadata only for items in their bounded
                // neighborhood; unrelated prompts stay in the original page.
                for presentation in &mut presentations {
                    presentation["ensureVisible"] = json!(false);
                }
            }
            if thread["timeline"] == true {
                bind_native_user_presentations(&mut messages, &presentations);
            }
            attach_user_message_presentations_for_page(
                &mut messages,
                presentations,
                presentation_page_messages.as_deref().unwrap_or_default(),
                &presentation_page_turn_ids,
                page_before_cursor.is_some(),
                page_after_cursor.is_some(),
            );
            remove_superseded_transcript_turns(&mut messages, &link.runtime_handle);
        }
        if !search_match_requested {
            attach_legacy_thread_preview(&mut messages, &thread, page_before_cursor.is_some());
        }
        if before_cursor.is_none()
            && after_cursor.is_none()
            && !include_full_content
            && thread.get("timeline").and_then(Value::as_bool) != Some(true)
        {
            let snapshot_changed = local_link.as_ref().is_some_and(|link| {
                link.thread_id.as_deref() == Some(thread_id.as_str())
                    && (transcript_snapshot_messages(link) != messages
                        || transcript_snapshot_pagination(link)
                            != Some((page_before_cursor.clone(), page_after_cursor.clone())))
            });
            if snapshot_changed {
                let snapshot_messages = messages.clone();
                handler.store.update_task(&local_task_id, |link| {
                    if link.thread_id.as_deref() == Some(thread_id.as_str()) {
                        set_transcript_snapshot_messages(
                            &mut link.runtime_handle,
                            &thread_id,
                            snapshot_messages,
                            page_before_cursor.clone(),
                            page_after_cursor.clone(),
                        );
                    }
                });
            }
        }
        let running = local_execution_running || codex_thread_has_in_progress_turn(&thread);
        let message_count = messages.len();
        let turn_navigation = if include_full_content
            || (before_cursor.is_none() && after_cursor.is_none() && page_before_cursor.is_none())
        {
            transcript_turn_navigation(&messages)
        } else {
            Vec::new()
        };
        log_runtime_transcript_finished(RuntimeTranscriptLog {
            started_at,
            local_task_id: &local_task_id,
            thread_id: &thread_id,
            source: "thread_pagination",
            refresh,
            running_hint,
            limit,
            before_cursor: before_cursor.as_deref(),
            after_cursor: after_cursor.as_deref(),
            message_count,
            running,
        });

        if thread.get("timeline").and_then(Value::as_bool) == Some(true)
            && !conversation_context_only
        {
            // Presentation metadata enriches user items; it never determines item order.
            for turn in &mut native_turns {
                for item in turn["items"].as_array_mut().into_iter().flatten() {
                    if item["type"] != "user_message" {
                        continue;
                    }
                    if let Some(message) = messages
                        .iter()
                        .find(|message| message["id"] == item["message"]["id"])
                    {
                        item["message"] = message.clone();
                    }
                }
                let turn_id = turn["id"].clone();
                for message in messages
                    .iter()
                    .filter(|message| message["role"] == "user" && message["turnId"] == turn_id)
                {
                    let items = turn["items"].as_array().unwrap();
                    if items.iter().any(|item| {
                        item["type"] == "user_message" && item["message"]["id"] == message["id"]
                    }) {
                        continue;
                    }
                    let id = message
                        .get("clientUserMessageId")
                        .or_else(|| message.get("id"))
                        .cloned();
                    if let Some(id) = id {
                        turn["items"]
                            .as_array_mut()
                            .unwrap()
                            .insert(0, json!({"id":id,"type":"user_message","message":message}));
                    }
                }
            }
        }
        let runtime_turns = local_link
            .as_ref()
            .filter(|_| !direct_thread_override && thread["timeline"] == true)
            .map(|link| {
                super::transcript_overlays::runtime_transcript_overlay_turns(link, &native_turns)
            });
        let mut response = transcript_response(TranscriptResponseInput {
            canonical_turns: (thread.get("timeline").and_then(Value::as_bool) == Some(true))
                .then_some(native_turns),
            local_task_id,
            workspace_path,
            runtime: "codex".to_owned(),
            messages,
            context_usage,
            running,
            pagination: TranscriptPagination::Opaque {
                before_cursor: if include_full_content {
                    None
                } else {
                    page_before_cursor
                },
                after_cursor: if include_full_content {
                    None
                } else {
                    page_after_cursor
                },
            },
            full_content: include_full_content,
            conversation_context_only,
            turn_item_source: TranscriptTurnItemSource::CodexItems,
            turn_navigation,
        });
        response["threadId"] = json!(thread_id);
        if conversation_context_only {
            response["fullItemContent"] = json!(full_item_content);
        }
        if let Some(link) = local_link.as_ref().filter(|_| !direct_thread_override) {
            if let Some(runtime_turns) = runtime_turns {
                response["runtimeTurns"] = json!(runtime_turns);
            }
            response["supersededTurnIds"] =
                json!(superseded_transcript_turn_ids(&link.runtime_handle));
        }
        handler.log_suspicious_transcript_outcomes(
            &response,
            &thread,
            local_link.as_ref(),
            direct_thread_override,
        );
        Ok(response)
    }
}
