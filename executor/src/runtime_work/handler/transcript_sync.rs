// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::runtime_work::native_transcript::{
    export_segment, remove_restored_transcript, restore_segments, ExportRequest, RestoreSegment,
    RestoredTranscript,
};

const CLOUD_TRANSCRIPT_HANDLE_KEY: &str = "cloudTranscript";

impl RuntimeWorkRpcHandler {
    pub(super) fn transcript_sync_status(&self, payload: Value) -> Result<Value, AppIpcError> {
        let transcript_id = required_transcript_id(&payload)?;
        let task_id = local_task_id(&payload, &transcript_id);
        let Some(link) = self.local_task_link(&task_id) else {
            return Ok(status(
                &task_id,
                &transcript_id,
                true,
                0,
                "restore_required",
            ));
        };
        if !is_codex_runtime(&link.runtime) {
            return Ok(status(
                &task_id,
                &transcript_id,
                false,
                imported_through(&link),
                "unsupported_runtime",
            ));
        }
        if !transcript_matches(&link, &transcript_id) {
            return Ok(status(
                &task_id,
                &transcript_id,
                false,
                imported_through(&link),
                "different_branch",
            ));
        }
        if link.thread_id.is_none() {
            return Ok(status(
                &task_id,
                &transcript_id,
                true,
                0,
                "restore_required",
            ));
        }
        if self.is_busy_local_task(&task_id) {
            return Ok(status(
                &task_id,
                &transcript_id,
                false,
                imported_through(&link),
                "task_running",
            ));
        }
        Ok(status(
            &task_id,
            &transcript_id,
            true,
            imported_through(&link),
            "ready",
        ))
    }

    pub(super) async fn export_transcript_segment(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let transcript_id = required_transcript_id(&payload)?;
        let task_id = local_task_id(&payload, &transcript_id);
        let link = self
            .local_task_link(&task_id)
            .ok_or_else(|| AppIpcError::new("task_missing", "runtime task is unavailable"))?;
        if !is_codex_runtime(&link.runtime) {
            return Err(AppIpcError::new(
                "unsupported_runtime",
                "native transcript synchronization requires Codex",
            ));
        }
        if self.is_busy_local_task(&task_id) {
            return Err(AppIpcError::new(
                "task_running",
                "cannot snapshot a running Codex task",
            ));
        }
        let thread_id = link
            .thread_id
            .clone()
            .ok_or_else(|| AppIpcError::new("thread_missing", "Codex thread is unavailable"))?;
        let sequence = required_u64(&payload, "sequence")?;
        let base_sequence = alias_u64(&payload, "baseSequence", "base_sequence")?;
        let snapshot = payload
            .get("snapshot")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let encryption_key = string_field(&payload, "encryptionKey")
            .or_else(|| string_field(&payload, "encryption_key"))
            .ok_or_else(|| {
                AppIpcError::new("bad_request", "transcript encryptionKey is required")
            })?;
        let request = ExportRequest {
            transcript_id,
            task_id,
            title: link.title.clone(),
            workspace_path: Path::new(&link.workspace_path).to_path_buf(),
            thread_id,
            sequence,
            base_sequence,
            rollout_start: if snapshot {
                0
            } else {
                synchronized_rollout_bytes(&link)
            },
            snapshot,
            encryption_key,
        };
        let exported = tokio::task::spawn_blocking(move || export_segment(request))
            .await
            .map_err(|error| {
                AppIpcError::new(
                    "transcript_export_failed",
                    format!("native transcript export worker failed: {error}"),
                )
            })?
            .map_err(|error| AppIpcError::new("transcript_export_failed", error))?;
        Ok(json!({
            "success": true,
            "path": exported.path,
            "sha256": exported.sha256,
            "sizeBytes": exported.size_bytes,
            "format": exported.format,
            "rolloutEnd": exported.rollout_end,
        }))
    }

