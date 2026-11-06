// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for `_recover_executor_if_needed`'s read and its predicates.
use std::time::Duration;

use brz_mysql::{MysqlResult, MysqlRouteKey, MysqlRouteOutput, MysqlRouting};
use serde_json::json;

use super::{has_fork_workspace_archive, read_subtask_with_contexts, shell_supports_recovery};
use crate::chat_repository::contexts_by_subtask_ids_statement;
use crate::sql_test_support::mysql_pool_server;
use crate::task_store::TableTemplates;
use crate::task_store_statements::subtask_by_id_statement;

/// Deployment shard policy for the test: the recorded `{{subtasks}}` template
/// renders the physical table the recording shows.
struct RecordedShard;

impl MysqlRouting for RecordedShard {
    fn resolve<'a>(
        &'a self,
        template: &'a str,
        _key: &'a dyn MysqlRouteKey,
    ) -> MysqlResult<impl MysqlRouteOutput + 'a> {
        Ok(match template {
            "subtasks" => "subtasks_0711".to_string(),
            "tasks" => "tasks_0711".to_string(),
            other => other.to_string(),
        })
    }
}

fn templates() -> TableTemplates {
    TableTemplates {
        tasks: "{{tasks}}",
        subtasks: "{{subtasks}}",
    }
}

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `_recover_executor_if_needed` only re-reads the subtask for the coding
/// shells; every other shell returns before the read.
#[test]
fn only_coding_shells_enter_the_recovery_read() {
    for shell in ["ClaudeCode", "Agno", "CodeX", "Codex"] {
        assert!(shell_supports_recovery(shell), "{shell}");
    }
    for shell in ["Chat", "Dify", ""] {
        assert!(!shell_supports_recovery(shell), "{shell}");
    }
}

/// `_has_fork_workspace_archive` needs a non-blank `storageKey`.
#[test]
fn a_fork_workspace_archive_requires_a_non_blank_storage_key() {
    assert!(has_fork_workspace_archive(Some(
        &json!({"workspaceArchive": {"storageKey": "archive/one"}})
    )));
    assert!(!has_fork_workspace_archive(Some(
        &json!({"workspaceArchive": {"storageKey": "   "}})
    )));
    assert!(!has_fork_workspace_archive(Some(
        &json!({"workspaceArchive": {}})
    )));
    assert!(!has_fork_workspace_archive(Some(&json!({}))));
    assert!(!has_fork_workspace_archive(None));
}

/// The recovery read is `subtask_store.get_by_id`'s ORM projection: every
/// mapped column labeled `{table}_{column}`, `WHERE {table}.id = ? LIMIT 1`,
/// rendered against the subtask's shard. It is the same pair the RUNNING
/// transition issues later, which is why the recorded create flow has two
/// identical reads.
#[test]
fn the_recovery_read_matches_the_recorded_subtask_pair() {
    let read = normalize(&subtask_by_id_statement(templates().subtasks));
    assert!(
        read.contains(
            "{{subtasks}}.id AS {{subtasks}}_id, {{subtasks}}.user_id AS {{subtasks}}_user_id"
        ),
        "{read}"
    );
    assert!(read.contains("WHERE {{subtasks}}.id = ? LIMIT 1"), "{read}");

    let contexts = normalize(&contexts_by_subtask_ids_statement(1));
    assert!(
        contexts.contains("FROM subtask_contexts WHERE subtask_contexts.subtask_id IN (?)"),
        "{contexts}"
    );
    assert!(
        contexts.ends_with("ORDER BY subtask_contexts.id ASC"),
        "{contexts}"
    );
}

/// The first statement the recovery read prepares targets the routed shard
/// table, before the contexts load and before the RUNNING transition.
#[tokio::test]
async fn the_recovery_read_is_prepared_against_the_shard_first() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mysql = crate::connect_mysql(&format!(
            "mysql://test:test@{}/test?ssl-mode=disabled",
            listener.local_addr().unwrap()
        ))
        .unwrap()
        .with_route(RecordedShard);
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(mysql_pool_server::capture_queries_until(listener, stopped));

        // The fake server answers prepared statements with a SQL error, so the
        // read stops at the first statement.
        let _ = read_subtask_with_contexts(&mysql, templates(), 801_406_538_674_542).await;

        stop.send(()).unwrap();
        let queries = server.await.unwrap();
        mysql.close().await;

        let read = queries.first().expect("the recovery read is issued");
        assert!(
            read.contains("FROM `subtasks_0711`"),
            "the read targets the routed shard table: {read}"
        );
        assert!(
            read.contains("`subtasks_0711`.id AS `subtasks_0711_id`"),
            "the read keeps the ORM's labeled projection: {read}"
        );
        assert!(
            read.contains("WHERE `subtasks_0711`.id = ?") && read.trim_end().ends_with("LIMIT 1"),
            "the read keeps the by-id predicate and LIMIT 1: {read}"
        );
    })
    .await
    .expect("the recovery read should be prepared within the test timeout");
}
