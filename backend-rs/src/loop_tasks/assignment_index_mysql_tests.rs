//! Exercise assignment index initialization and reads on real LoopNode schemas.

use super::super::loop_repository::LoopItemRepository;
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy)]
enum Schema {
    Nullable,
    RequiredReference,
    RequiredColumns,
}

async fn seed(mysql: &MysqlService, schema: Schema) {
    mysql
        .execute(
            include_str!("../../tests/fixtures/loop_items_nullable.sql"),
            (),
        )
        .await
        .unwrap();
    let sentinel = !matches!(schema, Schema::Nullable);
    if sentinel {
        // Isolate the NULL-marker regression from other missing required columns.
        mysql
            .execute(
                "ALTER TABLE loop_items MODIFY loop_item_id VARCHAR(64) NOT NULL DEFAULT ''",
                (),
            )
            .await
            .unwrap();
    }
    if matches!(schema, Schema::RequiredColumns) {
        mysql
            .execute(
                "ALTER TABLE loop_items
             MODIFY cloud_project_id VARCHAR(64) NOT NULL DEFAULT '',
             MODIFY title VARCHAR(255) NOT NULL,
             MODIFY content_type VARCHAR(255) NOT NULL,
             MODIFY size_bytes BIGINT NOT NULL,
             MODIFY local_project_id INT NOT NULL,
             MODIFY metadata JSON NOT NULL,
             MODIFY source_task_snapshot JSON NOT NULL,
             MODIFY deleted_at DATETIME NOT NULL",
                (),
            )
            .await
            .unwrap();
    } else if !sentinel {
        // Empty strings would violate these constraints. Optional columns must stay NULL.
        mysql
            .execute(
                "ALTER TABLE loop_items
             ADD FOREIGN KEY (loop_item_id) REFERENCES loop_items(id),
             ADD FOREIGN KEY (parent_id) REFERENCES loop_items(id)",
                (),
            )
            .await
            .unwrap();
    }
    let unset = if sentinel { "''" } else { "NULL" };
    for id in ["issue-1", "empty-issue", "rollback-issue"] {
        mysql
            .execute(
                format!(
                    "INSERT INTO loop_items
             (id, resource_type, loop_item_id, cloud_project_id, description, title,
              content_type, size_bytes, local_project_id, metadata, source_task_snapshot,
              deleted_at, created_at, updated_at)
             VALUES (?, 'task', {unset}, '', '', '', '', 0, 0, JSON_OBJECT(),
                     JSON_OBJECT(), '1970-01-01 00:00:01', NOW(), NOW())"
                ),
                (id,),
            )
            .await
            .unwrap();
    }
    for (id, metadata, deleted) in [
        (
            "11",
            serde_json::json!({"event_type":"assignment", "action":"assign", "target_type":"human", "target_id":"7"}),
            false,
        ),
        (
            "12",
            serde_json::json!({"event_type":"assignment", "action":"assign", "target_type":"human", "target_id":"7", "receipt_tracking":true, "human_read_at":"2026-10-27T00:00:00Z"}),
            false,
        ),
        (
            "13",
            serde_json::json!({"event_type":"assignment", "action":"assign", "target_type":"agent", "target_id":"42"}),
            false,
        ),
        ("14", serde_json::json!({"event_type":"discussion"}), false),
        (
            "15",
            serde_json::json!({"event_type":"assignment", "action":"assign", "target_type":"human", "target_id":"8"}),
            false,
        ),
        (
            "16",
            serde_json::json!({"event_type":"assignment", "action":"unassign", "assignment_event_id":"15"}),
            false,
        ),
        (
            "17",
            serde_json::json!({"event_type":"assignment", "action":"assign", "target_type":"human", "target_id":"9"}),
            true,
        ),
    ] {
        mysql
            .execute(
                "INSERT INTO loop_items
             (id, resource_type, loop_item_id, cloud_project_id, description, title,
              content_type, size_bytes, local_project_id, metadata, source_task_snapshot,
              deleted_at, created_at, updated_at)
             VALUES (?, 'comment', 'issue-1', '', '', '', '', 0, 0, ?, JSON_OBJECT(),
                     ?, '2026-10-27 00:00:00', '2026-10-27 00:00:00')",
                (
                    id,
                    metadata.to_string(),
                    if deleted {
                        "2026-10-28 00:00:00"
                    } else {
                        "1970-01-01 00:00:01"
                    },
                ),
            )
            .await
            .unwrap();
    }
}

#[derive(FromMysqlRow)]
struct StoredIndex {
    loop_item_id: Option<String>,
    public_id: Option<String>,
    project_key: Option<String>,
    storage_prefix: Option<String>,
}

