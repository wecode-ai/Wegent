//! Store-owned global scans and conditional writes used by background maintenance.

use async_trait::async_trait;
use brz_mysql::{Mysql, MysqlResult, MysqlRow};
use chrono::NaiveDateTime;

use crate::task_store::DefaultTaskStore;
use crate::task_store_statements::{SUBTASK_COLUMNS, SUBTASKS_TABLE};

#[derive(Clone, Debug)]
pub enum MaintenanceScan {
    RunningDevices,
    RunningSince {
        created_after: NaiveDateTime,
    },
    CursorRecent {
        created_after: NaiveDateTime,
    },
    CursorLatest,
    RuntimeExecutors,
    CleanupPrimary {
        last_id: i64,
        cutoff: NaiveDateTime,
        limit: usize,
    },
    CleanupLookback {
        after: NaiveDateTime,
        cutoff: NaiveDateTime,
        limit: usize,
    },
}

#[async_trait]
pub trait TaskStoreMaintenance: Send + Sync {
    async fn scan_recent_group_chats(&self, since: NaiveDateTime) -> MysqlResult<Vec<MysqlRow>>;
    async fn scan_maintenance_subtasks(&self, scan: &MaintenanceScan)
    -> MysqlResult<Vec<MysqlRow>>;

    /// Compare the running status and owner before failing a device attempt.
    async fn mark_device_subtask_failed(
        &self,
        task_id: i64,
        subtask_id: i64,
        owner_id: i64,
        at: NaiveDateTime,
    ) -> MysqlResult<bool>;

    async fn save_task_archive(
        &self,
        task_id: i64,
        owner_id: i64,
        archive: &str,
        at: NaiveDateTime,
    ) -> MysqlResult<bool>;

    async fn mark_maintenance_executor_deleted(
        &self,
        task_id: i64,
        owner_id: i64,
        subtask_ids: &[i64],
    ) -> MysqlResult<()>;
}

pub async fn scan_group_chats_table<M: Mysql>(
    mysql: &M,
    table: &str,
    since: NaiveDateTime,
) -> MysqlResult<Vec<MysqlRow>> {
    mysql.fetch_all(format!("SELECT id,user_id,kind,name,namespace,json,is_active,created_at,updated_at,project_id,client_origin,is_group_chat FROM `{table}` WHERE kind='Task' AND is_active=1 AND (is_group_chat=true OR JSON_EXTRACT(json,'$.spec.is_group_chat')=true) AND updated_at>=?"), (since,)).await
}

pub fn maintenance_statement(table: &str, scan: &MaintenanceScan) -> String {
    let condition = match scan {
        MaintenanceScan::RunningDevices => "status = 'RUNNING' AND executor_name LIKE 'device-%'".to_owned(),
        MaintenanceScan::RunningSince { .. } => "status = 'RUNNING' AND created_at >= ?".to_owned(),
        MaintenanceScan::CursorRecent { .. } => "created_at >= ? ORDER BY created_at, id LIMIT 1".to_owned(),
        MaintenanceScan::CursorLatest => "1 = 1 ORDER BY id DESC LIMIT 1".to_owned(),
        MaintenanceScan::RuntimeExecutors => "executor_name IS NOT NULL AND executor_name != '' AND executor_deleted_at = false ORDER BY updated_at, id".to_owned(),
        MaintenanceScan::CleanupPrimary { limit, .. } => format!("id > ? AND created_at <= ? ORDER BY id LIMIT {limit}"),
        MaintenanceScan::CleanupLookback { limit, .. } => format!("status IN ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED') AND created_at > ? AND created_at <= ? AND executor_name IS NOT NULL AND executor_name != '' AND executor_deleted_at = false ORDER BY created_at, id LIMIT {limit}"),
    };
    format!("SELECT {SUBTASK_COLUMNS} FROM `{table}` WHERE {condition}")
}

pub async fn scan_table<M: Mysql>(
    mysql: &M,
    table: &str,
    scan: &MaintenanceScan,
) -> MysqlResult<Vec<MysqlRow>> {
    let statement = maintenance_statement(table, scan);
    match scan {
        MaintenanceScan::RunningDevices
        | MaintenanceScan::RuntimeExecutors
        | MaintenanceScan::CursorLatest => mysql.fetch_all(statement, ()).await,
        MaintenanceScan::RunningSince { created_after }
        | MaintenanceScan::CursorRecent { created_after } => {
            mysql.fetch_all(statement, (*created_after,)).await
        }
        MaintenanceScan::CleanupPrimary {
            last_id, cutoff, ..
        } => mysql.fetch_all(statement, (*last_id, *cutoff)).await,
        MaintenanceScan::CleanupLookback { after, cutoff, .. } => {
            mysql.fetch_all(statement, (*after, *cutoff)).await
        }
    }
}

