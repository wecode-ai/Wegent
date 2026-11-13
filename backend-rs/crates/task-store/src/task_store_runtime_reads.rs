//! Ancillary task reads must not hydrate conversation payloads.

use crate::request_sql::{RequestSql, RouteKey};
use crate::task_store_statements::StatementArg;
use brz_mysql::{MysqlResult, MysqlRow};

pub fn task_attachments_statement(table: &str) -> String {
    format!(
        "SELECT {} FROM subtask_contexts \
         WHERE subtask_contexts.subtask_id IN (SELECT id FROM {table} WHERE task_id = ?) \
         AND subtask_contexts.context_type = 'attachment' \
         AND subtask_contexts.status = 'ready' ORDER BY subtask_contexts.created_at",
        crate::task_store_listing::subtask_context_columns()
    )
}

pub async fn task_attachments_on(
    sql: &mut dyn RequestSql,
    table: &str,
    task_id: i64,
    route: RouteKey,
) -> MysqlResult<Vec<MysqlRow>> {
    sql.fetch_all_rows(
        route,
        &task_attachments_statement(table),
        vec![StatementArg::Int(task_id)],
    )
    .await
}

pub fn executor_reference_page_statement(table: &str) -> String {
    format!(
        "SELECT id, task_id, status, executor_name, executor_namespace, \
         executor_deleted_at, updated_at FROM {table} WHERE task_id = ? \
         AND id > ? ORDER BY id LIMIT 100"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ancillary_reads_never_project_conversation_payloads() {
        for table in ["subtasks", "{{subtasks}}"] {
            let attachments = task_attachments_statement(table);
            assert!(attachments.contains(&format!("SELECT id FROM {table} WHERE task_id = ?")));
            let cleanup = executor_reference_page_statement(table);
            assert!(cleanup.ends_with("ORDER BY id LIMIT 100"));
            assert!(!attachments.contains("result"));
            assert!(!cleanup.contains("result"));
            assert!(!cleanup.contains("prompt"));
        }
    }
}
