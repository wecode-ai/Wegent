// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Running tasks of one device's slot usage for `GET /api/devices`
//! (`CloudDeviceProvider.get_slot_usage`).
//!
//! The cloud listing reads the online payload's `running_task_ids` and
//! resolves them through `task_store.list_by_ids`: one routed read of the
//! owner's `tasks` table, then the `Task` CRD fields the `DeviceInfo`
//! `running_tasks` entries carry.
use brz_mysql::{Mysql, MysqlResult};

use crate::crd::CrdDocument;
use crate::json_compat::OpaqueJson;
use crate::task_routing::ByUserId;

/// One `running_tasks` entry of `DeviceInfo`
/// (`CloudDeviceProvider.get_slot_usage` task projection).
#[derive(Debug, serde::Serialize)]
pub(crate) struct RunningTask {
    task_id: i64,
    subtask_id: i64,
    title: String,
    status: String,
    created_at: Option<String>,
}

/// The `tasks`/`tasks_{:04}` column list of `task_store.list_by_ids`
/// (`db.query(TaskResource).filter(TaskResource.id.in_(task_ids))`), resolved
/// through the routed `tasks` token so the deployment's task policy selects
/// the physical table.
const RUNNING_TASKS_SELECT: &str = "SELECT id, user_id, kind, name, namespace, json, is_active, \
     created_at, updated_at, project_id, client_origin, is_group_chat \nFROM {{tasks}}";

/// The consumed columns of one running-task row.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct RunningTaskRow {
    id: i64,
    kind: String,
    json: brz_mysql::Json<OpaqueJson>,
}

/// `task_store.list_by_ids` for the reported running task ids: one routed
/// read of the owner's task table, then the `Task` CRD projection
/// (`CloudDeviceProvider.get_slot_usage`).
///
/// The source sharded store groups the ids by their physical shard and issues
/// one read per group; a device's running tasks are the tasks its owner
/// started on it, so the owner's routing key resolves that group in one read.
pub(crate) async fn list_running_tasks<M: Mysql>(
    mysql: &M,
    user_id: i64,
    task_ids: Vec<i64>,
) -> MysqlResult<Vec<RunningTask>> {
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; task_ids.len()].join(", ");
    let sql = format!("{RUNNING_TASKS_SELECT} \nWHERE id IN ({placeholders})");
    let rows: Vec<RunningTaskRow> = mysql
        .route(ByUserId(user_id.unsigned_abs()))
        .fetch_all(sql.as_str(), task_ids)
        .await?;
    Ok(project_running_tasks(&rows))
}

/// `_build_slot_usage`'s row projection: `Task` rows only, a row whose CRD
/// fails validation dropped, and the first row per task id kept
/// (`_deduplicate_tasks_by_id`).
fn project_running_tasks(rows: &[RunningTaskRow]) -> Vec<RunningTask> {
    let mut running_tasks: Vec<RunningTask> = Vec::with_capacity(rows.len());
    for row in rows {
        if row.kind != "Task" {
            continue;
        }
        if let Some(task) = project_running_task(row) {
            running_tasks.push(task);
        }
    }
    let mut seen = std::collections::HashSet::with_capacity(running_tasks.len());
    running_tasks.retain(|task| seen.insert(task.task_id));
    running_tasks
}

/// The `Task` CRD fields of one running-task row. `None` mirrors the source's
/// `TaskCRD.model_validate` failure, which drops the row with a warning.
fn project_running_task(row: &RunningTaskRow) -> Option<RunningTask> {
    let document = CrdDocument::project_opaque(&row.json.0);
    let title = document
        .spec
        .as_ref()?
        .title
        .as_ref()?
        .project::<String>()?;
    let status = document.status.as_ref();
    Some(RunningTask {
        task_id: row.id,
        subtask_id: 0,
        title,
        // `task_crd.status.status` falls back to the model default `PENDING`
        // when the status object exists, and to `UNKNOWN` when it does not.
        status: status
            .map(|status| {
                status
                    .status
                    .clone()
                    .unwrap_or_else(|| "PENDING".to_string())
            })
            .unwrap_or_else(|| "UNKNOWN".to_string()),
        created_at: status
            .and_then(|status| status.created_at.as_ref())
            .filter(|created_at| !created_at.is_null())
            .and_then(OpaqueJson::project::<String>)
            .map(|created_at| python_datetime_isoformat(&created_at)),
    })
}

