// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

const STATE_DB_FILENAME: &str = "state_5.sqlite";
const DEFAULT_CODEX_SESSION_LIMIT: usize = 100;

pub(crate) fn resolve_codex_state_db_path() -> Option<PathBuf> {
    if let Ok(path) = env::var("WEGENT_CODEX_STATE_DB") {
        return Some(PathBuf::from(path));
    }

    if let Ok(sqlite_home) = env::var("CODEX_SQLITE_HOME") {
        return Some(PathBuf::from(sqlite_home).join(STATE_DB_FILENAME));
    }

    let codex_home = env::var("CODEX_HOME")
        .map(PathBuf::from)
        .ok()
        .or_else(default_codex_home)?;
    let sqlite_path = codex_home.join("sqlite").join(STATE_DB_FILENAME);
    if sqlite_path.exists() {
        return Some(sqlite_path);
    }
    Some(codex_home.join(STATE_DB_FILENAME))
}

pub(crate) fn list_threads_from_state_db(
    db_path: &Path,
    archived: bool,
) -> Result<Vec<Value>, String> {
    if !db_path.exists() {
        return Ok(Vec::new());
    }

    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|err| {
        format!(
            "failed to open Codex state DB `{}`: {err}",
            db_path.display()
        )
    })?;
    connection
        .busy_timeout(Duration::from_millis(100))
        .map_err(|err| format!("failed to configure Codex state DB timeout: {err}"))?;

    let mut statement = connection
        .prepare(
            r#"
            SELECT
                id,
                rollout_path,
                created_at,
                created_at_ms,
                updated_at,
                updated_at_ms,
                cwd,
                title,
                preview,
                source,
                model_provider,
                cli_version,
                git_sha,
                git_branch,
                git_origin_url,
                agent_nickname,
                agent_role,
                thread_source
            FROM threads
            WHERE archived = ?1
              AND preview <> ''
            ORDER BY updated_at_ms DESC, id DESC
            LIMIT ?2
            "#,
        )
        .map_err(|err| format!("failed to prepare Codex state DB list query: {err}"))?;

    let rows = statement
        .query_map(
            (
                if archived { 1_i64 } else { 0_i64 },
                DEFAULT_CODEX_SESSION_LIMIT as i64,
            ),
            |row| {
                let id: String = row.get(0)?;
                let path: String = row.get(1)?;
                let created_at: i64 = row.get(2)?;
                let created_at_ms: Option<i64> = row.get(3)?;
                let updated_at: i64 = row.get(4)?;
                let updated_at_ms: Option<i64> = row.get(5)?;
                let cwd: String = row.get(6)?;
                let title: String = row.get(7)?;
                let preview: String = row.get(8)?;
                let source: String = row.get(9)?;
                let model_provider: String = row.get(10)?;
                let cli_version: String = row.get(11)?;
                let git_sha: Option<String> = row.get(12)?;
                let git_branch: Option<String> = row.get(13)?;
                let git_origin_url: Option<String> = row.get(14)?;
                let agent_nickname: Option<String> = row.get(15)?;
                let agent_role: Option<String> = row.get(16)?;
                let thread_source: Option<String> = row.get(17)?;

                Ok(thread_json(CodexThreadRow {
                    id,
                    path,
                    created_at,
                    created_at_ms,
                    updated_at,
                    updated_at_ms,
                    cwd,
                    title,
                    preview,
                    source,
                    model_provider,
                    cli_version,
                    git_sha,
                    git_branch,
                    git_origin_url,
                    agent_nickname,
                    agent_role,
                    thread_source,
                    archived,
                }))
            },
        )
        .map_err(|err| format!("failed to query Codex state DB threads: {err}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read Codex state DB thread row: {err}"))
}

#[derive(Debug)]
struct CodexThreadRow {
    id: String,
    path: String,
    created_at: i64,
    created_at_ms: Option<i64>,
    updated_at: i64,
    updated_at_ms: Option<i64>,
    cwd: String,
    title: String,
    preview: String,
    source: String,
    model_provider: String,
    cli_version: String,
    git_sha: Option<String>,
    git_branch: Option<String>,
    git_origin_url: Option<String>,
    agent_nickname: Option<String>,
    agent_role: Option<String>,
    thread_source: Option<String>,
    archived: bool,
}

fn thread_json(row: CodexThreadRow) -> Value {
    json!({
        "id": row.id,
        "sessionId": row.id,
        "forkedFromId": Value::Null,
        "parentThreadId": Value::Null,
        "preview": row.preview,
        "ephemeral": false,
        "modelProvider": row.model_provider,
        "createdAt": row.created_at_ms.unwrap_or_else(|| row.created_at.saturating_mul(1000)),
        "updatedAt": row.updated_at_ms.unwrap_or_else(|| row.updated_at.saturating_mul(1000)),
        "recencyAt": row.updated_at_ms.unwrap_or_else(|| row.updated_at.saturating_mul(1000)),
        "status": if row.archived { "archived" } else { "idle" },
        "path": row.path,
        "cwd": row.cwd,
        "cliVersion": row.cli_version,
        "source": row.source,
        "threadSource": row.thread_source,
        "agentNickname": row.agent_nickname,
        "agentRole": row.agent_role,
        "gitInfo": git_info(row.git_sha, row.git_branch, row.git_origin_url),
        "name": non_empty_string(row.title),
        "turns": [],
    })
}

fn git_info(sha: Option<String>, branch: Option<String>, origin_url: Option<String>) -> Value {
    if sha.is_none() && branch.is_none() && origin_url.is_none() {
        return Value::Null;
    }
    json!({
        "commitHash": sha,
        "branch": branch,
        "repositoryUrl": origin_url,
    })
}

fn non_empty_string(value: String) -> Value {
    if value.trim().is_empty() {
        Value::Null
    } else {
        Value::String(value)
    }
}

fn default_codex_home() -> Option<PathBuf> {
    env::var("HOME")
        .ok()
        .filter(|home| !home.is_empty())
        .map(|home| PathBuf::from(home).join(".codex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_json_uses_ms_timestamps_and_title() {
        let row = CodexThreadRow {
            id: "thread-1".to_owned(),
            path: "/tmp/thread.jsonl".to_owned(),
            created_at: 100,
            created_at_ms: Some(100_500),
            updated_at: 200,
            updated_at_ms: Some(200_500),
            cwd: "/tmp/project".to_owned(),
            title: "Fix CI".to_owned(),
            preview: "please fix ci".to_owned(),
            source: "vscode".to_owned(),
            model_provider: "openai".to_owned(),
            cli_version: "1.0.0".to_owned(),
            git_sha: Some("abc".to_owned()),
            git_branch: Some("main".to_owned()),
            git_origin_url: None,
            agent_nickname: None,
            agent_role: None,
            thread_source: None,
            archived: false,
        };

        let thread = thread_json(row);

        assert_eq!(thread["id"], "thread-1");
        assert_eq!(thread["name"], "Fix CI");
        assert_eq!(thread["createdAt"], 100_500);
        assert_eq!(thread["updatedAt"], 200_500);
        assert_eq!(thread["status"], "idle");
        assert_eq!(thread["gitInfo"]["commitHash"], "abc");
    }
}
