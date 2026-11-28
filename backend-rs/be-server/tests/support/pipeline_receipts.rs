// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::{fixture, http_e2e};
use brz_mysql::Json;
use serde_json::json;
use wegent_backend_rs::task_store::{DefaultTaskStore, TaskStoreCreate};
use wegent_execution_completion::{CompletionStore, Tables, persist};

#[tokio::test]
#[ignore = "requires disposable MySQL 8 and Redis; covered by the Responses CI suite"]
async fn completed_stage_uses_live_roster_and_rejects_unavailable_resources() {
    let fixture = fixture::Fixture::new().await;
    let db = &fixture.mysql;
    let store = DefaultTaskStore::new(db.clone());
    let redis =
        brz_redis::RedisService::single(std::env::var("WEGENT_TEST_REDIS_ADDRESS").unwrap())
            .await
            .unwrap();
    let ctx = CompletionStore {
        mysql: db,
        redis: &redis,
        tables: Tables {
            tasks: "tasks",
            subtasks: "subtasks",
        },
        task_store: None,
    };
    fixture.seed_running_subtask(501, 801, 7).await;
    db.execute("CREATE TABLE kinds (id BIGINT PRIMARY KEY, user_id INT, kind VARCHAR(20), name VARCHAR(100), namespace VARCHAR(100), json JSON, is_active TINYINT, created_at DATETIME, updated_at DATETIME)", ()).await.unwrap();
    let live = json!({"collaborationModel":"pipeline","members":[{"botRef":{"name":"replacement"}},{"botRef":{"name":"next"}}]});
    db.execute(
        "INSERT INTO kinds (id,user_id,kind,name,namespace,json,is_active) VALUES
        (81,7,'Team','team','default',?,1),
        (82,7,'Bot','retired','default',JSON_OBJECT(),0),
        (83,7,'Bot','next','default',JSON_OBJECT(),1)",
        (Json(json!({"spec":live})),),
    )
    .await
    .unwrap();
    for (task_id, subtask_id, running, active_team, active_next) in [
        (501, 801, false, true, true),
        (502, 1802, true, true, true),
        (503, 2803, true, true, false),
        (504, 3804, true, false, true),
    ] {
        http_e2e::seed_task(db, "tasks", task_id, 7).await;
        db.execute("UPDATE tasks SET json=JSON_OBJECT('status',JSON_OBJECT('status','RUNNING'),'spec',JSON_OBJECT('currentStage',0,'teamRef',JSON_OBJECT('name','team','namespace','default','user_id',7))) WHERE id=?", (task_id,)).await.unwrap();
        if task_id != 501 {
            db.execute("INSERT INTO subtasks (id,user_id,task_id,message_id,status) VALUES (?,7,?,1,'RUNNING')",(subtask_id,task_id)).await.unwrap();
        }
        db.execute(
            "UPDATE subtasks SET bot_ids=JSON_ARRAY(82),status='COMPLETED' WHERE id=?",
            (subtask_id,),
        )
        .await
        .unwrap();
        db.execute("UPDATE kinds SET is_active=? WHERE id=81", (active_team,))
            .await
            .unwrap();
        db.execute("UPDATE kinds SET is_active=? WHERE id=83", (active_next,))
            .await
            .unwrap();
        let can_advance = active_team && active_next;
        let advance = persist::update_task_status(&ctx, task_id, subtask_id).await;
        assert_eq!(advance, can_advance);
        let (Json(task),): (Json<serde_json::Value>,) = db
            .fetch_one("SELECT json FROM tasks WHERE id=?", (task_id,))
            .await
            .unwrap();
        assert_eq!(
            task["status"]["status"],
            if can_advance { "PENDING" } else { "FAILED" }
        );
        let handoff = store
            .advance_pipeline_stage(db, task_id, subtask_id)
            .await
            .unwrap();
        assert_eq!(
            handoff.as_ref().map(|next| next.bot.id),
            can_advance.then_some(83)
        );
        if let Some(handoff) = handoff {
            let child = handoff.pair.assistant_subtask_id;
            if running {
                let accepted = db
                    .with_transaction(async |tx| {
                        wegent_task_store::task_store_pipeline::record_accepted_pair(
                            tx, "tasks", "subtasks", &handoff, false,
                        )
                        .await
                    })
                    .await
                    .unwrap();
                assert!(accepted);
            }
            db.execute("UPDATE kinds SET is_active=0 WHERE id=81", ())
                .await
                .unwrap();
            assert!(
                store
                    .advance_pipeline_stage(db, task_id, subtask_id)
                    .await
                    .unwrap()
                    .is_none()
            );
            let unfenced = db
                .with_transaction(async |tx| {
                    persist::settle_unavailable_on(
                        tx, "tasks", "subtasks", task_id, subtask_id, None,
                    )
                    .await
                })
                .await
                .unwrap()
                .unwrap();
            assert!(
                unfenced.auto_advance,
                "a changed handoff must retain recovery until its own worker lease is held"
            );
            let settled = db
                .with_transaction(async |tx| {
                    persist::settle_unavailable_on(
                        tx,
                        "tasks",
                        "subtasks",
                        task_id,
                        subtask_id,
                        Some(child),
                    )
                    .await
                })
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                settled.auto_advance, running,
                "retain recovery only for a possibly live child"
            );
            let child_status: String = db
                .fetch_one("SELECT status FROM subtasks WHERE id=?", (child,))
                .await
                .unwrap();
            assert_eq!(child_status, if running { "RUNNING" } else { "FAILED" });
            let (Json(task),): (Json<serde_json::Value>,) = db
                .fetch_one("SELECT json FROM tasks WHERE id=?", (task_id,))
                .await
                .unwrap();
            assert_eq!(task["status"]["status"], child_status);
            assert_eq!(
                wegent_task_store::pending_pipeline_parent(&task),
                running.then_some(subtask_id)
            );
        }
    }
    fixture.close().await;
}
