// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    agent_session,
    protocol::{AgentKind, ExecutionRequest},
};

/// Import only the task's remembered native conversation, never a global Home
/// or its authentication/database. The caller holds the target Home lease.
pub(super) fn migrate(
    request: &ExecutionRequest,
    target: &Path,
    root: &Path,
) -> Result<Option<Value>, String> {
    if request.new_session {
        return Ok(None);
    }
    let (source, kind) = match request.resolved_agent_kind() {
        AgentKind::CodeX => (Some(crate::agents::wework_codex_home()), AgentKind::CodeX),
        AgentKind::ClaudeCode => (
            std::env::var_os("WEGENT_CLAUDE_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".claude"))),
            AgentKind::ClaudeCode,
        ),
        _ => return Ok(None),
    };
    let Some(id) = selected_session_id(request)? else {
        return Ok(None);
    };
    let directory = if kind == AgentKind::CodeX {
        "sessions"
    } else {
        "projects"
    };
    let mut existing = Vec::new();
    find_session(&target.join(directory), &id, &kind, &mut existing, 0)?;
    if let [path] = existing.as_slice() {
        validate_session(path, &id, &kind)?;
        return Ok(Some(
            json!({"id": id, "path": path.strip_prefix(target).map_err(|e| e.to_string())?}),
        ));
    }
    if !existing.is_empty() {
        return Err("Native session is ambiguous in agent Home".to_owned());
    }
    let legacy = super::verified_legacy_home(root, request)?;
    let source = legacy
        .as_ref()
        .map(|(path, _)| path.clone())
        .or(source)
        .ok_or(
        "Existing Claude session requires its explicitly managed WEGENT_CLAUDE_HOME for migration",
    )?;
    migrate_at(&source, target, kind, &id).map(Some)
}

fn selected_session_id(request: &ExecutionRequest) -> Result<Option<String>, String> {
    // Do not seed legacy marker files until ownership has been verified.
    let remembered = agent_session::saved_executor_session(request);
    let key = if request.resolved_agent_kind() == AgentKind::CodeX {
        "threadId"
    } else {
        "sessionId"
    };
    let selected = remembered
        .as_ref()
        .and_then(|session| session.get(key))
        .and_then(Value::as_str)
        .or_else(|| {
            request
                .inherited_sessions
                .iter()
                .find_map(|session| inherited_session_id(request, session))
        });
    let Some(id) = selected else {
        return if request.inherited_sessions.is_empty() {
            Ok(None)
        } else {
            Err("Legacy session has no exact Bot ownership proof".to_owned())
        };
    };
    if remembered.is_some() && request.extra.contains_key("legacy_session_bindings") {
        verify_owner(request, id)?;
    } else {
        // Older Backends resume the executor's task/Bot-scoped marker without
        // the newer proof field. Explicit inheritance retains its own checks.
        super::request_identity(request)?;
    }
    Ok(Some(id.to_owned()))
}

fn inherited_session_id<'a>(request: &ExecutionRequest, session: &'a Value) -> Option<&'a str> {
    let bot = request
        .bot
        .as_array()
        .and_then(|bots| bots.first())
        .unwrap_or(&request.bot);
    let bot_id = bot.get("id").and_then(super::positive_id)?;
    let session_bot_id = session
        .get("botId")
        .or_else(|| session.get("bot_id"))
        .and_then(super::positive_id)?;
    if bot_id != session_bot_id {
        return None;
    }
    let agent = session
        .get("agent")?
        .as_str()?
        .replace(' ', "")
        .to_ascii_lowercase();
    let (expected, key, alias) = match request.resolved_agent_kind() {
        AgentKind::CodeX => ("codex", "threadId", "thread_id"),
        AgentKind::ClaudeCode => ("claudecode", "sessionId", "session_id"),
        _ => return None,
    };
    if agent != expected {
        return None;
    }
    session
        .get(key)
        .or_else(|| session.get(alias))
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
}

fn verify_owner(request: &ExecutionRequest, id: &str) -> Result<(), String> {
    super::request_identity(request)?;
    let user_id = super::request_user_id(request).ok_or("Agent user identity is missing")?;
    // These are owner-filtered records for this task, not fork inheritance.
    let proven = request
        .extra
        .get("legacy_session_bindings")
        .and_then(Value::as_array)
        .is_some_and(|bindings| {
            bindings.iter().any(|session| {
                let task = session.get("task_id").and_then(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| value.as_u64().map(|id| id.to_string()))
                });
                task.as_deref() == Some(request.task_id.as_str())
                    && session
                        .get("user_id")
                        .and_then(super::positive_id)
                        .as_deref()
                        == Some(user_id.as_str())
                    && inherited_session_id(request, session) == Some(id)
            })
        });
    if !proven {
        return Err("Legacy session has no matching authenticated task ownership proof".to_owned());
    }
    Ok(())
}