async fn assert_initialization(mysql: &MysqlService, sentinel: bool) {
    let (first, concurrent) = tokio::join!(
        ensure_active_index(mysql, "issue-1"),
        ensure_active_index(mysql, "issue-1"),
    );
    first.unwrap_or_else(|error| panic!("sentinel={sentinel}: {error:?}"));
    concurrent.unwrap_or_else(|error| panic!("concurrent sentinel={sentinel}: {error:?}"));
    for _ in 0..2 {
        ensure_active_index(mysql, "issue-1").await.unwrap();
        let comments = LoopItemRepository::new(mysql)
            .list_active_assignment_comments("issue-1")
            .await
            .unwrap();
        assert_eq!(
            comments
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            ["12", "13"]
        );
        assert_eq!(
            comments[0].assignment().unwrap().human_read_at.as_deref(),
            Some("2026-10-27T00:00:00Z")
        );
        let nodes: Vec<StoredIndex> = mysql
            .fetch_all(
                "SELECT loop_item_id, public_id, project_key, storage_prefix FROM loop_items
             WHERE parent_id = 'issue-1' AND resource_type = 'assignment_index'",
                (),
            )
            .await
            .unwrap();
        assert_eq!(nodes.len(), 3);
        assert_eq!(
            nodes
                .iter()
                .filter(|node| node.loop_item_id.as_deref().unwrap_or("").is_empty())
                .count(),
            1
        );
        assert!(nodes.iter().all(|node| node.public_id.is_none()
            && node.project_key.is_none()
            && node.storage_prefix.is_none()));
        let marker: StoredIndex = mysql.fetch_one(
            "SELECT loop_item_id, public_id, project_key, storage_prefix FROM loop_items WHERE id = ?",
            (index_id("assignment-index", "issue-1"),),
        ).await.unwrap();
        assert_eq!(marker.loop_item_id.as_deref(), sentinel.then_some(""));
    }
    ensure_active_index(mysql, "empty-issue").await.unwrap();
    assert!(
        LoopItemRepository::new(mysql)
            .list_active_assignment_comments("empty-issue")
            .await
            .unwrap()
            .is_empty()
    );
    let error = ensure_active_index(mysql, "missing-issue")
        .await
        .unwrap_err();
    assert_eq!(error.status(), StatusCode::NOT_FOUND);
}

async fn assert_rollback_and_recovery(mysql: &MysqlService) {
    let marker = index_id("assignment-index", "rollback-issue");
    // A colliding non-index row fails the final insert, after assignment nodes were written.
    mysql
        .execute(
            "INSERT INTO loop_items
         (id, resource_type, loop_item_id, cloud_project_id, description, title,
          content_type, size_bytes, local_project_id, metadata, source_task_snapshot,
          deleted_at, created_at, updated_at)
         SELECT CASE WHEN id = '14' THEN ? ELSE CONCAT('rollback-', id) END,
                resource_type, 'rollback-issue', cloud_project_id, description, title,
                content_type, size_bytes, local_project_id, metadata, source_task_snapshot,
                deleted_at, created_at, updated_at
         FROM loop_items WHERE id IN ('12', '13', '14')",
            (marker.as_str(),),
        )
        .await
        .unwrap();
    let error = ensure_active_index(mysql, "rollback-issue")
        .await
        .unwrap_err();
    assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let nodes: Vec<StoredIndex> = mysql
        .fetch_all(
            "SELECT loop_item_id, public_id, project_key, storage_prefix FROM loop_items
         WHERE parent_id = 'rollback-issue' AND resource_type = 'assignment_index'",
            (),
        )
        .await
        .unwrap();
    assert!(
        nodes.is_empty(),
        "failed initialization must roll back every index node"
    );
    mysql
        .execute("DELETE FROM loop_items WHERE id = ?", (marker.as_str(),))
        .await
        .unwrap();
    ensure_active_index(mysql, "rollback-issue").await.unwrap();
    let comments = LoopItemRepository::new(mysql)
        .list_active_assignment_comments("rollback-issue")
        .await
        .unwrap();
    assert_eq!(
        comments
            .iter()
            .map(|row| row.id.as_str())
            .collect::<Vec<_>>(),
        ["rollback-12", "rollback-13"]
    );
}

