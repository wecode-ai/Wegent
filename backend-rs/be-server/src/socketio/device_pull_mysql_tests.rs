// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use brz_mysql::{MysqlRow, MysqlService};

pub(crate) async fn verify_candidate_selection(mysql: MysqlService) {
    seed_pull_schema(&mysql).await;
    let app = crate::app_test_support::app(mysql.clone());
    let command = PullCommand {
        owner_user_id: 7,
        runtime_device_id: "runner",
        execution_target_id: "runner",
        runtime_instance_id: "runtime",
        environment: "local",
        runner_catalog: None,
    };
    assert_eq!(
        pull_execution(&app, &command).await.unwrap(),
        json!({"success": true, "task": null, "workspace_cleanup_intents": []}),
    );
    seed_candidates(&mysql).await;
    let runner = resolve_owned_device_alias(&mysql, 7, "runner")
        .await
        .unwrap()
        .unwrap();
    let queued = claim::queue_rows(&app, 7, &device_identity_ids(&runner), command.environment)
        .await
        .unwrap();
    assert_eq!(queued.len(), 6);
    let candidate = claim::select_claimable(&app, 7, "runner", Some(&runner), queued)
        .await
        .unwrap()
        .unwrap();
    // The first Developer's scope is occupied. The next candidate is a
    // Viewer in the same project and still needs its own authorization.
    assert_eq!(candidate.id, 4);
    let prepared = claim::prepare_candidate(&app, &candidate, &runner, "runner")
        .await
        .unwrap()
        .unwrap();

    mysql
        .execute("UPDATE users SET is_active=false WHERE id=7", ())
        .await
        .unwrap();
    assert!(
        !claim::reserve(&app, &command, &candidate, &prepared, "runner")
            .await
            .unwrap()
    );
    mysql
        .execute("UPDATE users SET is_active=true WHERE id=7", ())
        .await
        .unwrap();

    mysql.execute(
        "UPDATE resource_members SET role='Viewer' WHERE resource_type='Workspace' AND entity_id='7'",
        (),
    ).await.unwrap();
    assert!(
        !claim::reserve(&app, &command, &candidate, &prepared, "runner")
            .await
            .unwrap()
    );
    mysql.execute(
        "UPDATE resource_members SET role='Developer' WHERE resource_type='Workspace' AND entity_id='7'",
        (),
    ).await.unwrap();
    // A direct project Viewer role overrides the inherited Developer role.
    mysql.execute(
        "INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CloudProject',1001,'user','7','approved','Viewer')",
        (),
    ).await.unwrap();
    assert!(
        !claim::reserve(&app, &command, &candidate, &prepared, "runner")
            .await
            .unwrap()
    );
    mysql.execute(
        "DELETE FROM resource_members WHERE resource_type='CloudProject' AND resource_id=1001 AND entity_type='user' AND entity_id='7'",
        (),
    ).await.unwrap();
    mysql
        .execute(
            "UPDATE resource_members SET status='revoked' WHERE resource_type='Device'",
            (),
        )
        .await
        .unwrap();
    assert!(
        !claim::reserve(&app, &command, &candidate, &prepared, "runner")
            .await
            .unwrap()
    );

    let saved: MysqlRow = mysql
        .fetch_one(
            "SELECT status, version FROM loop_item_executions WHERE id=?",
            (candidate.id,),
        )
        .await
        .unwrap();
    assert_eq!(saved.get_required::<String>("status").unwrap(), "queued");
    assert_eq!(
        saved.get_required::<i64>("version").unwrap(),
        candidate.version
    );

    // The legacy Agent can still use its owner's workspace-granted runner.
    // A disabled runner must nevertheless be rejected during reservation.
    mysql.execute(
        "UPDATE resource_members SET status='approved' WHERE resource_type='Device' AND entity_type='workspace'",
        (),
    ).await.unwrap();
    mysql
        .execute("UPDATE kinds SET is_active=false WHERE id=2002", ())
        .await
        .unwrap();
    assert!(
        !claim::reserve(&app, &command, &candidate, &prepared, "runner")
            .await
            .unwrap()
    );
    mysql
        .execute("UPDATE kinds SET is_active=true WHERE id=2002", ())
        .await
        .unwrap();
    assert!(
        claim::reserve(&app, &command, &candidate, &prepared, "runner")
            .await
            .unwrap()
    );
    let reserved = unconfirmed_claim(&app, &command).await.unwrap().unwrap();
    assert_eq!(reserved.id, candidate.id);
    assert_eq!(reserved.runtime_task_id, prepared.runtime_task_id);
    verify_cleanup_intents(&app).await;
}

