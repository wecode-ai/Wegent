// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn file_changes(value: &Value) -> Option<Value> {
    value
        .get("fileChanges")
        .or_else(|| value.get("file_changes"))
        .filter(|value| value.is_object())
        .cloned()
}

pub(super) fn merge_file_changes(existing: Option<Value>, next: Value) -> Option<Value> {
    let Some(mut current) = existing else {
        return Some(next);
    };
    let Some(current_object) = current.as_object_mut() else {
        return Some(next);
    };
    let Some(next_object) = next.as_object() else {
        return Some(current);
    };

    let mut files = current_object
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for next_file in next_object
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(next_path) = string_field(next_file, "path") else {
            continue;
        };
        if let Some(existing_index) = files
            .iter()
            .position(|file| string_field(file, "path").is_some_and(|path| path == next_path))
        {
            files[existing_index] = merge_file_change(files.get(existing_index), next_file);
        } else {
            files.push(next_file.clone());
        }
    }
    if files.is_empty() {
        return Some(current);
    }

    for key in [
        "status",
        "device_id",
        "workspace_path",
        "reverted_at",
        "revertible",
    ] {
        if let Some(value) = next_object.get(key) {
            current_object.insert(key.to_owned(), value.clone());
        }
    }

    let additions = files
        .iter()
        .filter_map(|file| file.get("additions").and_then(Value::as_i64))
        .sum::<i64>();
    let deletions = files
        .iter()
        .filter_map(|file| file.get("deletions").and_then(Value::as_i64))
        .sum::<i64>();
    current_object.insert("file_count".to_owned(), json!(files.len()));
    current_object.insert("additions".to_owned(), json!(additions));
    current_object.insert("deletions".to_owned(), json!(deletions));
    current_object.insert("files".to_owned(), Value::Array(files));

    let combined_diff = [
        current_object.get("diff").and_then(Value::as_str),
        next_object.get("diff").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .filter(|diff| !diff.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    if combined_diff.is_empty() {
        current_object.remove("diff");
    } else {
        current_object.insert("diff".to_owned(), Value::String(combined_diff));
    }

    Some(current)
}

fn merge_file_change(existing: Option<&Value>, next: &Value) -> Value {
    let Some(existing) = existing else {
        return next.clone();
    };
    let Some(existing_object) = existing.as_object() else {
        return next.clone();
    };
    let Some(next_object) = next.as_object() else {
        return existing.clone();
    };

    let additions = existing_object
        .get("additions")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + next_object
            .get("additions")
            .and_then(Value::as_i64)
            .unwrap_or(0);
    let deletions = existing_object
        .get("deletions")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + next_object
            .get("deletions")
            .and_then(Value::as_i64)
            .unwrap_or(0);

    let mut merged = existing_object.clone();
    for key in ["path", "binary"] {
        if let Some(value) = next_object.get(key) {
            merged.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(value) = next_object.get("old_path").filter(|value| !value.is_null()) {
        merged.insert("old_path".to_owned(), value.clone());
    }
    let change_type = merged_change_type(
        existing_object.get("change_type").and_then(Value::as_str),
        next_object.get("change_type").and_then(Value::as_str),
    );
    merged.insert("change_type".to_owned(), Value::String(change_type));
    merged.insert("additions".to_owned(), json!(additions));
    merged.insert("deletions".to_owned(), json!(deletions));
    Value::Object(merged)
}

fn merged_change_type(existing: Option<&str>, next: Option<&str>) -> String {
    match (existing, next) {
        (Some("created"), Some("modified")) => "created".to_owned(),
        (_, Some(next)) => next.to_owned(),
        (Some(existing), _) => existing.to_owned(),
        _ => "modified".to_owned(),
    }
}

pub(super) fn file_changes_from_file_change_item(
    item: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
) -> Option<Value> {
    let changes = item.get("changes")?.as_array()?;
    let files = changes
        .iter()
        .filter_map(|change| file_change_from_codex_change(change, workspace_path))
        .collect::<Vec<_>>();
    file_changes_summary(
        &item_id(item, "file-change"),
        turn_id,
        device_id,
        workspace_path,
        files,
        combined_diff_from_codex_changes(item, workspace_path),
    )
}

pub(super) fn file_changes_from_patch_updated(
    params: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
) -> Option<Value> {
    let changes = params.get("changes")?.as_array()?;
    let files = changes
        .iter()
        .filter_map(|change| file_change_from_codex_change(change, workspace_path))
        .collect::<Vec<_>>();
    file_changes_summary(
        &patch_updated_item_id(params),
        turn_id,
        device_id,
        workspace_path,
        files,
        combined_diff_from_codex_changes(params, workspace_path),
    )
}

pub(super) fn file_changes_from_patch_apply_end(
    item: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
) -> Option<Value> {
    if bool_field(item, "success").is_some_and(|success| !success) {
        return None;
    }
    let changes = item.get("changes")?.as_object()?;
    let files = changes
        .iter()
        .filter_map(|(path, change)| file_change_from_patch_change(path, change, workspace_path))
        .collect::<Vec<_>>();
    file_changes_summary(
        &item_id(item, "patch"),
        turn_id,
        device_id,
        workspace_path,
        files,
        combined_diff_from_patch_apply_end(item, workspace_path),
    )
}

fn file_changes_summary(
    item_id: &str,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
    files: Vec<Value>,
    diff: Option<String>,
) -> Option<Value> {
    if files.is_empty() {
        return None;
    }
    let diff = diff.filter(|diff| !diff.trim().is_empty());
    let artifact_id = diff.as_deref().and_then(|patch| {
        persist_named_artifact(
            Path::new(workspace_path),
            "codex",
            turn_id,
            &executor_home(),
            patch.as_bytes(),
        )
    });
    let additions = files
        .iter()
        .filter_map(|file| file.get("additions").and_then(Value::as_i64))
        .sum::<i64>();
    let deletions = files
        .iter()
        .filter_map(|file| file.get("deletions").and_then(Value::as_i64))
        .sum::<i64>();
    let mut summary = json!({
        "version": 1,
        "status": "active",
        "artifact_id": artifact_id
            .clone()
            .unwrap_or_else(|| format!("codex-{turn_id}-{item_id}")),
        "device_id": device_id,
        "workspace_path": workspace_path,
        "file_count": files.len(),
        "additions": additions,
        "deletions": deletions,
        "files": files,
        "reverted_at": Value::Null,
        "revertible": artifact_id.is_some(),
    });
    if let Some(diff) = diff {
        if let Some(object) = summary.as_object_mut() {
            object.insert("diff".to_owned(), Value::String(diff));
        }
    }
    Some(summary)
}

fn file_change_from_codex_change(change: &Value, workspace_path: &str) -> Option<Value> {
    let kind = change.get("kind").cloned().unwrap_or(Value::Null);
    build_file_change(
        &string_field(change, "path")?,
        string_field(&kind, "type").as_deref(),
        string_field(&kind, "movePath")
            .or_else(|| string_field(&kind, "move_path"))
            .as_deref(),
        raw_string_field(change, "diff").as_deref(),
        workspace_path,
    )
}

fn file_change_from_patch_change(
    path: &str,
    change: &Value,
    workspace_path: &str,
) -> Option<Value> {
    let diff = raw_string_field(change, "unified_diff")
        .or_else(|| raw_string_field(change, "diff"))
        .or_else(|| raw_string_field(change, "content"));
    build_file_change(
        path,
        string_field(change, "type").as_deref(),
        string_field(change, "move_path")
            .or_else(|| string_field(change, "movePath"))
            .as_deref(),
        diff.as_deref(),
        workspace_path,
    )
}

fn build_file_change(
    path: &str,
    kind: Option<&str>,
    move_path: Option<&str>,
    diff: Option<&str>,
    workspace_path: &str,
) -> Option<Value> {
    let source_path = workspace_relative_path(path, workspace_path);
    let move_path = move_path.map(|path| workspace_relative_path(path, workspace_path));
    let change_type = match kind.unwrap_or("update").to_ascii_lowercase().as_str() {
        "add" | "create" | "created" => "created",
        "delete" | "deleted" => "deleted",
        "update" if move_path.is_some() => "renamed",
        _ => "modified",
    };
    let (path, old_path) = if change_type == "renamed" {
        (
            move_path.unwrap_or_else(|| source_path.clone()),
            Some(source_path),
        )
    } else {
        (source_path, None)
    };
    let (additions, deletions) = diff_stats(diff.unwrap_or_default(), change_type);
    Some(json!({
        "old_path": old_path,
        "path": path,
        "change_type": change_type,
        "additions": additions,
        "deletions": deletions,
        "binary": false,
    }))
}

fn workspace_relative_path(path: &str, workspace_path: &str) -> String {
    let trimmed_path = path.trim();
    let normalized_path = normalize_workspace_path(trimmed_path);
    let normalized_workspace = normalize_workspace_path(workspace_path);
    if normalized_path.is_empty() || normalized_workspace.is_empty() {
        return trimmed_path.replace('\\', "/");
    }

    let workspace_prefix = normalized_workspace.trim_end_matches(['/', '\\']);
    if normalized_path == workspace_prefix {
        return String::new();
    }
    if let Some(relative_path) = normalized_path.strip_prefix(workspace_prefix) {
        if relative_path.starts_with('/') || relative_path.starts_with('\\') {
            return relative_path
                .trim_start_matches(['/', '\\'])
                .replace('\\', "/");
        }
    }

    trimmed_path.replace('\\', "/")
}

pub(super) fn diff_stats(diff: &str, change_type: &str) -> (i64, i64) {
    if looks_like_unified_diff(diff, change_type) {
        return prefixed_diff_stats(diff);
    }

    let line_count = diff.lines().count() as i64;
    match change_type {
        "created" => (line_count, 0),
        "deleted" => (0, line_count),
        _ => prefixed_diff_stats(diff),
    }
}

fn looks_like_unified_diff(diff: &str, change_type: &str) -> bool {
    diff.lines().any(|line| {
        line.starts_with("@@ ")
            || line.starts_with("diff --git ")
            || (change_type != "created" && (line.starts_with("+++ ") || line.starts_with("--- ")))
    })
}

fn prefixed_diff_stats(diff: &str) -> (i64, i64) {
    let additions = diff
        .lines()
        .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
        .count() as i64;
    let deletions = diff
        .lines()
        .filter(|line| line.starts_with('-') && !line.starts_with("---"))
        .count() as i64;
    (additions, deletions)
}

fn combined_diff_from_codex_changes(value: &Value, workspace_path: &str) -> Option<String> {
    join_change_diffs(
        value
            .get("changes")?
            .as_array()?
            .iter()
            .filter_map(|change| {
                let path = string_field(change, "path")?;
                let kind = change.get("kind");
                let move_path = kind.and_then(|kind| {
                    string_field(kind, "movePath").or_else(|| string_field(kind, "move_path"))
                });
                let kind_type = kind.and_then(|kind| string_field(kind, "type"));
                render_change_diff(
                    &path,
                    move_path.as_deref(),
                    kind_type.as_deref(),
                    raw_string_field(change, "diff").as_deref(),
                    workspace_path,
                )
            }),
    )
}

fn combined_diff_from_patch_apply_end(item: &Value, workspace_path: &str) -> Option<String> {
    join_change_diffs(
        item.get("changes")?
            .as_object()?
            .iter()
            .filter_map(|(path, change)| {
                let move_path =
                    string_field(change, "move_path").or_else(|| string_field(change, "movePath"));
                let kind_type = string_field(change, "type");
                let diff = raw_string_field(change, "unified_diff")
                    .or_else(|| raw_string_field(change, "diff"))
                    .or_else(|| raw_string_field(change, "content"));
                render_change_diff(
                    path,
                    move_path.as_deref(),
                    kind_type.as_deref(),
                    diff.as_deref(),
                    workspace_path,
                )
            }),
    )
}

fn render_change_diff(
    path: &str,
    move_path: Option<&str>,
    kind: Option<&str>,
    diff: Option<&str>,
    workspace_path: &str,
) -> Option<String> {
    let diff = diff?;
    Some(match move_path {
        Some(move_path) => diff_with_file_header(move_path, Some(path), kind, diff, workspace_path),
        None => diff_with_file_header(path, None, kind, diff, workspace_path),
    })
}

fn join_change_diffs(diffs: impl Iterator<Item = String>) -> Option<String> {
    let diff = diffs.collect::<Vec<_>>().join("\n");
    (!diff.is_empty()).then_some(diff)
}

pub(super) fn patch_updated_item(params: &Value) -> Value {
    json!({
        "id": patch_updated_item_id(params),
        "type": "fileChange",
    })
}

pub(super) fn patch_updated_item_id(params: &Value) -> String {
    string_field(params, "itemId")
        .or_else(|| string_field(params, "item_id"))
        .unwrap_or_else(|| item_id(params, "file-change"))
}

fn diff_with_file_header(
    path: &str,
    old_path: Option<&str>,
    kind: Option<&str>,
    diff: &str,
    workspace_path: &str,
) -> String {
    if diff.trim_start().starts_with("diff --git ") {
        return diff.to_owned();
    }

    let relative_path = workspace_relative_path(path, workspace_path);
    if relative_path.is_empty() {
        return diff.to_owned();
    }

    let relative_old_path = old_path
        .map(|path| workspace_relative_path(path, workspace_path))
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| relative_path.clone());
    let kind = kind.unwrap_or("update").to_ascii_lowercase();
    let old_file = if matches!(kind.as_str(), "add" | "create" | "created") {
        "/dev/null".to_owned()
    } else {
        diff_git_path("a", &relative_old_path)
    };
    let new_file = if matches!(kind.as_str(), "delete" | "deleted") {
        "/dev/null".to_owned()
    } else {
        diff_git_path("b", &relative_path)
    };
    let file_markers = if diff
        .lines()
        .any(|line| line.starts_with("--- ") || line.starts_with("+++ "))
    {
        String::new()
    } else {
        format!("--- {old_file}\n+++ {new_file}\n")
    };
    format!(
        "diff --git {} {}\n{}{}\n",
        diff_git_path("a", &relative_old_path),
        diff_git_path("b", &relative_path),
        file_markers,
        diff.trim_end()
    )
}

fn diff_git_path(prefix: &str, path: &str) -> String {
    let path = format!("{prefix}/{}", path.replace('\\', "/"));
    if path.chars().any(char::is_whitespace) {
        format!("\"{path}\"")
    } else {
        path
    }
}