    pub(super) async fn restore_transcript_segments(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let transcript_id = required_transcript_id(&payload)?;
        let task_id = local_task_id(&payload, &transcript_id);
        let segments = serde_json::from_value::<Vec<RestoreSegment>>(
            payload
                .get("segments")
                .cloned()
                .ok_or_else(|| AppIpcError::new("bad_request", "segments is required"))?,
        )
        .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
        let encryption_key = string_field(&payload, "encryptionKey")
            .or_else(|| string_field(&payload, "encryption_key"))
            .ok_or_else(|| {
                AppIpcError::new("bad_request", "transcript encryptionKey is required")
            })?;
        let mut superseded_restore = None;
        if let Some(link) = self.local_task_link(&task_id) {
            let requested = segments
                .iter()
                .map(|segment| segment.sequence)
                .max()
                .unwrap_or_default();
            if link.thread_id.is_some()
                && transcript_matches(&link, &transcript_id)
                && imported_through(&link) >= requested
            {
                return Ok(status(
                    &task_id,
                    &transcript_id,
                    transcript_matches(&link, &transcript_id),
                    imported_through(&link),
                    "already_bound",
                ));
            }
            if self.is_busy_local_task(&task_id) {
                return Ok(status(
                    &task_id,
                    &transcript_id,
                    false,
                    imported_through(&link),
                    "task_running",
                ));
            }
            if transcript_matches(&link, &transcript_id) {
                superseded_restore = link
                    .thread_id
                    .map(|thread_id| (link.workspace_path, thread_id));
            }
        }
        let restore_transcript_id = transcript_id.clone();
        let restored = tokio::task::spawn_blocking(move || {
            restore_segments(&restore_transcript_id, &segments, &encryption_key)
        })
        .await
        .map_err(|error| {
            AppIpcError::new(
                "transcript_restore_failed",
                format!("native transcript restore worker failed: {error}"),
            )
        })?
        .map_err(|error| AppIpcError::new("transcript_restore_failed", error))?;
        let link = restored_task_link(&task_id, &transcript_id, &restored);
        if let Some((workspace_path, thread_id)) = superseded_restore {
            match remove_restored_transcript(std::path::Path::new(&workspace_path), &thread_id) {
                Ok(true) => {}
                Ok(false) => {
                    let _ =
                        remove_restored_transcript(&restored.workspace_path, &restored.thread_id);
                    return Err(AppIpcError::new(
                        "transcript_restore_failed",
                        "refusing to replace a transcript outside the managed restore directory",
                    ));
                }
                Err(error) => {
                    let _ =
                        remove_restored_transcript(&restored.workspace_path, &restored.thread_id);
                    return Err(AppIpcError::new("transcript_restore_failed", error));
                }
            }
        }
        self.upsert_local_task(link);
        emit_runtime_work_changed(&self.event_tx, &self.device_id, &task_id);
        Ok(json!({
            "success": true,
            "available": true,
            "taskId": task_id,
            "transcriptId": transcript_id,
            "threadId": restored.thread_id,
            "workspacePath": restored.workspace_path,
            "importedThrough": restored.sequence,
            "reason": "restored",
        }))
    }

    pub(super) fn acknowledge_transcript_turn(&self, payload: Value) -> Result<Value, AppIpcError> {
        let transcript_id = required_transcript_id(&payload)?;
        let task_id = local_task_id(&payload, &transcript_id);
        let sequence = required_u64(&payload, "sequence")?;
        let rollout_end = alias_u64(&payload, "rolloutEnd", "rollout_end")?;
        let parent_id = string_field(&payload, "parentTranscriptId")
            .or_else(|| string_field(&payload, "parent_transcript_id"));
        let updated = self.store.update_task(&task_id, |link| {
            let current_id = cloud_transcript_id(link);
            if current_id.as_deref() == Some(transcript_id.as_str())
                || current_id.is_none()
                || parent_id.as_deref() == current_id.as_deref()
            {
                set_cloud_transcript(link, &transcript_id, sequence, rollout_end);
                link.updated_at = now_ms();
            }
        });
        let Some(link) = updated else {
            return Ok(status(&task_id, &transcript_id, false, 0, "task_missing"));
        };
        Ok(status(
            &task_id,
            &transcript_id,
            transcript_matches(&link, &transcript_id),
            imported_through(&link),
            "acknowledged",
        ))
    }
}

