// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task runtime-state repository mirroring
//! `task_access_store.get_runtime_state`
//! (`Wegent/backend/app/stores/tasks/sqlalchemy_access_store.py`).
//!
//! The runtime checkpoint is a single statement: it projects only
//! `status.status`, `status.updatedAt`, and the row timestamp, and applies the
//! owner/approved-member visibility policy inline through the same
//! `resource_members` `EXISTS` predicate the source renders. A task that is
//! absent, inactive, JSON-deleted (`status.status == 'DELETE'`), or not
//! visible to the viewer produces no row, which the endpoint maps to the
//! source's `HTTPException(404, "Task not found")`.
//!
//! The statement belongs to the task store: the viewer and task values bind as
//! `?` parameters that materialize to the source's inline literals.
use anyhow::Result;
use brz_mysql::MysqlRow;

use crate::task_store::TaskStore;

/// `TaskRuntimeState` (`app/stores/tasks/interfaces.py`): the authorized
/// checkpoint without task content. `updated_at` already carries the resolved
/// value (`row[1] or row[2]`) the response serializes.
#[derive(Debug)]
pub(crate) struct TaskRuntimeState {
    pub status: Option<String>,
    pub updated_at: Option<chrono::NaiveDateTime>,
}

/// Mirror of `task_access_store.get_runtime_state`.
pub(crate) async fn get_runtime_state(
    task_store: &dyn TaskStore,
    task_id: i64,
    user_id: i64,
) -> Result<Option<TaskRuntimeState>> {
    let row: Option<MysqlRow> = task_store.get_runtime_state(task_id, user_id).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    // Column order follows the projection: the CRD `status.status`, the CRD
    // `status.updatedAt` text, then the row timestamp. MySQL reports the
    // `JSON_UNQUOTE` projections as binary (`LONGBLOB`, binary charset), so
    // the source's driver hands them over as bytes and decodes them to text.
    let status = decode_text(row.get_at::<Option<Vec<u8>>>(0)?);
    let crd_updated_at = decode_text(row.get_at::<Option<Vec<u8>>>(1)?);
    let row_updated_at: Option<chrono::NaiveDateTime> = row.get_at(2)?;
    let updated_at = resolve_updated_at(crd_updated_at, row_updated_at);
    Ok(Some(TaskRuntimeState { status, updated_at }))
}

/// Decode one projected text value out of its binary column. The source's
/// driver decodes these bytes with the connection's UTF-8 charset; the source
/// only ever stores UTF-8 text in `status.status` and `status.updatedAt`.
fn decode_text(value: Option<Vec<u8>>) -> Option<String> {
    value.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// `row[1] or row[2]`: the CRD `status.updatedAt` text wins while it is present
/// and non-empty, otherwise the row timestamp carries the value. The stored
/// text is the source's own naive ISO-8601 rendering, which pydantic parses and
/// re-serializes unchanged.
fn resolve_updated_at(
    crd_updated_at: Option<String>,
    row_updated_at: Option<chrono::NaiveDateTime>,
) -> Option<chrono::NaiveDateTime> {
    crd_updated_at
        .filter(|value| !value.is_empty())
        .and_then(|value| {
            chrono::NaiveDateTime::parse_from_str(&value, "%Y-%m-%dT%H:%M:%S%.f").ok()
        })
        .or(row_updated_at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runtime_state_read_binds_the_source_values_and_keeps_the_projection() {
        use crate::sql_test_support::KindQueryCapture;
        use crate::task_store::DefaultTaskStore;

        let mysql = KindQueryCapture::default();
        let store = DefaultTaskStore::new(mysql.clone());
        // No recorded row: the endpoint answers 404 without any other lookup.
        let task_id = 566_385_927_408_493_i64;
        assert!(
            get_runtime_state(&store, task_id, 4121)
                .await
                .unwrap()
                .is_none()
        );

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        // One statement carries the task id, the viewer id, and the membership
        // probe's task id and text entity id.
        assert_eq!(queries[0].args, 4);
        assert_eq!(queries[0].first_integer, Some(task_id));
        // The SQLAlchemy labels, the inline visibility policy, and the
        // timestamp label stay in place.
        let sql = &queries[0].sql;
        assert!(sql.contains("AS anon_1,"), "{sql}");
        assert!(sql.contains("AS anon_2,"), "{sql}");
        assert!(sql.contains("AS `tasks_updated_at` FROM `tasks`"), "{sql}");
        assert!(sql.contains("`tasks`.is_active IN (1, 2)"), "{sql}");
        assert!(sql.contains("END != 'DELETE'"), "{sql}");
        assert!(
            sql.contains("EXISTS (SELECT 1 FROM resource_members WHERE"),
            "{sql}"
        );
        assert!(
            sql.contains("resource_members.copied_resource_id = 0"),
            "{sql}"
        );
        assert!(sql.ends_with("LIMIT 1"), "{sql}");
    }

    fn row_timestamp() -> chrono::NaiveDateTime {
        chrono::NaiveDateTime::parse_from_str("2026-09-22 08:00:00", "%Y-%m-%d %H:%M:%S").unwrap()
    }

    #[test]
    fn crd_timestamp_wins_over_the_row_timestamp() {
        assert_eq!(
            resolve_updated_at(
                Some("2026-09-23T16:33:25.462411".to_owned()),
                Some(row_timestamp())
            ),
            Some(
                chrono::NaiveDateTime::parse_from_str(
                    "2026-09-23T16:33:25.462411",
                    "%Y-%m-%dT%H:%M:%S%.f"
                )
                .unwrap()
            )
        );
    }

    #[test]
    fn absent_or_empty_crd_timestamp_falls_back_to_the_row() {
        // `row[1] or row[2]` treats both SQL NULL and an empty string as absent.
        assert_eq!(
            resolve_updated_at(None, Some(row_timestamp())),
            Some(row_timestamp())
        );
        assert_eq!(
            resolve_updated_at(Some(String::new()), Some(row_timestamp())),
            Some(row_timestamp())
        );
        assert_eq!(resolve_updated_at(None, None), None);
    }
}