async fn assert_automation_maintains_index(mysql: &MysqlService) {
    use crate::background_jobs::project::{assignments, store};

    let assign = async |target: &str| {
        mysql
            .with_transaction(async |tx| {
                let issue = store::locked(tx, "task", "issue-1").await?.unwrap();
                assignments::record(
                    tx,
                    &issue,
                    "human",
                    target,
                    "Reviewer",
                    7,
                    true,
                    "automation",
                )
                .await
            })
            .await
            .unwrap()
    };
    let assert_current = async |expected: &str| {
        let repository = LoopItemRepository::new(mysql);
        let indexed = repository
            .list_active_assignment_comments("issue-1")
            .await
            .unwrap();
        let history = repository.list_item_comments("issue-1").await.unwrap();
        let authoritative = active_events(&history);
        assert_eq!(
            indexed.len(),
            1,
            "expected={expected}; indexed={indexed:?}; history={history:?}"
        );
        assert_eq!(indexed[0].id, expected);
        assert_eq!(indexed[0].id, authoritative[0].comment.id);
        assert_eq!(
            indexed[0].assignment().unwrap().target_id.as_deref(),
            Some("52")
        );
    };
    let (first, created) = assign("52").await;
    assert!(created);
    assert_current(&first).await;
    let (repeated, created) = assign("52").await;
    assert!(!created);
    assert_eq!(repeated, first);
    assert_current(&first).await;

    // A failed index write rolls back both the cancellation and new assignment.
    let marker = index_id("assignment-index", "issue-1");
    mysql
        .execute("DELETE FROM loop_items WHERE id = ?", (marker.as_str(),))
        .await
        .unwrap();
    mysql
        .with_transaction(async |tx| {
            store::insert(
                tx,
                "comment",
                serde_json::json!({
                    "id":marker,"loop_item_id":"issue-1","metadata":{"event_type":"discussion"}
                }),
            )
            .await?;
            Ok(())
        })
        .await
        .unwrap();
    let failed = mysql
        .with_transaction(async |tx| {
            let issue = store::locked(tx, "task", "issue-1").await?.unwrap();
            assignments::record(tx, &issue, "human", "53", "Other", 7, true, "automation").await
        })
        .await;
    assert_eq!(failed.unwrap_err().database_code(), Some(1062));
    assert_current(&first).await;
    mysql
        .execute("DELETE FROM loop_items WHERE id = ?", (marker.as_str(),))
        .await
        .unwrap();
    ensure_active_index(mysql, "issue-1").await.unwrap();

    // Simulate a pre-fix Rust writer: a new event exists but the v1 index still
    // points at the previous assignment. Reading repairs it without new work IDs.
    mysql.execute(
        "UPDATE loop_items SET version = 1 WHERE parent_id = 'issue-1' AND resource_type = 'assignment_index'", (),
    ).await.unwrap();
    mysql.with_transaction(async |tx| {
        store::insert(tx, "comment", serde_json::json!({
            "id":"legacy-cancel", "loop_item_id":"issue-1",
            "created_at":"2099-01-01 00:00:00",
            "metadata":{"event_type":"assignment","action":"unassign","assignment_event_id":first}
        })).await?;
        store::insert(tx, "comment", serde_json::json!({
            "id":"legacy-current", "loop_item_id":"issue-1",
            "created_at":"2099-01-01 00:00:00",
            "metadata":{"event_type":"assignment","action":"assign","target_type":"human","target_id":"52"}
        })).await?;
        Ok(())
    }).await.unwrap();
    for _ in 0..2 {
        ensure_active_index(mysql, "issue-1").await.unwrap();
        assert_current("legacy-current").await;
    }
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn initializes_nullable_and_sentinel_indexes_without_changing_assignment_events() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    let address: std::net::SocketAddr = address.parse().unwrap();
    assert!(
        address.ip().is_loopback(),
        "use a disposable loopback fixture"
    );
    let url = |database: &str| format!("mysql://root@{address}/{database}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    let database = format!(
        "assignment_index_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    admin
        .execute(format!("CREATE DATABASE {database}"), ())
        .await
        .unwrap();
    let mysql = MysqlService::connect(&url(&database)).await.unwrap();
    let test_mysql = mysql.clone();
    let result = tokio::spawn(async move {
        for schema in [
            Schema::Nullable,
            Schema::RequiredReference,
            Schema::RequiredColumns,
        ] {
            seed(&test_mysql, schema).await;
            let sentinel = !matches!(schema, Schema::Nullable);
            assert_initialization(&test_mysql, sentinel).await;
            assert_rollback_and_recovery(&test_mysql).await;
            assert_automation_maintains_index(&test_mysql).await;
            test_mysql
                .execute("DROP TABLE loop_items", ())
                .await
                .unwrap();
        }
    })
    .await;
    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE {database}"), ())
        .await
        .unwrap();
    admin.close().await;
    result.unwrap();
}
