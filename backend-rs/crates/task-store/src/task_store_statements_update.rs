/// `subtask_store.update_fields(status=RUNNING)` (`execution/dispatcher.py:347`
/// → `chat/storage/db.py:199`): the status-only flush. SQLAlchemy's `onupdate`
/// also refreshes `updated_at`, which is why the recorded statement carries
/// both columns.
pub fn update_subtask_running_statement(table: &str) -> String {
    format!("UPDATE {table} SET status=?, updated_at=? WHERE {table}.id = ?")
}

/// `subtask_store.update_fields` flush for a terminal subtask update
/// (`app/services/chat/storage/db.py:199`): the mapped columns that changed,
/// in SQLAlchemy's mapper order — `executor_namespace`, `executor_name`,
/// `status`, `result`, `error_message`, `updated_at`, `completed_at`.
///
/// `with_executor` mirrors the source's "only save executor info when it is
/// provided and the row has none" branch; `with_error` mirrors the `FAILED`
/// branch that also writes `error_message`.
pub fn update_subtask_terminal_statement(
    table: &str,
    with_result: bool,
    with_error: bool,
    with_executor: bool,
) -> String {
    let mut sets: Vec<&str> = Vec::new();
    if with_executor {
        sets.push("executor_namespace=?");
        sets.push("executor_name=?");
    }
    sets.push("status=?");
    // `_update_subtask_sync` assigns `fields["result"]` only when the caller
    // passed a result (`db.py:136`), so a terminal error without one leaves the
    // stored result untouched.
    if with_result {
        sets.push("result=?");
    }
    if with_error {
        sets.push("error_message=?");
    }
    sets.push("updated_at=?");
    sets.push("completed_at=?");
    format!(
        "UPDATE {table} SET {} WHERE {table}.id = ?",
        sets.join(", ")
    )
}
