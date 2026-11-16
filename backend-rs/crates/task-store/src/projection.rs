/// Decode one column of a task projection positionally.
///
/// The recorded source query aliases every task column with the resolved
/// physical table name (`tasks_0030_user_id`), which a caller cannot know, so
/// the completion flow positions into the fixed 12-column projection instead.
pub fn task_column<T: brz_mysql::FromMysqlCol>(
    row: &brz_mysql::MysqlRow,
    column: &str,
) -> Option<T> {
    let index = crate::task_store::task_column_index(column)?;
    row.get_at::<Option<T>>(index).ok().flatten()
}