fn migrate_at(source: &Path, target: &Path, kind: AgentKind, id: &str) -> Result<Value, String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid native session identity for migration".to_owned());
    }
    let directory = match kind {
        AgentKind::CodeX => "sessions",
        AgentKind::ClaudeCode => "projects",
        _ => return Err("Unsupported native session engine".to_owned()),
    };
    let root = source.join(directory);
    let mut matches = Vec::new();
    find_session(&root, id, &kind, &mut matches, 0)?;
    let [session] = matches.as_slice() else {
        return Err(
            "Existing task session is missing or ambiguous; refusing to start a new conversation"
                .to_owned(),
        );
    };
    let companions = session.with_extension("");
    let before = session_snapshot(session, &companions, &kind)?;
    let relative = session
        .strip_prefix(source)
        .map_err(|error| error.to_string())?;
    let staging = tempfile::tempdir_in(target).map_err(|error| error.to_string())?;
    let destination = staging.path().join(relative);
    copy_private_file(session, &destination)?;
    if kind == AgentKind::ClaudeCode && companions.exists() {
        copy_private_tree(&companions, &destination.with_extension(""), 0)?;
    }
    validate_session(&destination, id, &kind)?;
    // Validate the complete copy, not just the first identity record. Recheck
    // source membership and metadata after copying and hashing all bytes.
    for (path, metadata) in &before {
        if metadata.is_file() {
            let copied = staging.path().join(
                path.strip_prefix(source)
                    .map_err(|error| error.to_string())?,
            );
            if file_digest(path)? != file_digest(&copied)? {
                return Err("Native session changed during migration".to_owned());
            }
        }
    }
    let after = session_snapshot(session, &companions, &kind)?;
    if before.len() != after.len()
        || before
            .iter()
            .zip(&after)
            .any(|((path, metadata), (after_path, after_metadata))| {
                path != after_path || !same_metadata(metadata, after_metadata)
            })
    {
        return Err("Native session changed during migration".to_owned());
    }
    let published = target.join(directory);
    if published.exists() {
        // Recovery after the directory rename but before agent.json publication.
        verify_existing_tree(&staging.path().join(directory), &published, 0)?;
    } else {
        fs::rename(staging.path().join(directory), &published)
            .map_err(|error| error.to_string())?;
    }
    Ok(json!({"id":id, "path":relative, "engine":format!("{kind:?}")}))
}

fn session_snapshot(
    session: &Path,
    companions: &Path,
    kind: &AgentKind,
) -> Result<Vec<(PathBuf, fs::Metadata)>, String> {
    let mut snapshot = Vec::new();
    collect_snapshot(session, &mut snapshot, 0)?;
    if *kind == AgentKind::ClaudeCode {
        match fs::symlink_metadata(companions) {
            Ok(_) => collect_snapshot(companions, &mut snapshot, 0)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    snapshot.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(snapshot)
}

fn collect_snapshot(
    path: &Path,
    snapshot: &mut Vec<(PathBuf, fs::Metadata)>,
    depth: usize,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if depth > 6 || snapshot.len() >= 4096 || (!metadata.is_file() && !metadata.is_dir()) {
        return Err("Invalid or oversized native session tree".to_owned());
    }
    let directory = metadata.is_dir();
    snapshot.push((path.to_owned(), metadata));
    if directory {
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            collect_snapshot(
                &entry.map_err(|error| error.to_string())?.path(),
                snapshot,
                depth + 1,
            )?;
        }
    }
    Ok(())
}

fn same_metadata(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    if before.len() != after.len()
        || before.is_dir() != after.is_dir()
        || before.modified().ok() != after.modified().ok()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return false;
        }
    }
    true
}

fn file_digest(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > 128 * 1024 * 1024 {
            return Err("Native session exceeds migration size limit".to_owned());
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest.finalize().to_vec())
}

