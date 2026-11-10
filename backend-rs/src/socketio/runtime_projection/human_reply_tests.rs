// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Reuse the existing isolated migration database and real SQL implementation.

use brz_mysql::{Json, Mysql};
use serde_json::json;

use super::super::{RuntimeIdentity, project_in_transaction};

const PROJECT: &str = "late-answer-project";
const ISSUE: &str = "late-answer-issue";
const MESSAGE: &str = "late-answer-result";
const DEVICE: &str = "app-record-88888";
const TASK: &str = "late-answer-conversation";

pub(crate) async fn verify(mysql: &impl Mysql) -> anyhow::Result<()> {
    mysql.execute("INSERT INTO loop_items(id,resource_type,description,metadata) VALUES (?, 'project', '', JSON_OBJECT()), (?, 'task', '', JSON_OBJECT())", (PROJECT, ISSUE)).await?;
    mysql
        .execute(
            "UPDATE loop_items SET cloud_project_id=?, status='in_progress' WHERE id=?",
            (PROJECT, ISSUE),
        )
        .await?;
    let payload = json!({"origin_context":{
        "human_request_id":"question-a", "comment_trigger_message_id":"answer-a"
    }})
    .to_string();
    let execution = mysql.execute("INSERT INTO loop_item_executions(loop_item_id,cloud_project_id,executor_owner_user_id,status,runtime_device_id,runtime_task_id,execution_payload,version,last_event_seq,attempt_no) VALUES (?,?,7,'completed',?,?,?,4,2,1)", (ISSUE,PROJECT,DEVICE,TASK,payload)).await?.last_insert_id as i64;
    let newer = mysql.execute("INSERT INTO loop_item_executions(loop_item_id,cloud_project_id,executor_owner_user_id,status,runtime_device_id,runtime_task_id,execution_payload) VALUES (?,?,7,'completed',?,?,'{}')", (ISSUE,PROJECT,DEVICE,TASK)).await?.last_insert_id as i64;
    mysql.execute("INSERT INTO project_chat_messages(message_id,project_id,task_id,sender_type,sender_id,sender_name,message_type,content,metadata,trigger_message_id,runtime_device_id,runtime_task_id,status) VALUES (?,?,?,'agent','fixture-agent','Fixture agent','agent_chunk','Finished reply',JSON_OBJECT(),'answer-a',?,?,'completed')", (MESSAGE,PROJECT,ISSUE,DEVICE,TASK)).await?;
    for sequence in [1, 3] {
        for variant in [
            "exact",
            "wrong-message",
            "wrong-turn",
            "wrong-owner",
            "wrong-device",
            "wrong-execution",
            "string-execution",
            "fractional-execution",
            "unfinished",
            "wrong-project",
            "wrong-issue",
            "no-sequence",
            "first-unbound",
            "retry-unbound",
        ] {
            verify_case(mysql, execution, newer, sequence, variant).await?;
        }
    }
    Ok(())
}

async fn reset(
    mysql: &impl Mysql,
    execution: i64,
    newer: i64,
    variant: &str,
) -> anyhow::Result<()> {
    let question = json!({"human_requests":[{"id":"question-a","status":"answering",
        "answer_message_id":"answer-a","recipient_user_id":7,"responsible_user_id":8,
        "version":1,"events":[]}]});
    mysql
        .execute(
            "UPDATE loop_items SET metadata=?,version=5 WHERE id=?",
            (Json(question), ISSUE),
        )
        .await?;
    mysql
        .execute("DELETE FROM loop_items WHERE id='late-answer-index'", ())
        .await?;
    mysql.execute("INSERT INTO loop_items(id,resource_type,cloud_project_id,parent_id,name,description,metadata) VALUES ('late-answer-index','human_request_index',?,?,'question-a','',JSON_OBJECT())", (PROJECT,ISSUE)).await?;
    let mut metadata = json!({"execution_id": if variant == "wrong-execution" {newer} else {execution},
        "runtime_turn_id":"accepted-turn","runtime_completed_at":"2026-11-10T00:00:00Z"});
    if variant.ends_with("unbound") {
        metadata.as_object_mut().unwrap().remove("runtime_turn_id");
    }
    if variant == "string-execution" {
        metadata["execution_id"] = json!(execution.to_string());
    }
    if variant == "fractional-execution" {
        metadata["execution_id"] = json!(execution as f64 + 0.5);
    }
    mysql
        .execute(
            "UPDATE project_chat_messages SET metadata=?,status=?,project_id=?,task_id=? WHERE message_id=?",
            (
                Json(metadata),
                if variant == "unfinished" {
                    "streaming"
                } else {
                    "completed"
                },
                if variant == "wrong-project" { "other-project" } else { PROJECT },
                if variant == "wrong-issue" { "other-issue" } else { ISSUE },
                MESSAGE,
            ),
        )
        .await?;
    mysql
        .execute(
            "UPDATE loop_item_executions SET attempt_no=? WHERE id=?",
            (if variant == "retry-unbound" { 2 } else { 1 }, execution),
        )
        .await?;
    Ok(())
}

async fn verify_case(
    mysql: &impl Mysql,
    execution: i64,
    newer: i64,
    sequence: i64,
    variant: &str,
) -> anyhow::Result<()> {
    reset(mysql, execution, newer, variant).await?;
    let expected = matches!(variant, "exact" | "first-unbound" | "string-execution");
    let payload = json!({"eventSeq":if variant == "no-sequence" {0} else {sequence},
        "subtaskId":if variant == "wrong-turn" {"other-turn"} else {"accepted-turn"},
        "clientUserMessageId":if variant == "wrong-message" {"previous-message"} else {"answer-a"}});
    let identity = RuntimeIdentity {
        event_name: "response.created",
        runtime_task_id: TASK.into(),
        payload: &payload,
    };
    let owner = if variant == "wrong-owner" { 8 } else { 7 };
    let device = if variant == "wrong-device" {
        "app-record-99999"
    } else {
        DEVICE
    };
    for attempt in 0..2 {
        let (projected, effects) = mysql
            .with_transaction(async |tx| project_in_transaction(tx, owner, device, &identity).await)
            .await?;
        assert_eq!(
            effects.settled_reply.is_some(),
            expected && attempt == 0,
            "{variant}/{sequence}/{attempt}"
        );
        assert!(
            effects.matched.is_none(),
            "A late acknowledgement must not reopen execution"
        );
        if expected {
            assert!(projected.is_none());
        }
        let issue = crate::background_jobs::project::store::get(mysql, "task", ISSUE)
            .await?
            .unwrap();
        assert_eq!(
            issue.metadata.0["human_requests"][0]["status"],
            if expected { "resolved" } else { "answering" },
            "{variant}/{sequence}"
        );
        assert_eq!(
            issue.metadata.0["human_requests"][0]["answer_message_id"],
            "answer-a"
        );
        assert_eq!(issue.version, if expected { 6 } else { 5 });
        let terminal: (String, i64, i64) = mysql
            .fetch_one(
                "SELECT status,version,last_event_seq FROM loop_item_executions WHERE id=?",
                (execution,),
            )
            .await?;
        assert_eq!(terminal, ("completed".into(), 4, 2));
        let indexes: i64 = mysql
            .fetch_one(
                "SELECT COUNT(*) FROM loop_items WHERE id='late-answer-index'",
                (),
            )
            .await?;
        assert_eq!(indexes, if expected { 0 } else { 1 });
    }
    Ok(())
}
