//! Explicit inactivity cleanup of one task's executors, with archive safeguards.
use crate::AppState;
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlCol, Json, MysqlRow};
use chrono::{Local, NaiveDateTime};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn task<T: FromMysqlCol>(row: &MysqlRow, name: &str) -> Result<T> {
    Ok(row.get_at(crate::task_store::task_column_index(name).context("Unknown task field")?)?)
}

struct Executor {
    namespace: String,
    name: String,
    ids: Vec<i64>,
    updated: NaiveDateTime,
}

/// None means the task is absent or is not a Task resource. Inactivity is the
/// sole eligibility gate; a stale RUNNING status does not pin resources.
pub async fn cleanup_stale_task_executor(
    state: &AppState,
    task_id: i64,
    inactive: i64,
    mut max_inactive: i64,
) -> Result<Option<Value>> {
    if inactive <= 0 || max_inactive <= 0 {
        bail!("Executor inactivity windows must be positive");
    }
    if max_inactive < inactive.saturating_mul(3) {
        max_inactive = 168.max(inactive.saturating_mul(3));
    }
    let Some(row) = state.task_store.get_task(task_id).await? else {
        return Ok(None);
    };
    if task::<String>(&row, "kind")? != "Task" {
        return Ok(None);
    }
    let owner: i64 = task(&row, "user_id")?;
    let payload: Json<Value> = task(&row, "json")?;
    let updated: NaiveDateTime = task(&row, "updated_at")?;
    let response = |reason: &str| json!({"task_id":task_id,"deleted":reason=="executor_deleted","skipped":reason!="executor_deleted","reason":reason,"inactive_hours":inactive,"max_inactive_hours":max_inactive,"dry_run":false});
    let mut groups: BTreeMap<(String, String), Executor> = BTreeMap::new();
    for subtask in state.task_store.list_subtasks_by_task(task_id).await? {
        if subtask.get::<bool>("executor_deleted_at")?.unwrap_or(false) {
            continue;
        }
        let name = subtask.get::<String>("executor_name")?.unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        if name.starts_with("device-") {
            return Ok(Some(response("device_executor")));
        }
        let namespace = subtask
            .get::<String>("executor_namespace")?
            .unwrap_or_default();
        let at = subtask.get_required::<NaiveDateTime>("updated_at")?;
        let group = groups
            .entry((namespace.clone(), name.clone()))
            .or_insert(Executor {
                namespace,
                name,
                ids: Vec::new(),
                updated: at,
            });
        group.updated = group.updated.max(at);
        group.ids.push(subtask.get_required("id")?);
    }
    if groups.is_empty() {
        return Ok(Some(response("executor_not_found")));
    }
    if payload.0["metadata"]["labels"]["preserveExecutor"] == "true" {
        return Ok(Some(response("preserve_executor")));
    }
    if !valid_payload(&payload.0) {
        return Ok(Some(response("invalid_task_payload")));
    }
    let now = Local::now().naive_local();
    let latest = groups
        .values()
        .map(|v| v.updated)
        .fold(updated, NaiveDateTime::max);
    if latest > now - chrono::Duration::hours(inactive) {
        return Ok(Some(response("not_stale")));
    }
    let mut deleted = Vec::new();
    let mut failed_archive = Vec::new();
    for executor in groups.into_values() {
        if let Err(error) = crate::archive_task_workspace(
            state,
            task_id,
            owner,
            &executor.name,
            &executor.namespace,
        )
        .await
        {
            if executor.updated.max(updated) > now - chrono::Duration::hours(max_inactive) {
                tracing::warn!(task_id,%error,"Retaining inactive executor after archive failure");
                failed_archive.push(
                    json!({"executor_name":executor.name,"executor_namespace":executor.namespace}),
                );
                continue;
            }
            tracing::warn!(task_id,%error,"Force deleting executor past maximum inactivity after archive failure");
        }
        if let Err(error) = state
            .executor_manager
            .delete_executor_task(&executor.name, &executor.namespace)
            .await
        {
            let detail = error.to_string().to_lowercase();
            if !(detail.contains("pod") && detail.contains("not found")) {
                return Err(error);
            }
        }
        state
            .task_store
            .mark_maintenance_executor_deleted(task_id, owner, &executor.ids)
            .await?;
        deleted
            .push(json!({"executor_name":executor.name,"executor_namespace":executor.namespace}));
    }
    let mut result = response(if deleted.is_empty() && !failed_archive.is_empty() {
        "archive_failed"
    } else {
        "executor_deleted"
    });
    result["executors"] = json!(if deleted.is_empty() {
        failed_archive
    } else {
        deleted
    });
    Ok(Some(result))
}

fn valid_payload(value: &Value) -> bool {
    value["metadata"].is_object()
        && value["spec"].is_object()
        && value["metadata"]["name"].is_string()
        && value["metadata"]["namespace"].is_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_task_payload_is_not_eligible_for_destructive_cleanup() {
        assert!(!valid_payload(&json!({"metadata":{},"spec":{}})));
        assert!(valid_payload(
            &json!({"metadata":{"name":"task","namespace":"default"},"spec":{}})
        ));
    }
}
