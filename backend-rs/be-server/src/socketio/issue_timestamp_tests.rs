//! Issue and activity timestamps retain their instant through real MySQL writes.

use brz_mysql::{Json, Mysql, MysqlTransaction};
use chrono::Utc;
use serde_json::json;

use super::{execution_aggregate, runtime_projection};
use crate::background_jobs::project::{completion::Message, store};

pub(crate) use wegent_runtime_execution::runtime_projection::assert_current;

pub(crate) async fn verify(mysql: &impl Mysql) -> anyhow::Result<()> {
    let since = Utc::now();
    mysql
        .with_transaction(async |tx| {
            for (kind, id, extra) in [
                ("project", "timestamp-project", json!({})),
                ("task", "timestamp-issue", json!({"status":"in_progress"})),
                ("chat_agent", "timestamp-agent", json!({"status":"active"})),
            ] {
                let mut values = json!({"id":id,"cloud_project_id":"timestamp-project"});
                values
                    .as_object_mut()
                    .unwrap()
                    .extend(extra.as_object().unwrap().clone());
                store::insert(tx, kind, values).await?;
            }
            Ok(())
        })
        .await?;
    let created: chrono::NaiveDateTime = mysql
        .fetch_one(
            "SELECT created_at FROM loop_items WHERE id='timestamp-issue'",
            (),
        )
        .await?;
    assert_current(
        &json!(super::project_chat_messages::utc_isoformat(created)),
        since,
    );

    let execution = mysql.execute(
        "INSERT INTO loop_item_executions(loop_item_id,cloud_project_id,agent_id,executor_owner_user_id,status,runtime_device_id,runtime_task_id,execution_payload,error_message) VALUES ('timestamp-issue','timestamp-project','timestamp-agent',7,'claimed','timestamp-device','timestamp-task','{}','')", (),
    ).await?.last_insert_id as i64;
    mysql.execute(
        "INSERT INTO project_chat_messages(message_id,project_id,task_id,sender_type,sender_id,sender_name,message_type,content,metadata,agent_id,runtime_device_id,runtime_task_id,status) VALUES ('timestamp-message','timestamp-project','timestamp-issue','agent','timestamp-agent','Agent','text','Progress',?,'timestamp-agent','timestamp-device','timestamp-task','pending')",
        (Json(json!({"activity_type":"member_execution","execution_id":execution})),),
    ).await?;

    mysql
        .with_transaction(async |tx| {
            let accepted = runtime_projection::open_accepted_activity(tx, execution, false)
                .await?
                .expect("existing member activity is accepted");
            assert_current(&accepted["updatedAt"], since);
            let row = runtime_projection::reload_execution(tx, execution)
                .await?
                .unwrap();
            execution_aggregate::bind_activity_runtime_turn(tx, &row, Some("timestamp-turn"))
                .await?;
            let message: Message = tx
                .fetch_one(
                    "SELECT * FROM project_chat_messages WHERE message_id='timestamp-message'",
                    (),
                )
                .await?;
            assert_current(&message.view()["updatedAt"], since);
            Ok(())
        })
        .await?;
    runtime_projection::verify_restored_activity_timestamp(mysql, since).await?;
    super::project_chat_snapshot::verify_snapshot_timestamp(mysql, since).await?;
    Ok(())
}
