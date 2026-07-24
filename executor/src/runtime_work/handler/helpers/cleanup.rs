fn cleanup_task_files_preview(link: &RuntimeTaskLink) -> Value {
    cleanup_task_files_response(link, false, true)
}
fn cleanup_task_files_response(link: &RuntimeTaskLink, delete: bool, measure_bytes: bool) -> Value {
    let targets = cleanup_targets_for_task(link);
    let mut cleaned_count = 0_u64;
    let mut skipped_count = 0_u64;
    let mut error_count = 0_u64;
    let mut total_bytes = 0_u64;
    let mut items = Vec::new();

    for target in targets {
        let exists = target.path.exists();
        let bytes = if measure_bytes {
            path_size(&target.path).unwrap_or(0)
        } else {
            0
        };
        total_bytes = total_bytes.saturating_add(bytes);
        let mut item = json!({
            "kind": target.kind,
            "path": target.path.to_string_lossy(),
            "exists": exists,
            "bytes": bytes,
        });

        if !exists {
            skipped_count += 1;
            item["status"] = json!("missing");
            items.push(item);
            continue;
        }

        if delete {
            match remove_cleanup_target(&target) {
                Ok(()) => {
                    cleaned_count += 1;
                    item["status"] = json!("cleaned");
                }
                Err(error) => {
                    error_count += 1;
                    item["status"] = json!("failed");
                    item["error"] = json!(error);
                }
            }
        } else {
            cleaned_count += 1;
            item["status"] = json!("preview");
        }
        items.push(item);
    }

    json!({
        "taskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "targetCount": items.len(),
        "cleanableCount": cleaned_count,
        "skippedCount": skipped_count,
        "errorCount": error_count,
        "bytes": total_bytes,
        "items": items,
    })
}

