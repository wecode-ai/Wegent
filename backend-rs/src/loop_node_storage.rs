//! LoopNode inserts preserve nullable columns and satisfy deployed sentinel schemas.

use std::collections::HashSet;

use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};

pub(crate) async fn required_columns<T: MysqlTransaction>(
    tx: &mut T,
) -> MysqlResult<HashSet<String>> {
    #[derive(FromMysqlRow)]
    struct RequiredColumn {
        name: String,
    }
    let columns: Vec<RequiredColumn> = tx
        .fetch_all(
            "SELECT COLUMN_NAME AS name FROM information_schema.columns \
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loop_items' \
             AND IS_NULLABLE = 'NO'",
            (),
        )
        .await?;
    Ok(columns.into_iter().map(|column| column.name).collect())
}

/// Match Python's LoopNode adapter without populating nullable foreign or unique keys.
pub(crate) fn insert_sql(columns: &[&str], values: &[&str], required: &HashSet<String>) -> String {
    assert_eq!(columns.len(), values.len());
    let mut columns = columns.to_vec();
    let mut values = values.to_vec();
    for (names, value) in [
        (
            "parent_id public_id project_key name title storage_prefix source status priority current_delivery_id device_id task_id task_title path source_task_binding_id markdown_object_key chat_object_key manifest_object_key cloud_project_id loop_item_id delivery_id kind display_name relative_path object_key content_type sha256",
            "''",
        ),
        (
            "sequence_number created_by_user_id updated_by_user_id assignee_user_id assignee_team_id user_id added_by_user_id local_project_id is_default task_user_id backend_task_id linked_by_user_id size_bytes",
            "0",
        ),
        (
            "start_at due_at linked_at unlinked_at completed_at delivered_at deleted_at",
            "'1970-01-01 00:00:01'",
        ),
        ("source_task_snapshot metadata", "'{}'"),
    ] {
        for name in names.split_whitespace() {
            if required.contains(name) && !columns.contains(&name) {
                columns.push(name);
                values.push(value);
            }
        }
    }
    format!(
        "INSERT INTO loop_items ({}) VALUES ({})",
        columns.join(", "),
        values.join(", ")
    )
}