/// Render a stored CRD timestamp the way `datetime.isoformat()` renders the
/// datetime pydantic parsed it into: `T`-separated, the microsecond part
/// omitted when it is zero, and the UTC offset normalized to `±HH:MM`.
fn python_datetime_isoformat(value: &str) -> String {
    let value = value.trim();
    if let Ok(datetime) = chrono::DateTime::parse_from_rfc3339(value) {
        let offset = datetime.offset().local_minus_utc();
        let seconds = offset.unsigned_abs();
        return format!(
            "{}{}{:02}:{:02}",
            naive_isoformat(datetime.naive_local()),
            if offset < 0 { '-' } else { '+' },
            seconds / 3600,
            (seconds % 3600) / 60,
        );
    }
    match chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        Ok(naive) => naive_isoformat(naive),
        Err(_) => value.to_string(),
    }
}

/// Python `isoformat()` for a naive datetime.
fn naive_isoformat(value: chrono::NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_micros() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn running_task_row(id: i64, kind: &str, document: Value) -> RunningTaskRow {
        RunningTaskRow {
            id,
            kind: kind.to_string(),
            json: brz_mysql::Json(OpaqueJson::from(document)),
        }
    }

    #[test]
    fn running_task_projection_matches_slot_usage() {
        let row = running_task_row(
            10170482710738,
            "Task",
            json!({
                "kind": "Task",
                "spec": {"title": "[Subscription] yy-rd-huati"},
                "status": {"status": "RUNNING", "createdAt": "2026-09-21T11:37:05.661299"},
            }),
        );
        let projected =
            crate::json_contract_tests::serialized(&project_running_tasks(&[row])[0]).unwrap();
        assert_eq!(projected["task_id"], 10170482710738_i64);
        assert_eq!(projected["subtask_id"], 0);
        assert_eq!(projected["title"], "[Subscription] yy-rd-huati");
        assert_eq!(projected["status"], "RUNNING");
        assert_eq!(projected["created_at"], "2026-09-21T11:37:05.661299");
    }

    #[test]
    fn running_task_rows_drop_non_tasks_and_invalid_crds() {
        let tasks = project_running_tasks(&[
            running_task_row(1, "Workspace", json!({"spec": {"title": "w"}})),
            running_task_row(2, "Task", json!({"spec": {}})),
            running_task_row(3, "Task", json!({"spec": {"title": "kept"}})),
        ]);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].task_id, 3);
        assert_eq!(tasks[0].title, "kept");
    }

    #[test]
    fn running_task_status_defaults_follow_the_crd_model() {
        let absent = project_running_task(&running_task_row(
            1,
            "Task",
            json!({"spec": {"title": "t"}}),
        ))
        .unwrap();
        assert_eq!(absent.status, "UNKNOWN");
        assert_eq!(absent.created_at, None);

        let empty_status = project_running_task(&running_task_row(
            1,
            "Task",
            json!({"spec": {"title": "t"}, "status": {}}),
        ))
        .unwrap();
        assert_eq!(empty_status.status, "PENDING");
        assert_eq!(empty_status.created_at, None);

        let null_created_at = project_running_task(&running_task_row(
            1,
            "Task",
            json!({"spec": {"title": "t"}, "status": {"status": "RUNNING", "createdAt": null}}),
        ))
        .unwrap();
        assert_eq!(null_created_at.status, "RUNNING");
        assert_eq!(null_created_at.created_at, None);
    }

    #[test]
    fn python_datetime_isoformat_omits_zero_microseconds() {
        assert_eq!(
            python_datetime_isoformat("2026-09-21T11:37:05.661299"),
            "2026-09-21T11:37:05.661299"
        );
        assert_eq!(
            python_datetime_isoformat("2026-09-21T11:37:05"),
            "2026-09-21T11:37:05"
        );
        assert_eq!(
            python_datetime_isoformat("2026-09-21T11:37:05.000000"),
            "2026-09-21T11:37:05"
        );
        assert_eq!(
            python_datetime_isoformat("2026-09-21T11:37:05Z"),
            "2026-09-21T11:37:05+00:00"
        );
        assert_eq!(
            python_datetime_isoformat("2026-09-21T11:37:05.5+08:00"),
            "2026-09-21T11:37:05.500000+08:00"
        );
    }

    #[tokio::test]
    async fn running_tasks_read_routes_to_the_owner_and_skips_empty_input() {
        use crate::sql_test_support::{QueryCapture, Route};

        let mysql = QueryCapture::default();
        assert!(
            list_running_tasks(&mysql, 74, Vec::new())
                .await
                .unwrap()
                .is_empty()
        );
        assert!(mysql.queries().is_empty());

        assert!(
            list_running_tasks(&mysql, 74, vec![10170482710738])
                .await
                .unwrap()
                .is_empty()
        );
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].route, Route::User(74));
        assert_eq!(queries[0].args, 1);
        assert!(queries[0].sql.ends_with("FROM {{tasks}} WHERE id IN (?)"));
    }
}
