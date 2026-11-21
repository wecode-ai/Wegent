// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for `GET /api/v1/loop-items/{item_id}/collaborators`.
use super::*;
use crate::sql_test_support::KindQueryCapture;
use chrono::NaiveDateTime;
use serde_json::json;

fn datetime(value: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").expect("valid datetime")
}

fn task_item() -> TaskItemRow {
    TaskItemRow {
        id: "BUG55C8CC-8".to_string(),
        cloud_project_id: Some("4436375037871421266".to_string()),
        metadata: None,
    }
}

fn collaborator_row() -> CollaboratorRow {
    CollaboratorRow {
        id: "369595377560748172".to_string(),
        loop_item_id: Some("BUG55C8CC-8".to_string()),
        user_id: Some(6177),
        added_by_user_id: Some(6177),
        source: Some("manual".to_string()),
        created_at: Some(datetime("2026-10-10 13:57:44")),
        user_name: "example-user".to_string(),
        email: Some("example-user@example.invalid".to_string()),
    }
}

/// The item read matches the recorded statement: the full labeled projection,
/// the deleted-at guard, the `task` discriminator, and the implicit
/// `LIMIT 1`, with the id inlined as text.
#[tokio::test]
async fn task_item_query_matches_source() {
    let mysql = KindQueryCapture::default();
    let item = find_task_item(&mysql, "BUG55C8CC-8").await.unwrap();
    assert!(item.is_none());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert!(queries[0].sql.contains(
        "WHERE loop_items.id = 'BUG55C8CC-8' \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND loop_items.resource_type IN ('task') LIMIT 1"
    ));
    assert_eq!(queries[0].args, 0);
}

/// The collaborator read joins the full labeled `loop_items` projection with
/// the labeled `users` projection and orders by `created_at, id`.
#[tokio::test]
async fn collaborator_rows_query_matches_source() {
    let mysql = KindQueryCapture::default();
    let rows = list_collaborator_rows(&mysql, "BUG55C8CC-8").await.unwrap();
    assert!(rows.is_empty());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    let sql = &queries[0].sql;
    assert!(sql.contains("FROM loop_items INNER JOIN users ON users.id = loop_items.user_id"));
    assert!(sql.contains(
        "WHERE loop_items.loop_item_id = 'BUG55C8CC-8' \
         AND loop_items.resource_type IN ('collaborator') \
         ORDER BY loop_items.created_at, loop_items.id"
    ));
    // Both projections carry their labeled columns.
    assert!(sql.contains("loop_items.deleted_at AS loop_items_deleted_at"));
    assert!(sql.contains("users.updated_at AS users_updated_at"));
}

/// `item_security`: the item's explicit level wins; an unknown or absent
/// level falls back to the project default.
#[test]
fn item_security_prefers_the_item_level() {
    let project = project_row(None);
    let open = TaskItemRow {
        metadata: Some(Json(JsonProjection::from(
            json!({"security_level": "open"}),
        ))),
        ..task_item()
    };
    assert_eq!(item_security(&open, &project), "open");
    let related = TaskItemRow {
        metadata: Some(Json(JsonProjection::from(
            json!({"security_level": "related"}),
        ))),
        ..task_item()
    };
    assert_eq!(item_security(&related, &project), "related");
    let unset = task_item();
    assert_eq!(item_security(&unset, &project), "open");
    assert_eq!(
        item_security(&unset, &project_row(Some("related".to_string()))),
        "related"
    );
}

/// `ProjectListRow` carrying only `default_issue_security` metadata.
fn project_row(default_issue_security: Option<String>) -> ProjectListRow {
    let metadata = default_issue_security.map(|value| {
        Json(JsonProjection::from(serde_json::json!({
            "default_issue_security": value
        })))
    });
    ProjectListRow {
        id: "4436375037871421266".to_string(),
        public_id: None,
        project_key: None,
        name: None,
        description: None,
        created_by_user_id: 6177,
        status: "active".to_string(),
        version: 1,
        created_at: None,
        updated_at: None,
        metadata,
    }
}

/// The response renders the recorded `LoopItemCollaboratorResponse` shape,
/// including pydantic's naive-datetime `isoformat()`.
#[test]
fn serializes_the_recorded_collaborator_shape() {
    let value =
        crate::json_contract_tests::serialized(collaborator_response(&collaborator_row()).unwrap())
            .unwrap();
    assert_eq!(
        value,
        json!({
            "id": "369595377560748172",
            "loop_item_id": "BUG55C8CC-8",
            "user_id": 6177,
            "user_name": "example-user",
            "email": "example-user@example.invalid",
            "source": "manual",
            "added_by_user_id": 6177,
            "created_at": "2026-10-10T13:57:44",
        })
    );
}

/// `created_at` keeps sub-second precision with six fractional digits and a
/// NULL column maps to the source's unhandled-exception body.
#[test]
fn created_at_serialization() {
    let row = CollaboratorRow {
        created_at: Some(
            NaiveDateTime::parse_from_str("2026-10-10 13:57:44.123456", "%Y-%m-%d %H:%M:%S%.f")
                .unwrap(),
        ),
        ..collaborator_row()
    };
    let response = collaborator_response(&row).unwrap();
    assert_eq!(response.created_at, "2026-10-10T13:57:44.123456");

    let missing = CollaboratorRow {
        created_at: None,
        ..collaborator_row()
    };
    let error = collaborator_response(&missing).unwrap_err();
    assert_eq!(error.detail_message(), Some("Internal server error"));
}

/// A non-decimal `cloud_project_id` never reaches a statement: the source
/// `check` returns `not_accessible`, which maps to 404.
#[tokio::test]
async fn non_decimal_project_id_is_cloud_project_not_found() {
    let mysql = KindQueryCapture::default();
    let item = TaskItemRow {
        cloud_project_id: Some("not-a-number".to_string()),
        ..task_item()
    };
    let error = require_item_access(&mysql, &item, 6177).await.unwrap_err();
    assert_eq!(error.detail_message(), Some("Cloud project not found"));
    assert!(mysql.queries().is_empty());
}