async fn verify_cleanup_intents(app: &AppState) {
    app.mysql.execute(
        "INSERT INTO loop_items (id, resource_type, loop_item_id, status, version, task_user_id, device_id, metadata, due_at, updated_at)
         VALUES ('cleanup-1','workspace_cleanup','issue-4','pending',2,7,'runner',JSON_OBJECT('runtime_task_ids',JSON_ARRAY('task-4')),UTC_TIMESTAMP(6) - INTERVAL 1 HOUR,'2020-01-01'),
                ('cleanup-2','workspace_cleanup','issue-4','cancelled',3,7,'runner',JSON_OBJECT(),NULL,'2020-01-02'),
                ('cleanup-3','workspace_cleanup','issue-4','pending',4,7,'runner',JSON_OBJECT(),UTC_TIMESTAMP(6) + INTERVAL 1 HOUR,'2020-01-03'),
                ('cleanup-4','workspace_cleanup','issue-4','cancelled',5,7,'other-runner',JSON_OBJECT(),NULL,'2020-01-04')",
        (),
    ).await.unwrap();
    assert_eq!(
        pull_due(app, 7, "runner").await.unwrap(),
        vec![
            json!({"intent_id":"cleanup-1", "issue_id":"issue-4", "issue_version":2, "action":"release", "runtime_task_ids":["task-4"]}),
            json!({"intent_id":"cleanup-2", "issue_id":"issue-4", "issue_version":3, "action":"retain", "runtime_task_ids":[]}),
        ],
    );
}

async fn seed_pull_schema(mysql: &MysqlService) {
    for sql in [
        "ALTER TABLE users ADD user_name TEXT, ADD password_hash TEXT, ADD email TEXT, ADD git_info TEXT, ADD role TEXT, ADD auth_source TEXT, ADD preferences TEXT, ADD created_at DATETIME, ADD updated_at DATETIME",
        "ALTER TABLE kinds ADD namespace VARCHAR(64) NOT NULL DEFAULT 'default', ADD created_at DATETIME, ADD updated_at DATETIME",
        "ALTER TABLE resource_members ADD entity_display_name TEXT, ADD user_id BIGINT, ADD invited_by_user_id BIGINT, ADD share_link_id BIGINT, ADD reviewed_by_user_id BIGINT, ADD reviewed_at DATETIME, ADD copied_resource_id BIGINT, ADD requested_at DATETIME, ADD created_at DATETIME, ADD updated_at DATETIME",
        "INSERT INTO kinds (id,user_id,name,kind,namespace,is_active,json) VALUES (2002,7,'runner','Device','default',true,JSON_OBJECT('spec',JSON_OBJECT('runtimeInstanceId','runtime')))",
        "INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('Device',2002,'workspace','2001','approved','Developer'),('Device',2002,'project','1001','approved','Developer')",
        "INSERT INTO loop_items (id,resource_type,cloud_project_id,status,created_by_user_id,metadata) VALUES ('101','chat_agent','1001','active',7,JSON_OBJECT('device_id','runner'))",
    ] {
        mysql.execute(sql, ()).await.unwrap();
    }

    let columns: Vec<_> = crate::loop_tasks::loop_repository::EXECUTION_COLUMNS
        .split(',')
        .map(|column| {
            let name = column.trim().split_once(" AS ").unwrap().0;
            let name = name.strip_prefix("loop_item_executions.").unwrap();
            let data_type = match name {
                "id" => "BIGINT PRIMARY KEY",
                "executor_owner_user_id"
                | "assigner_user_id"
                | "team_id"
                | "version"
                | "priority_weight" => "BIGINT",
                "queued_at" | "start_requested_at" | "completed_at" | "claimed_at"
                | "heartbeat_at" | "lease_expires_at" => "DATETIME",
                _ => "TEXT",
            };
            format!("{name} {data_type}")
        })
        .collect();
    mysql
        .execute(
            format!(
                "CREATE TABLE loop_item_executions ({}) ENGINE=InnoDB",
                columns.join(",")
            ),
            (),
        )
        .await
        .unwrap();
}

async fn seed_candidates(mysql: &MysqlService) {
    for (id, actor, project) in [
        (1, 9, "1001"),
        (2, 7, "1001"),
        (3, 9, "1001"),
        (4, 7, "1001"),
        (5, 8, "1001"),
        (6, 7, "1002"),
    ] {
        let issue = format!("issue-{id}");
        mysql.execute(
            "INSERT INTO loop_items (id,resource_type,cloud_project_id,metadata) VALUES (?,'task',?,JSON_OBJECT('runner_binding',JSON_OBJECT('environment_id',2002)))",
            (issue.as_str(), project),
        ).await.unwrap();
        mysql.execute(
            "INSERT INTO loop_item_executions (id,loop_item_id,cloud_project_id,executor_owner_user_id,assigner_user_id,agent_id,team_id,automation_run_id,execution_environment,execution_device_id,runtime_device_id,runtime_task_id,status,approval_status,execution_payload,error_message,execution_note,version,execution_scope,priority_weight) VALUES (?,?,?,7,?,'101',0,'','local','runner','','','queued','','{}','','',1,'',0)",
            (id, issue, project, actor),
        ).await.unwrap();
    }
    mysql
        .execute(
            "UPDATE loop_items SET metadata=JSON_OBJECT() WHERE id='issue-5'",
            (),
        )
        .await
        .unwrap();
    mysql
        .execute(
            "UPDATE loop_item_executions SET execution_scope='occupied' WHERE id=2",
            (),
        )
        .await
        .unwrap();
    mysql.execute("INSERT INTO loop_item_executions (id,execution_scope,status) VALUES (7,'occupied','running')", ()).await.unwrap();
}