fn verify_existing_tree(staged: &Path, existing: &Path, depth: usize) -> Result<(), String> {
    let mut staged_files = Vec::new();
    let mut existing_files = Vec::new();
    collect_snapshot(staged, &mut staged_files, depth)?;
    collect_snapshot(existing, &mut existing_files, depth)?;
    staged_files.sort_by(|a, b| a.0.cmp(&b.0));
    existing_files.sort_by(|a, b| a.0.cmp(&b.0));
    if staged_files.len() != existing_files.len() {
        return Err("Existing native session import conflicts with source".to_owned());
    }
    for ((left, lm), (right, rm)) in staged_files.iter().zip(&existing_files) {
        if left.strip_prefix(staged).ok() != right.strip_prefix(existing).ok()
            || lm.is_dir() != rm.is_dir()
            || (lm.is_file() && file_digest(left)? != file_digest(right)?)
        {
            return Err("Existing native session import conflicts with source".to_owned());
        }
    }
    Ok(())
}

fn find_session(
    root: &Path,
    id: &str,
    kind: &AgentKind,
    found: &mut Vec<PathBuf>,
    depth: usize,
) -> Result<(), String> {
    if depth > 6 {
        return Err("Native session tree exceeds supported depth".to_owned());
    }
    match fs::symlink_metadata(root) {
        Ok(metadata) if !metadata.is_dir() => return Err("Invalid native session root".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        _ => {}
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Read legacy native sessions: {error}")),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind_on_disk = entry.file_type().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let selected = match kind {
            AgentKind::CodeX => {
                name.starts_with("rollout-") && name.ends_with(&format!("-{id}.jsonl"))
            }
            AgentKind::ClaudeCode => name == format!("{id}.jsonl"),
            _ => false,
        };
        if selected {
            if !kind_on_disk.is_file() {
                return Err("Native session is not a regular file".to_owned());
            }
            found.push(entry.path());
        } else if kind_on_disk.is_dir() && (*kind == AgentKind::CodeX || depth == 0) {
            find_session(&entry.path(), id, kind, found, depth + 1)?;
        }
    }
    Ok(())
}

pub(crate) fn validate_session(path: &Path, id: &str, kind: &AgentKind) -> Result<(), String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() > 128 * 1024 * 1024 {
        return Err("Native session exceeds migration size limit".to_owned());
    }
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut matched = false;
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|error| error.to_string())?
            == 0
        {
            break;
        }
        if !line.ends_with('\n') {
            return Err("Incomplete native session record".to_owned());
        }
        let value: Value =
            serde_json::from_str(&line).map_err(|_| "Invalid native session record".to_owned())?;
        let candidate = match kind {
            AgentKind::CodeX
                if value.get("type").and_then(Value::as_str) == Some("session_meta") =>
            {
                value.pointer("/payload/id")
            }
            AgentKind::ClaudeCode => value.get("sessionId"),
            _ => None,
        };
        if let Some(candidate) = candidate.and_then(Value::as_str) {
            if candidate != id {
                return Err("Native session identity does not match the task".to_owned());
            }
            matched = true;
        }
    }
    if matched {
        Ok(())
    } else {
        Err("Native session has no matching identity record".to_owned())
    }
}