/// Shard scans select a bounded page per table and merge by the source ordering.
pub fn order_scan(rows: &mut Vec<MysqlRow>, scan: &MaintenanceScan) -> MysqlResult<()> {
    let (time_column, limit) = match scan {
        MaintenanceScan::CleanupPrimary { limit, .. } => (None, Some(*limit)),
        MaintenanceScan::CleanupLookback { limit, .. } => (Some("created_at"), Some(*limit)),
        MaintenanceScan::RuntimeExecutors => (Some("updated_at"), None),
        MaintenanceScan::CursorRecent { .. } => (Some("created_at"), Some(1)),
        MaintenanceScan::CursorLatest => {
            let mut keyed = rows
                .drain(..)
                .map(|row| row.get_required::<i64>("id").map(|id| (id, row)))
                .collect::<MysqlResult<Vec<_>>>()?;
            keyed.sort_by_key(|(id, _)| std::cmp::Reverse(*id));
            rows.extend(keyed.into_iter().take(1).map(|(_, row)| row));
            return Ok(());
        }
        _ => return Ok(()),
    };
    let mut keyed = Vec::with_capacity(rows.len());
    for row in rows.drain(..) {
        let id = row.get_required::<i64>("id")?;
        let time = time_column
            .map(|column| row.get_required::<NaiveDateTime>(column))
            .transpose()?;
        keyed.push(((time, id), row));
    }
    keyed.sort_by_key(|(key, _)| *key);
    if let Some(limit) = limit {
        keyed.truncate(limit);
    }
    rows.extend(keyed.into_iter().map(|(_, row)| row));
    Ok(())
}

pub async fn mark_device_failed<M: Mysql>(
    mysql: &M,
    table: &str,
    subtask_id: i64,
    owner_id: i64,
    at: NaiveDateTime,
) -> MysqlResult<bool> {
    let statement = format!(
        "UPDATE `{table}` SET status = 'FAILED', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'RUNNING'"
    );
    let result = mysql
        .execute(
            statement,
            (
                "Device connection lost (heartbeat timeout)",
                at,
                at,
                subtask_id,
                owner_id,
            ),
        )
        .await?;
    Ok(result.rows_affected > 0)
}

pub async fn save_archive<M: Mysql>(
    mysql: &M,
    table: &str,
    task_id: i64,
    owner_id: i64,
    archive: &str,
    at: NaiveDateTime,
) -> MysqlResult<bool> {
    let sql = format!(
        "UPDATE `{table}` SET json = JSON_SET(json, '$.status', JSON_SET(CASE WHEN JSON_TYPE(JSON_EXTRACT(json, '$.status')) = 'OBJECT' THEN JSON_EXTRACT(json, '$.status') ELSE JSON_OBJECT() END, '$.archive', CAST(? AS JSON))), updated_at = ? WHERE id = ? AND user_id = ?"
    );
    Ok(mysql
        .execute(sql, (archive, at, task_id, owner_id))
        .await?
        .rows_affected
        > 0)
}

pub async fn mark_executor_deleted<M: Mysql>(
    mysql: &M,
    table: &str,
    task_id: i64,
    owner_id: i64,
    ids: &[i64],
) -> MysqlResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    use crate::task_store_statements::StatementArg;
    let mut arguments: Vec<StatementArg> = ids.iter().copied().map(StatementArg::Int).collect();
    arguments.extend([StatementArg::Int(task_id), StatementArg::Int(owner_id)]);
    mysql.execute(format!("UPDATE `{table}` SET executor_deleted_at = true WHERE id IN ({placeholders}) AND task_id = ? AND user_id = ?"), arguments).await?;
    Ok(())
}

#[async_trait]
impl<M: Mysql> TaskStoreMaintenance for DefaultTaskStore<M> {
    async fn scan_recent_group_chats(&self, since: NaiveDateTime) -> MysqlResult<Vec<MysqlRow>> {
        scan_group_chats_table(&self.mysql, crate::task_store::TASKS_TABLE, since).await
    }
    async fn scan_maintenance_subtasks(
        &self,
        scan: &MaintenanceScan,
    ) -> MysqlResult<Vec<MysqlRow>> {
        scan_table(&self.mysql, SUBTASKS_TABLE, scan).await
    }

    async fn mark_device_subtask_failed(
        &self,
        _task_id: i64,
        subtask_id: i64,
        owner_id: i64,
        at: NaiveDateTime,
    ) -> MysqlResult<bool> {
        mark_device_failed(&self.mysql, SUBTASKS_TABLE, subtask_id, owner_id, at).await
    }

    async fn save_task_archive(
        &self,
        task_id: i64,
        owner_id: i64,
        archive: &str,
        at: NaiveDateTime,
    ) -> MysqlResult<bool> {
        save_archive(
            &self.mysql,
            crate::task_store::TASKS_TABLE,
            task_id,
            owner_id,
            archive,
            at,
        )
        .await
    }

    async fn mark_maintenance_executor_deleted(
        &self,
        task_id: i64,
        owner_id: i64,
        ids: &[i64],
    ) -> MysqlResult<()> {
        mark_executor_deleted(&self.mysql, SUBTASKS_TABLE, task_id, owner_id, ids).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primary_scan_does_not_filter_out_running_or_unassigned_rows_before_cursor_advances() {
        let now = chrono::Utc::now().naive_utc();
        let sql = maintenance_statement(
            "subtasks",
            &MaintenanceScan::CleanupPrimary {
                last_id: 7,
                cutoff: now,
                limit: 2000,
            },
        );
        assert!(sql.contains("id > ? AND created_at <= ? ORDER BY id LIMIT 2000"));
        assert!(!sql.contains("status IN"));
    }

    #[test]
    fn lookback_is_bounded_by_creation_time_and_excludes_deleted_executors() {
        let now = chrono::Utc::now().naive_utc();
        let sql = maintenance_statement(
            "subtasks",
            &MaintenanceScan::CleanupLookback {
                after: now,
                cutoff: now,
                limit: 500,
            },
        );
        assert!(sql.contains("created_at > ? AND created_at <= ?"));
        assert!(sql.contains("executor_deleted_at = false"));
        assert!(!sql.contains("updated_at <="));
    }
}
