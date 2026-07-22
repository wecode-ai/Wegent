// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

static IMPORTED_TASK_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl RuntimeWorkRpcHandler {
    pub(super) async fn prepare_fork_transfer(&self, payload: Value) -> Result<Value, AppIpcError> {
        let transfer =
            match crate::runtime_work::fork_transfer::validate_prepare_transfer_payload(&payload) {
                Ok(transfer) => transfer,
                Err(error) => return Ok(fork_error_response(error.code(), error.to_string())),
            };
        let workspace_path = workspace_path(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "workspacePath is required"))?;
        let link = self.task_link_from_payload(&payload, false).await?;
        let include_workspace = transfer.workspace_transfer.as_deref() == Some("git_workspace");
        let mut archive = Map::new();
        archive.insert(
            "mode".to_owned(),
            Value::String(
                if include_workspace {
                    "git_workspace"
                } else {
                    "session_only"
                }
                .to_owned(),
            ),
        );
        archive.insert("transferId".to_owned(), Value::String(transfer.transfer_id));
        archive.insert(
            "requiresWorkspaceRestore".to_owned(),
            Value::Bool(include_workspace),
        );
        archive.insert("directUrls".to_owned(), Value::Array(Vec::new()));
        if let Some(upload_url) = transfer.upload_url {
            archive.insert("uploadUrl".to_owned(), Value::String(upload_url));
        }
        if let Some(direct_hosts) = transfer.direct_hosts {
            archive.insert(
                "directHosts".to_owned(),
                Value::Array(direct_hosts.into_iter().map(Value::String).collect()),
            );
        }

        Ok(json!({
            "success": true,
            "accepted": true,
            "workspacePath": workspace_path,
            "taskId": link.local_task_id,
            "package": {
                "sourceRuntime": link.runtime,
                "title": link.title,
                "runtimeHandle": runtime_handle_json(&link),
                "recentMessages": cached_messages(&link),
                "archive": Value::Object(archive),
            }
        }))
    }

    pub(super) async fn import_fork(&self, payload: Value) -> Result<Value, AppIpcError> {
        let import =
            match crate::runtime_work::fork_transfer::validate_import_fork_payload(&payload) {
                Ok(import) => import,
                Err(error) => return Ok(fork_error_response(error.code(), error.to_string())),
            };
        let runtime = string_field(&import.fork_package, "sourceRuntime")
            .or_else(|| string_field(&import.fork_package, "source_runtime"))
            .unwrap_or_else(|| "codex".to_owned());
        if runtime.eq_ignore_ascii_case("codex") {
            return Ok(json!({
                "success": false,
                "error": "Codex fork imports must restore into native Codex, not runtime index",
                "code": "bad_request",
            }));
        }
        let runtime_handle = match crate::runtime_work::fork_transfer::build_imported_runtime_handle(
            &import.fork_package,
        ) {
            Ok(runtime_handle) => runtime_handle,
            Err(error) => return Ok(fork_error_response(error.code(), error.to_string())),
        };
        let local_task_id = next_imported_task_id();
        let title = string_field(&import.fork_package, "title")
            .unwrap_or_else(|| "Forked runtime task".to_owned());
        let parent = source_parent_json(&import.source);
        let link = RuntimeTaskLink::new_imported(
            local_task_id.clone(),
            import.workspace_path,
            title,
            runtime,
            runtime_handle,
            parent,
        );
        self.upsert_local_task(link.clone());
        Ok(task_action_success(&link))
    }
}

pub(super) fn next_imported_task_id() -> String {
    let sequence = IMPORTED_TASK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("runtime-fork-{}-{sequence}", now_ms())
}
