use super::*;

pub(crate) async fn verify_snapshot_timestamp(
    mysql: &impl brz_mysql::Mysql,
    since: chrono::DateTime<Utc>,
) -> anyhow::Result<()> {
    mysql
        .with_transaction(async |tx| {
            let row: Message = tx
                .fetch_one(
                    "SELECT * FROM project_chat_messages WHERE message_id='timestamp-message'",
                    (),
                )
                .await?;
            write_message(tx, &row, &row.metadata.0).await?;
            let reloaded = reload_message(tx, row.id).await?.unwrap();
            crate::socketio::issue_timestamp_tests::assert_current(
                &reloaded.view()["updatedAt"],
                since,
            );
            let task = task_row(tx, "timestamp-issue", "timestamp-project")
                .await?
                .unwrap();
            update_task_ai_state(
                tx,
                &task,
                &reloaded,
                &mut row.metadata.0.clone(),
                "completed",
            )
            .await?;
            let updated: NaiveDateTime = tx
                .fetch_one(
                    "SELECT updated_at FROM loop_items WHERE id='timestamp-issue'",
                    (),
                )
                .await?;
            crate::socketio::issue_timestamp_tests::assert_current(
                &json!(super::super::project_chat_messages::utc_isoformat(updated)),
                since,
            );
            Ok(())
        })
        .await?;
    Ok(())
}

#[test]
fn a_recorded_snapshot_parses_camel_case_fields() {
    let snapshot = parse_snapshot(&json!({
        "deviceId": "electron-22508b4b",
        "taskId": "runtime-140211547",
        "running": false,
        "completeHistory": false,
        "turns": [{
            "id": "01a1ac30-0e67-7470-856e-2fe9edeb6f02",
            "userMessageIds": [],
            "status": "done",
            "completedAt": 1793891317000i64
        }]
    }))
    .expect("the recorded snapshot validates");
    assert_eq!(snapshot.device_id, "electron-22508b4b");
    assert_eq!(snapshot.task_id, "runtime-140211547");
    assert_eq!(snapshot.turns[0].status, "done");
    assert_eq!(terminal_status(&snapshot.turns[0]), Some("completed"));
}

#[test]
fn invalid_turns_are_rejected() {
    assert!(
        parse_snapshot(&json!({
            "deviceId": "d",
            "taskId": "t",
            "turns": [{"id": "x", "status": "mystery"}]
        }))
        .is_err()
    );
    assert!(
        parse_snapshot(&json!({
            "deviceId": "",
            "taskId": "t",
            "turns": []
        }))
        .is_err()
    );
    assert!(
        parse_snapshot(&json!({
            "deviceId": "d",
            "taskId": "t",
            "running": "no",
            "turns": []
        }))
        .is_err()
    );
}

#[test]
fn the_chat_read_projects_explicit_unaliased_columns() {
    // Recording 20261105234003, dependencies.jsonl rows 58393/58395: the
    // source selects every modeled column with SQLAlchemy labels; the
    // engine maps the direct table columns but rejects `SELECT *`.
    let sql = chat_statement(3);
    assert!(sql.starts_with("SELECT project_chat_messages.id, "));
    assert!(!sql.contains("SELECT *"));
    assert!(!sql.contains(" AS project_chat_messages_"));
    for column in [
        "project_chat_messages.message_id",
        "project_chat_messages.metadata",
        "project_chat_messages.runtime_task_id",
        "project_chat_messages.status",
        "project_chat_messages.deleted_at",
    ] {
        assert!(sql.contains(column), "{column} is missing");
    }
    assert!(sql.contains("project_chat_messages.runtime_device_id IN (?, ?, ?)"));
    assert!(sql.contains("ORDER BY project_chat_messages.id"));
}

#[test]
fn the_room_follows_the_project_and_task_identity() {
    assert_eq!(
        project_chat_room("7", Some("task-1")),
        "wework-project-chat:task:7:task-1"
    );
    assert_eq!(
        project_chat_room("7", None),
        "wework-project-chat:project:7"
    );
}
