// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::parser::Parser;
use crate::hooks::model::{HookEventName, HookUser, PostToolUseInput};

/// Identity a routed Codex thread was registered with.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct SessionContext {
    pub user: HookUser,
    pub cwd: PathBuf,
    pub model: Option<String>,
    #[serde(default)]
    pub git_url: Option<String>,
    /// Registration time; edits recorded earlier were never meant to be reported.
    pub since: i64,
}

/// A Codex thread resolved to the task (root) thread it belongs to.
#[derive(Clone)]
pub(super) struct ThreadRow {
    /// The rollout's own thread id; differs from `root` for subagents.
    pub id: String,
    pub root: String,
    pub context: SessionContext,
}

pub(super) struct Store {
    db: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        fs::create_dir_all(path.parent().ok_or("rollout database has no parent")?)
            .map_err(error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let file = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(path)
                .map_err(error)?;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(error)?;
        }
        let db = Connection::open(path).map_err(error)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(error)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS threads (
                id TEXT PRIMARY KEY, root TEXT NOT NULL, context TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS cursors (
                path TEXT PRIMARY KEY, offset INTEGER NOT NULL, parser TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY,
                edit_key TEXT NOT NULL UNIQUE,
                session TEXT NOT NULL,
                call_id TEXT NOT NULL,
                path TEXT NOT NULL,
                input TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt INTEGER NOT NULL DEFAULT 0);",
        )
        .map_err(error)?;
        Ok(Self { db })
    }

    pub fn register_root(&self, id: &str, context: &SessionContext) -> Result<(), String> {
        self.insert_thread(id, id, context)
    }

    /// Binds a subagent thread to the root thread of its parent. Returns false
    /// when the parent is unknown yet, so the caller can retry on a later scan.
    pub fn bind_child(&self, child: &str, parent: &str) -> Result<bool, String> {
        let parent_row = self.thread(parent)?;
        let Some(parent_row) = parent_row else {
            return Ok(false);
        };
        self.insert_thread(child, &parent_row.root, &parent_row.context)?;
        Ok(true)
    }

    pub fn thread(&self, id: &str) -> Result<Option<ThreadRow>, String> {
        let row: Option<(String, String, String)> = self
            .db
            .query_row(
                "SELECT id,root,context FROM threads WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(error)?;
        row.map(|(id, root, context)| {
            Ok(ThreadRow {
                id,
                root,
                context: serde_json::from_str(&context).map_err(error)?,
            })
        })
        .transpose()
    }

    /// Fills in rollout-derived facts the routed request cannot know.
    pub fn enrich_thread(
        &self,
        id: &str,
        cwd: Option<&str>,
        git_url: Option<&str>,
    ) -> Result<(), String> {
        let Some(mut thread) = self.thread(id)? else {
            return Ok(());
        };
        if thread.context.git_url.is_none() {
            thread.context.git_url = git_url.map(ToOwned::to_owned);
        }
        if let Some(cwd) = cwd.filter(|cwd| !cwd.trim().is_empty()) {
            thread.context.cwd = PathBuf::from(cwd);
        }
        self.db
            .execute(
                "UPDATE threads SET context=?2 WHERE id=?1",
                params![id, serde_json::to_string(&thread.context).map_err(error)?],
            )
            .map_err(error)?;
        Ok(())
    }

    pub fn cursor(&self, path: &Path) -> Result<Option<(u64, Parser)>, String> {
        let row: Option<(u64, String)> = self
            .db
            .query_row(
                "SELECT offset,parser FROM cursors WHERE path=?1",
                [path.to_string_lossy().as_ref()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        row.map(|(offset, parser)| Ok((offset, serde_json::from_str(&parser).map_err(error)?)))
            .transpose()
    }

    pub fn set_cursor(&self, path: &Path, offset: u64, parser: &Parser) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO cursors VALUES (?1,?2,?3)",
                params![
                    path.to_string_lossy(),
                    offset,
                    serde_json::to_string(parser).map_err(error)?
                ],
            )
            .map_err(error)?;
        Ok(())
    }

    /// Consumes one rollout record: the cursor and every report it produces
    /// commit together, so a crash can never advance past an unqueued change.
    pub fn consume(
        &mut self,
        path: &Path,
        offset: u64,
        thread: &ThreadRow,
        parser: &mut Parser,
        record: &Value,
        enabled: bool,
    ) -> Result<usize, String> {
        let edit = parser.consume(record);
        let transaction = self.db.transaction().map_err(error)?;
        let mut queued = 0;
        // A change whose timestamp cannot be read is dropped, never an error:
        // the record still commits its cursor below so one bad record cannot
        // block every later edit in the same rollout.
        let timestamp = rollout_timestamp(record);
        if timestamp.is_none() && edit.is_some() {
            eprintln!("codex rollout record skipped: file change has no usable timestamp");
        }
        if let (Some(edit), Some(timestamp)) = (edit, timestamp) {
            for change in edit.changes {
                let cwd = parser
                    .cwd
                    .as_ref()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| thread.context.cwd.clone());
                let filepath = absolutize(&cwd, &change.path);
                let subagent = thread.id != thread.root;
                let input = (enabled && timestamp >= thread.context.since)
                    .then(|| {
                        let input = PostToolUseInput {
                            user: thread.context.user.clone(),
                            session_id: thread.root.clone(),
                            turn_id: parser.turn_id.clone(),
                            agent_id: subagent.then(|| thread.id.clone()),
                            agent_type: subagent.then(|| "subagent".to_owned()),
                            transcript_path: Some(path.to_string_lossy().into_owned()),
                            cwd: cwd.clone(),
                            hook_event_name: HookEventName::PostToolUse,
                            model: parser
                                .model
                                .clone()
                                .or_else(|| thread.context.model.clone()),
                            permission_mode: "workspace-write".to_owned(),
                            tool_name: "apply_patch".to_owned(),
                            tool_use_id: edit.call_id.clone(),
                            // The rollout records the repository the edit
                            // happened in, so a queued report can still name it
                            // after the workspace is gone.
                            tool_input: json!({
                                "changes": [change.json(&filepath)],
                                "git_url": thread.context.git_url,
                            }),
                            tool_response: json!({"status": "completed"}),
                        };
                        serde_json::to_string(&input).map_err(error)
                    })
                    .transpose()?;
                let queued_row = input.is_some();
                let inserted = transaction
                    .execute(
                        "INSERT OR IGNORE INTO reports (edit_key,session,call_id,path,input)
                         VALUES (?1,?2,?3,?4,?5)",
                        params![
                            edit_key(&edit.call_id, &filepath, &change.diff, timestamp),
                            thread.root,
                            edit.call_id,
                            filepath,
                            input
                        ],
                    )
                    .map_err(error)?;
                if inserted > 0 && queued_row {
                    queued += 1;
                }
            }
        }
        transaction
            .execute(
                "INSERT OR REPLACE INTO cursors VALUES (?1,?2,?3)",
                params![
                    path.to_string_lossy(),
                    offset,
                    serde_json::to_string(parser).map_err(error)?
                ],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)?;
        Ok(queued)
    }

    pub fn next(&self, now: i64) -> Result<Option<(i64, PostToolUseInput)>, String> {
        let row: Option<(i64, String)> = self
            .db
            .query_row(
                "SELECT id,input FROM reports
                 WHERE input IS NOT NULL AND next_attempt<=?1 ORDER BY id LIMIT 1",
                [now],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        row.map(|(id, input)| Ok((id, serde_json::from_str(&input).map_err(error)?)))
            .transpose()
    }

    pub fn complete(&self, id: i64) -> Result<(), String> {
        // Keep only the dedup key once acknowledged, not the source code.
        self.db
            .execute("UPDATE reports SET input=NULL WHERE id=?1", [id])
            .map_err(error)?;
        Ok(())
    }

    pub fn retry(&self, id: i64, now: i64) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE reports SET attempts=attempts+1,
                 next_attempt=?2 + MIN(300000, 1000 * (1 << MIN(attempts, 9))) WHERE id=?1",
                params![id, now],
            )
            .map_err(error)?;
        Ok(())
    }

    fn insert_thread(&self, id: &str, root: &str, context: &SessionContext) -> Result<(), String> {
        self.db
            .execute(
                "INSERT OR IGNORE INTO threads VALUES (?1,?2,?3)",
                params![id, root, serde_json::to_string(context).map_err(error)?],
            )
            .map_err(error)?;
        Ok(())
    }

    /// `(rows, pending)` over the report queue, for tests.
    #[cfg(test)]
    pub fn report_counts(&self) -> Result<(i64, i64), String> {
        self.db
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(input IS NOT NULL), 0) FROM reports",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(error)
    }
}

/// Identity of one edit: the Codex tool call plus the file it touched. Reports
/// are keyed by this pair globally, so the same edit mirrored by another
/// session (parent history replay, subagent mirroring) is stored once, while a
/// later edit of the same file carries a new call id and is reported again.
fn edit_key(call_id: &str, filepath: &str, diff: &str, timestamp_ms: i64) -> String {
    if call_id.trim().is_empty() {
        let seed = format!("{filepath}\u{1}{timestamp_ms}\u{1}{diff}");
        return format!("anon\u{1}{filepath}\u{1}{:016x}", fnv1a(seed.as_bytes()));
    }
    format!("{call_id}\u{1}{filepath}")
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The rollout record timestamps every change; a missing or malformed value
/// makes that one change unreportable instead of failing the whole scan.
fn rollout_timestamp(record: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(record["timestamp"].as_str()?)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn absolutize(cwd: &Path, path: &str) -> String {
    let path = PathBuf::from(path);
    let joined = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    joined.to_string_lossy().into_owned()
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