fn restored_task_link(
    task_id: &str,
    transcript_id: &str,
    restored: &RestoredTranscript,
) -> RuntimeTaskLink {
    let mut link = RuntimeTaskLink::new_pending(
        task_id.to_owned(),
        restored.workspace_path.to_string_lossy().into_owned(),
        restored.title.clone(),
    );
    link.thread_id = Some(restored.thread_id.clone());
    set_cloud_transcript(
        &mut link,
        transcript_id,
        restored.sequence,
        restored.rollout_end,
    );
    link
}

fn required_transcript_id(payload: &Value) -> Result<String, AppIpcError> {
    string_field(payload, "transcriptId")
        .or_else(|| string_field(payload, "transcript_id"))
        .ok_or_else(|| AppIpcError::new("bad_request", "transcriptId is required"))
}

fn required_u64(payload: &Value, key: &str) -> Result<u64, AppIpcError> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| AppIpcError::new("bad_request", format!("{key} is required")))
}

fn alias_u64(payload: &Value, key: &str, alias: &str) -> Result<u64, AppIpcError> {
    required_u64(payload, key).or_else(|_| required_u64(payload, alias))
}

fn local_task_id(payload: &Value, transcript_id: &str) -> String {
    runtime_task_id(payload).unwrap_or_else(|| transcript_id.to_owned())
}

fn status(
    task_id: &str,
    transcript_id: &str,
    available: bool,
    sequence: u64,
    reason: &str,
) -> Value {
    json!({
        "success": true,
        "available": available,
        "taskId": task_id,
        "transcriptId": transcript_id,
        "importedThrough": sequence,
        "reason": reason,
    })
}

fn cloud_transcript_id(link: &RuntimeTaskLink) -> Option<String> {
    link.runtime_handle
        .get(CLOUD_TRANSCRIPT_HANDLE_KEY)
        .and_then(|value| string_field(value, "transcriptId"))
}

fn transcript_matches(link: &RuntimeTaskLink, transcript_id: &str) -> bool {
    cloud_transcript_id(link)
        .map(|current| current == transcript_id)
        .unwrap_or_else(|| link.local_task_id == transcript_id)
}

fn imported_through(link: &RuntimeTaskLink) -> u64 {
    link.runtime_handle
        .get(CLOUD_TRANSCRIPT_HANDLE_KEY)
        .and_then(|value| value.get("importedThrough"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn synchronized_rollout_bytes(link: &RuntimeTaskLink) -> u64 {
    link.runtime_handle
        .get(CLOUD_TRANSCRIPT_HANDLE_KEY)
        .and_then(|value| value.get("rolloutBytes"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn set_cloud_transcript(
    link: &mut RuntimeTaskLink,
    transcript_id: &str,
    sequence: u64,
    rollout_bytes: u64,
) {
    if !link.runtime_handle.is_object() {
        link.runtime_handle = json!({});
    }
    link.runtime_handle[CLOUD_TRANSCRIPT_HANDLE_KEY] = json!({
        "transcriptId": transcript_id,
        "importedThrough": sequence,
        "rolloutBytes": rollout_bytes,
    });
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{cloud_transcript_id, imported_through, restored_task_link, RestoredTranscript};

    #[test]
    fn restore_preserves_the_requested_local_task_identity() {
        let restored = RestoredTranscript {
            title: "Restored".to_owned(),
            workspace_path: PathBuf::from("/tmp/restored"),
            thread_id: "thread-2".to_owned(),
            sequence: 4,
            rollout_end: 2048,
        };

        let link = restored_task_link("local-task", "cloud-transcript", &restored);

        assert_eq!(link.local_task_id, "local-task");
        assert_eq!(
            cloud_transcript_id(&link).as_deref(),
            Some("cloud-transcript")
        );
        assert_eq!(imported_through(&link), 4);
    }
}