fn cleanup_summary_response(results: Vec<Value>, deleted: bool) -> Value {
    let target_count = results
        .iter()
        .map(|result| {
            result
                .get("targetCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        })
        .sum::<u64>();
    let cleanable_count = results
        .iter()
        .map(|result| {
            result
                .get("cleanableCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        })
        .sum::<u64>();
    let skipped_count = results
        .iter()
        .map(|result| {
            result
                .get("skippedCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        })
        .sum::<u64>();
    let error_count = results
        .iter()
        .map(|result| {
            result
                .get("errorCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        })
        .sum::<u64>();
    let total_bytes = results
        .iter()
        .map(|result| result.get("bytes").and_then(Value::as_u64).unwrap_or(0))
        .sum::<u64>();

    json!({
        "success": error_count == 0,
        "deleted": deleted,
        "taskCount": results.len(),
        "targetCount": target_count,
        "cleanableCount": cleanable_count,
        "skippedCount": skipped_count,
        "errorCount": error_count,
        "bytes": total_bytes,
        "results": results,
    })
}

struct CleanupTarget {
    kind: &'static str,
    path: PathBuf,
}

fn cleanup_targets_for_task(link: &RuntimeTaskLink) -> Vec<CleanupTarget> {
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    push_cleanup_target(
        &mut targets,
        &mut seen,
        worktree_cleanup_target(&link.workspace_path),
    );
    push_cleanup_target(
        &mut targets,
        &mut seen,
        standalone_chat_cleanup_target(&link.local_task_id, &link.workspace_path),
    );
    push_cleanup_target(
        &mut targets,
        &mut seen,
        workspace_attachment_cleanup_target(link, ".wegent/attachments"),
    );
    push_cleanup_target(
        &mut targets,
        &mut seen,
        workspace_attachment_cleanup_target(
            link,
            &format!("{}:executor:attachments", link.local_task_id),
        ),
    );

    for path in local_attachment_paths(&link.runtime_handle) {
        push_cleanup_target(
            &mut targets,
            &mut seen,
            local_attachment_cleanup_target(&path),
        );
    }
    if let Some(parent) = &link.parent {
        for path in local_attachment_paths(parent) {
            push_cleanup_target(
                &mut targets,
                &mut seen,
                local_attachment_cleanup_target(&path),
            );
        }
    }

    targets
}

fn push_cleanup_target(
    targets: &mut Vec<CleanupTarget>,
    seen: &mut HashSet<String>,
    target: Option<CleanupTarget>,
) {
    let Some(target) = target else {
        return;
    };
    let key = normalize_workspace_path(&target.path.to_string_lossy());
    if seen.insert(key) {
        targets.push(target);
    }
}

fn worktree_cleanup_target(path: &str) -> Option<CleanupTarget> {
    let normalized = normalize_workspace_path(path);
    if !is_managed_worktree_path(&normalized) {
        return None;
    }
    Some(CleanupTarget {
        kind: "worktree",
        path: PathBuf::from(normalized),
    })
}

fn standalone_chat_cleanup_target(local_task_id: &str, path: &str) -> Option<CleanupTarget> {
    let normalized = normalize_workspace_path(path);
    if !normalized.contains("/Documents/Codex/") {
        return None;
    }
    let segment = workspace_segment(local_task_id);
    if Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(segment.as_str())
    {
        return None;
    }
    Some(CleanupTarget {
        kind: "standalone_workspace",
        path: PathBuf::from(normalized),
    })
}

fn workspace_attachment_cleanup_target(
    link: &RuntimeTaskLink,
    relative: &str,
) -> Option<CleanupTarget> {
    let workspace = PathBuf::from(normalize_workspace_path(&link.workspace_path));
    if workspace.as_os_str().is_empty() {
        return None;
    }
    let path = if relative == ".wegent/attachments" {
        workspace.join(relative).join(&link.local_task_id)
    } else {
        workspace.join(relative)
    };
    Some(CleanupTarget {
        kind: "workspace_attachment",
        path,
    })
}

fn local_attachment_cleanup_target(path: &str) -> Option<CleanupTarget> {
    let normalized = normalize_workspace_path(path);
    if !is_local_attachment_draft_path(&normalized) {
        return None;
    }
    Some(CleanupTarget {
        kind: "local_attachment",
        path: PathBuf::from(normalized),
    })
}

fn local_attachment_paths(value: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_local_attachment_paths(value, &mut paths);
    paths
}

fn collect_local_attachment_paths(value: &Value, paths: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_local_attachment_paths(item, paths);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                if matches!(
                    key.as_str(),
                    "local_path" | "localPath" | "local_preview_url" | "localPreviewUrl"
                ) {
                    if let Some(path) = value
                        .as_str()
                        .map(str::trim)
                        .filter(|path| !path.is_empty())
                    {
                        paths.push(path.to_owned());
                    }
                }
                collect_local_attachment_paths(value, paths);
            }
        }
        _ => {}
    }
}

fn remove_cleanup_target(target: &CleanupTarget) -> Result<(), String> {
    if target.kind == "worktree" {
        remove_git_worktree_best_effort(&target.path);
    }
    if target.path.is_dir() {
        fs::remove_dir_all(&target.path)
            .map_err(|error| format!("failed to remove directory: {error}"))?;
    } else if target.path.is_file() {
        fs::remove_file(&target.path).map_err(|error| format!("failed to remove file: {error}"))?;
    }
    Ok(())
}

fn remove_git_worktree_best_effort(path: &Path) {
    let path = path.to_string_lossy().to_string();
    let _ = std::process::Command::new("git")
        .args(["-C", &path, "worktree", "remove", "--force", &path])
        .output();
}

fn path_size(path: &Path) -> Option<u64> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.is_file() {
        return Some(metadata.len());
    }
    if !metadata.is_dir() {
        return Some(0);
    }
    let mut size = 0_u64;
    for entry in fs::read_dir(path).ok()? {
        let entry = entry.ok()?;
        size = size.saturating_add(path_size(&entry.path()).unwrap_or(0));
    }
    Some(size)
}

fn is_managed_worktree_path(path: &str) -> bool {
    path.contains("/.wecode/wegent-executor/workspace/worktrees/")
        || path.contains("/.wegent-executor/workspace/worktrees/")
}

fn is_local_attachment_draft_path(path: &str) -> bool {
    path.contains("/.wegent-executor/workspace/attachments/draft/")
        || path.contains("/.wecode/wegent-executor/workspace/attachments/draft/")
}

fn task_action_success(link: &RuntimeTaskLink) -> Value {
    json!({
        "success": true,
        "accepted": true,
        "taskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "runtime": link.runtime,
    })
}

fn sidebar_mutation_response(device_id: &str) -> Value {
    json!({
        "success": true,
        "accepted": true,
        "deviceId": device_id,
    })
}

fn task_action_failure(link: &RuntimeTaskLink, error: String) -> Value {
    json!({
        "success": false,
        "accepted": false,
        "taskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "runtime": link.runtime,
        "error": error,
    })
}

fn codex_error_is_missing_rollout(error: &str, thread_id: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("no rollout found for thread id")
        && error.contains(&thread_id.to_ascii_lowercase())
}

fn task_goal_missing_session(link: &RuntimeTaskLink) -> Value {
    json!({
        "success": false,
        "accepted": false,
        "taskId": link.local_task_id,
        "workspacePath": link.workspace_path,
        "runtime": link.runtime,
        "error": "runtime task session is not ready",
        "code": "missing_runtime_session",
    })
}
