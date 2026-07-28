// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::logging::log_executor_event;

const CODEX_LOG_DB_FILE_NAME: &str = "logs_2.sqlite";
const WEWORK_LOG_LEVEL_TRIGGER: &str = "wework_codex_log_level_filter";
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CodexLogDbMode {
    Trace,
    Warn,
}

impl CodexLogDbMode {
    fn current() -> Self {
        if cfg!(debug_assertions) {
            Self::Trace
        } else {
            Self::Warn
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Warn => "warn",
        }
    }
}

pub(super) async fn configure_codex_log_db_filter(codex_home: PathBuf) {
    let mode = CodexLogDbMode::current();
    let database_path = codex_home.join(CODEX_LOG_DB_FILE_NAME);
    let path_for_log = database_path.display().to_string();
    let result = tokio::task::spawn_blocking(move || apply_filter(&database_path, mode)).await;
    match result {
        Ok(Ok(())) => log_executor_event(
            "codex log database filter configured",
            &[("level", mode.as_str().to_owned()), ("path", path_for_log)],
        ),
        Ok(Err(error)) => log_executor_event(
            "codex log database filter failed",
            &[
                ("level", mode.as_str().to_owned()),
                ("path", path_for_log),
                ("error", error),
            ],
        ),
        Err(error) => log_executor_event(
            "codex log database filter task failed",
            &[
                ("level", mode.as_str().to_owned()),
                ("path", path_for_log),
                ("error", error.to_string()),
            ],
        ),
    }
}

fn apply_filter(database_path: &Path, mode: CodexLogDbMode) -> Result<(), String> {
    let connection = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| format!("failed to open Codex log database: {error}"))?;
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|error| format!("failed to set Codex log database busy timeout: {error}"))?;
    let statement = match mode {
        CodexLogDbMode::Trace => "DROP TRIGGER IF EXISTS wework_codex_log_level_filter;",
        CodexLogDbMode::Warn => {
            r#"
DROP TRIGGER IF EXISTS wework_codex_log_level_filter;
CREATE TRIGGER wework_codex_log_level_filter
BEFORE INSERT ON logs
WHEN NEW.level NOT IN ('WARN', 'ERROR')
BEGIN
    SELECT RAISE(IGNORE);
END;
"#
        }
    };
    connection
        .execute_batch(statement)
        .map_err(|error| format!("failed to update {WEWORK_LOG_LEVEL_TRIGGER}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_database() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join(CODEX_LOG_DB_FILE_NAME);
        let connection = Connection::open(&path).expect("test database should open");
        connection
            .execute("CREATE TABLE logs (level TEXT NOT NULL)", [])
            .expect("logs table should be created");
        (directory, path)
    }

    fn insert_levels(path: &Path) -> Vec<String> {
        let connection = Connection::open(path).expect("test database should open");
        connection
            .execute(
                "INSERT INTO logs (level) VALUES ('TRACE'), ('DEBUG'), ('INFO'), ('WARN'), ('ERROR')",
                [],
            )
            .expect("log levels should be inserted");
        let mut statement = connection
            .prepare("SELECT level FROM logs ORDER BY rowid")
            .expect("log query should prepare");
        statement
            .query_map([], |row| row.get(0))
            .expect("log query should execute")
            .collect::<rusqlite::Result<Vec<String>>>()
            .expect("log levels should be read")
    }

    #[test]
    fn warn_mode_persists_only_warn_and_error_rows() {
        let (_directory, path) = test_database();

        apply_filter(&path, CodexLogDbMode::Warn).expect("warn filter should apply");

        assert_eq!(insert_levels(&path), vec!["WARN", "ERROR"]);
    }

    #[test]
    fn trace_mode_removes_release_filter() {
        let (_directory, path) = test_database();
        apply_filter(&path, CodexLogDbMode::Warn).expect("warn filter should apply");

        apply_filter(&path, CodexLogDbMode::Trace).expect("trace filter should apply");

        assert_eq!(
            insert_levels(&path),
            vec!["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]
        );
    }
}
