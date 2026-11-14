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

/// Sort only candidate ids and retain old pending forms beyond the chat window.
pub fn pending_form_candidates_statement(table: &str, cursor: Option<Option<i64>>) -> String {
    let cursor_predicate = match cursor {
        None => "",
        Some(None) => " AND form.message_id IS NULL AND form.id < ?",
        Some(Some(_)) => {
            " AND (form.message_id < ? OR form.message_id IS NULL \
             OR (form.message_id = ? AND form.id < ?))"
        }
    };
    format!(
        "SELECT candidate.id, candidate.message_id, \
         JSON_EXTRACT(candidate.result, '$.blocks') AS blocks FROM {table} AS candidate \
         JOIN (SELECT form.id FROM {table} AS form \
         LEFT JOIN (SELECT message_id, id FROM {table} WHERE task_id = ? \
         AND `role` = 'USER' ORDER BY message_id DESC, id DESC LIMIT 1) AS answered ON true \
         WHERE form.task_id = ? AND form.`role` = 'ASSISTANT' \
         AND CAST(JSON_EXTRACT(form.result, '$.blocks') AS CHAR) \
         LIKE '%interactive_form_question%' \
         AND (answered.id IS NULL OR form.message_id > answered.message_id \
         OR (answered.message_id IS NULL AND form.message_id IS NOT NULL) \
         OR (form.message_id <=> answered.message_id AND form.id > answered.id))\
         {cursor_predicate} ORDER BY form.message_id DESC, form.id DESC LIMIT 50) \
         AS selected ON selected.id = candidate.id"
    )
}

pub fn pipeline_latest_completed_statement(table: &str) -> String {
    format!(
        "SELECT output.message_id, output.result FROM {table} AS output \
         JOIN (SELECT id FROM {table} WHERE task_id = ? AND `role` = 'ASSISTANT' \
         AND status = 'COMPLETED' ORDER BY message_id DESC, created_at DESC, id DESC \
         LIMIT 1) AS selected ON output.id = selected.id"
    )
}

pub fn pipeline_original_prompt_statement(table: &str) -> String {
    format!(
        "SELECT original.prompt FROM {table} AS original \
         JOIN (SELECT id FROM {table} WHERE task_id = ? AND `role` = 'USER' \
         AND message_id < ? ORDER BY message_id ASC, created_at ASC, id ASC LIMIT 1) \
         AS selected ON original.id = selected.id"
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

    #[test]
    fn pending_forms_are_filtered_and_paged_before_blocks_are_hydrated() {
        for table in ["subtasks", "{{subtasks}}"] {
            let statement = pending_form_candidates_statement(table, None);
            assert!(statement.contains(&format!("JOIN (SELECT form.id FROM {table}")));
            assert!(statement.contains("ORDER BY message_id DESC, id DESC LIMIT 1"));
            assert!(statement.contains("LIMIT 50)"));
            assert!(statement.contains("form.message_id <=> answered.message_id"));
            assert!(!statement.contains("candidate.result AS"));
            assert!(!statement.contains("prompt"));
            assert!(
                pending_form_candidates_statement(table, Some(None))
                    .contains("form.message_id IS NULL AND form.id < ?")
            );
            assert!(
                pending_form_candidates_statement(table, Some(Some(20)))
                    .contains("form.message_id < ? OR form.message_id IS NULL")
            );
        }
    }

    #[test]
    fn subscription_pipeline_handoff_selects_only_one_output_and_original_prompt() {
        for table in ["subtasks", "{{subtasks}}"] {
            let output = pipeline_latest_completed_statement(table);
            let original = pipeline_original_prompt_statement(table);
            assert!(output.contains(&format!("JOIN (SELECT id FROM {table}")));
            assert!(original.contains(&format!("JOIN (SELECT id FROM {table}")));
            assert!(output.contains("status = 'COMPLETED'"));
            assert!(output.contains("LIMIT 1)"));
            assert!(original.contains("LIMIT 1)"));
            assert!(!original.contains("result"));
        }
    }
}