fn copy_private_file(source: &Path, target: &Path) -> Result<(), String> {
    let before = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if !before.is_file() || before.len() > 128 * 1024 * 1024 {
        return Err("Refusing to migrate non-regular native session data".to_owned());
    }
    let parent = target.parent().ok_or("Session destination has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut input = fs::File::open(source).map_err(|error| error.to_string())?;
    if !same_metadata(
        &before,
        &input.metadata().map_err(|error| error.to_string())?,
    ) {
        return Err("Native session changed before migration".to_owned());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    let count = std::io::copy(&mut (&mut input).take(before.len() + 1), &mut temporary)
        .map_err(|error| error.to_string())?;
    if count != before.len()
        || !same_metadata(
            &before,
            &input.metadata().map_err(|error| error.to_string())?,
        )
        || !same_metadata(
            &before,
            &fs::symlink_metadata(source).map_err(|error| error.to_string())?,
        )
    {
        return Err("Native session changed during copy".to_owned());
    }
    temporary.flush().map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary
        .persist(target)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn copy_private_tree(source: &Path, target: &Path, depth: usize) -> Result<(), String> {
    if depth > 6
        || !fs::symlink_metadata(source)
            .map_err(|error| error.to_string())?
            .is_dir()
    {
        return Err("Invalid native session companion directory".to_owned());
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let destination = target.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            copy_private_tree(&entry.path(), &destination, depth + 1)?;
        } else {
            copy_private_file(&entry.path(), &destination)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_proof_requires_exact_server_selected_bot_engine_and_session() {
        let mut request: ExecutionRequest = serde_json::from_value(json!({
            "task_id":"task-1", "backend_url":"https://backend.example", "user_id":7, "user_name":"user7",
            "team_name":"design", "team_namespace":"default", "team_owner":{"kind":"user","id":7,"name":"user7"},
            "team_id":12, "bot":[{"id":23,"shell_type":"Codex"}]
        }))
        .unwrap();
        assert!(verify_owner(&request, "session-1").is_err());
        let proof = json!({"task_id":"task-1", "user_id":7, "agent":"Codex", "botId":23, "threadId":"session-1"});
        request
            .extra
            .insert("legacy_session_bindings".to_owned(), json!([proof]));
        verify_owner(&request, "session-1").unwrap();
        for (key, value) in [
            ("botId", json!(null)),
            ("botId", json!(24)),
            ("agent", json!("ClaudeCode")),
            ("threadId", json!("other-session")),
            ("task_id", json!("other-task")),
            ("user_id", json!(8)),
        ] {
            let mut wrong = proof.clone();
            wrong[key] = value;
            request
                .extra
                .insert("legacy_session_bindings".to_owned(), json!([wrong]));
            assert!(verify_owner(&request, "session-1").is_err());
        }
        request
            .extra
            .insert("legacy_session_bindings".to_owned(), json!([proof]));
        request.extra.remove("user_id");
        assert!(verify_owner(&request, "session-1").is_err());
    }

    #[test]
    fn invalid_tail_is_rejected_without_publishing_and_complete_copy_is_retryable() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let path = source.path().join("sessions/rollout-date-session-1.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let header = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session-1\"}}\n";
        for tail in [
            "{",
            "{}",
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"other\"}}\n",
        ] {
            fs::write(&path, format!("{header}{tail}")).unwrap();
            assert!(
                migrate_at(source.path(), target.path(), AgentKind::CodeX, "session-1").is_err()
            );
            assert!(!target.path().join("sessions").exists());
        }
        fs::write(&path, header).unwrap();
        migrate_at(source.path(), target.path(), AgentKind::CodeX, "session-1").unwrap();
        migrate_at(source.path(), target.path(), AgentKind::CodeX, "session-1").unwrap();
        fs::write(&path, format!("{header}{{}}\n")).unwrap();
        assert!(migrate_at(source.path(), target.path(), AgentKind::CodeX, "session-1").is_err());
        assert_eq!(
            fs::read_to_string(target.path().join("sessions/rollout-date-session-1.jsonl"))
                .unwrap(),
            header
        );
    }

    #[test]
    fn existing_bot_session_import_preserves_identity_without_copying_other_history_or_auth() {
        for (kind, relative, record) in [
            (
                AgentKind::CodeX,
                "sessions/2026/09/20/rollout-date-session-1.jsonl",
                json!({"type":"session_meta","payload":{"id":"session-1"}}),
            ),
            (
                AgentKind::ClaudeCode,
                "projects/-workspace-task/session-1.jsonl",
                json!({"sessionId":"session-1","type":"user"}),
            ),
        ] {
            let source = tempfile::tempdir().unwrap();
            let target = tempfile::tempdir().unwrap();
            let session = source.path().join(relative);
            fs::create_dir_all(session.parent().unwrap()).unwrap();
            fs::write(&session, format!("{record}\n")).unwrap();
            fs::write(source.path().join("auth.json"), "private").unwrap();
            let result =
                migrate_at(source.path(), target.path(), kind.clone(), "session-1").unwrap();
            assert_eq!(result["id"], "session-1");
            assert_eq!(
                fs::read(&session).unwrap(),
                fs::read(target.path().join(relative)).unwrap()
            );
            assert!(!target.path().join("auth.json").exists());
            assert!(
                migrate_at(source.path(), target.path(), kind.clone(), "missing")
                    .unwrap_err()
                    .contains("refusing")
            );
            fs::write(&session, "{\"sessionId\":\"wrong\",\"type\":\"session_meta\",\"payload\":{\"id\":\"wrong\"}}\n").unwrap();
            assert!(migrate_at(source.path(), target.path(), kind, "session-1").is_err());
        }
    }
}
