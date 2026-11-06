//! Actual transaction/queue persistence; resource admission is covered separately.
use super::*;
use brz_mysql::MysqlService;

async fn issue(mysql: &MysqlService, id: &str) -> store::Node {
    mysql.execute("INSERT INTO loop_items (id,resource_type,cloud_project_id,title,status,metadata,version,created_by_user_id) VALUES (?,'task','1001','Shared work','inbox',JSON_OBJECT(),1,7)",(id,)).await.unwrap();
    store::get(mysql, "task", id).await.unwrap().unwrap()
}

fn assignment(mut issue: store::Node, context: &Value) -> groups::GroupAssignment {
    let group = json!({"id":"101","name":"Team","version":1,"leader":{"kind":"agent","id":"leader"},"members":[]});
    issue.metadata.0["collaboration_group"] = json!({"id":"101","name":"Team"});
    issue.metadata.0["collaboration_group_assignment_key"] = json!("assignment-key");
    let admission = queue::Admission {
        owner: 7,
        assigner: 7,
        agent_id: String::new(),
        team_id: 0,
        environment: "local".into(),
        device_id: "project-runner".into(),
        context: json!({"project_coordination":context,"collaboration_group":group,"dispatch_role":"manager"}),
        runtime_selection: json!({"executor_kind":"collaboration_group_dispatch"}),
        config: json!({}),
        requires_approval: false,
        waiting_runtime: false,
    };
    groups::GroupAssignment {
        automation: Value::Null,
        issue,
        group,
        key: "assignment-key".into(),
        actor: 7,
        admission: Some(admission),
    }
}

async fn transact(
    mysql: &MysqlService,
    project: &store::Node,
    plan: &groups::GroupAssignment,
    context: &Value,
    command: &str,
    digest: &str,
) -> Result<Value, FastApiError> {
    let scope = command_scope(&project.id, "101", command).unwrap();
    commit_command(mysql, project, plan, context, &scope, digest, command).await
}

async fn count(mysql: &MysqlService) -> i64 {
    let row: brz_mysql::MysqlRow = mysql
        .fetch_one("SELECT COUNT(*) AS count FROM loop_item_executions", ())
        .await
        .unwrap();
    row.get_required("count").unwrap()
}

pub(crate) async fn verify_dispatch_transactions(mysql: &MysqlService) {
    mysql.execute("CREATE TABLE loop_item_executions (id BIGINT AUTO_INCREMENT PRIMARY KEY,loop_item_id VARCHAR(64),cloud_project_id VARCHAR(64),executor_owner_user_id BIGINT,agent_id VARCHAR(64),team_id BIGINT,automation_run_id VARCHAR(64),execution_environment VARCHAR(30),execution_device_id VARCHAR(128),assigner_user_id BIGINT,status VARCHAR(30),priority_weight BIGINT,queued_at DATETIME(6),attempt_no BIGINT,previous_execution_id BIGINT,execution_scope VARCHAR(255),execution_note TEXT,approval_status VARCHAR(30),execution_payload TEXT,error_message TEXT,max_retries BIGINT,observed_state VARCHAR(30),sync_state VARCHAR(30),runtime_task_id VARCHAR(128),updated_at DATETIME(6),INDEX(execution_scope)) ENGINE=InnoDB",()).await.unwrap();
    mysql
        .execute(
            "ALTER TABLE kinds ADD COLUMN namespace VARCHAR(100) DEFAULT 'default',ADD COLUMN created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6),ADD COLUMN updated_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)",
            (),
        )
        .await
        .unwrap();
    mysql.execute("INSERT INTO kinds (id,user_id,name,kind,is_active,json,namespace) VALUES (101,7,'Team','CollaborationGroup',true,JSON_OBJECT('status',JSON_OBJECT('version',1),'spec',JSON_OBJECT('leader',JSON_OBJECT('kind','agent','id','leader'),'members',JSON_ARRAY())),'projects/1001')",()).await.unwrap();
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CollaborationGroup',101,'project','1001','approved','Developer'),('Workspace',2001,'project_agent','leader','approved','Developer'),('Device',41,'workspace','2001','approved','Developer'),('Device',41,'project','1001','approved','Developer')",()).await.unwrap();
    mysql.execute("INSERT INTO loop_items (id,resource_type,cloud_project_id,status,metadata,created_by_user_id,version) VALUES ('leader','chat_agent','1001','active',JSON_OBJECT('authorization_version',2,'visibility','creator_admin'),7,1)",()).await.unwrap();
    for (id, name) in [(40, "device"), (41, "project-runner")] {
        mysql.execute("INSERT INTO kinds (id,user_id,name,kind,is_active,json,namespace) VALUES (?,7,?,'Device',true,?,'default')",(id,name,Json(json!({"spec":{"deviceType":"local","deviceId":name}})))).await.unwrap();
    }
    let enabled = persist_binding(
        mysql,
        7,
        "1001",
        "101",
        "device",
        &json!({"enabled":true,"expectedGeneration":null}),
    )
    .await
    .unwrap();
    let project = store::get(mysql, "project", "1001").await.unwrap().unwrap();
    let mut context = json!({"projectId":"1001","groupId":"101","userId":7,"deviceId":"device","generation":enabled["binding"]["generation"],"groupVersion":1,"inputDigest":"digest"});

    let resource_plan = assignment(issue(mysql, "ISSUE-RESOURCES").await, &context);
    mysql
        .with_transaction(async |tx| {
            let mut query = &mut *tx;
            let group =
                groups::authorize_snapshot_on(&mut query, &project.id, &resource_plan.group, 7)
                    .await;
            assert!(group.is_ok(), "Group authorization baseline: {group:?}");
            let binding = require_execution_binding_on(
                &mut query,
                &project.id,
                7,
                &json!({"project_coordination":context}),
            )
            .await;
            assert!(
                binding.is_ok(),
                "Binding authorization baseline: {binding:?}"
            );
            let mut plan = resource_plan.admission.as_ref().unwrap().clone();
            let device = queue::prepare_on(&mut query, &resource_plan.issue, &mut plan).await;
            assert!(device.is_ok(), "Runner authorization baseline: {device:?}");
            Ok(())
        })
        .await
        .unwrap();
    for statement in [
        "UPDATE resource_members SET status='rejected' WHERE resource_type='CollaborationGroup' AND resource_id=101",
        "UPDATE resource_members SET status='rejected' WHERE resource_type='Device' AND resource_id=41 AND entity_type='project'",
        "UPDATE kinds SET is_active=false WHERE id=40",
    ] {
        mysql.execute(statement, ()).await.unwrap();
        assert_eq!(
            transact(
                mysql,
                &project,
                &resource_plan,
                &context,
                "resources",
                "digest"
            )
            .await
            .unwrap_err()
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            store::get(mysql, "task", "ISSUE-RESOURCES")
                .await
                .unwrap()
                .unwrap()
                .version,
            1
        );
        assert_eq!(count(mysql).await, 0);
        mysql.execute("UPDATE resource_members SET status='approved' WHERE resource_type IN ('CollaborationGroup','Device')",()).await.unwrap();
        mysql
            .execute("UPDATE kinds SET is_active=true WHERE id=40", ())
            .await
            .unwrap();
    }

    let changed_group = assignment(issue(mysql, "ISSUE-GROUP").await, &context);
    mysql
        .execute(
            "UPDATE kinds SET json=JSON_SET(json,'$.status.version',2) WHERE id=101",
            (),
        )
        .await
        .unwrap();
    assert_eq!(
        transact(
            mysql,
            &project,
            &changed_group,
            &context,
            "group-changed",
            "digest"
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        store::get(mysql, "task", "ISSUE-GROUP")
            .await
            .unwrap()
            .unwrap()
            .version,
        1
    );
    assert_eq!(count(mysql).await, 0);
    mysql
        .execute(
            "UPDATE kinds SET json=JSON_SET(json,'$.status.version',1) WHERE id=101",
            (),
        )
        .await
        .unwrap();

    let changed_issue = assignment(issue(mysql, "ISSUE-EDIT").await, &context);
    mysql.execute("UPDATE loop_items SET description='Concurrent human edit',version=2 WHERE id='ISSUE-EDIT'",()).await.unwrap();
    assert_eq!(
        transact(
            mysql,
            &project,
            &changed_issue,
            &context,
            "issue-changed",
            "digest"
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::CONFLICT
    );
    let current = store::get(mysql, "task", "ISSUE-EDIT")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.description, "Concurrent human edit");
    assert_eq!(current.status, "inbox");
    assert_eq!(count(mysql).await, 0);

    let rollback = assignment(issue(mysql, "ISSUE-ROLLBACK").await, &context);
    mysql.execute("ALTER TABLE loop_item_executions ADD CONSTRAINT reject_command CHECK(execution_scope <> 'coordination:1001:101:rollback')",()).await.unwrap();
    assert_eq!(
        transact(mysql, &project, &rollback, &context, "rollback", "digest")
            .await
            .unwrap_err()
            .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    mysql
        .execute(
            "ALTER TABLE loop_item_executions DROP CHECK reject_command",
            (),
        )
        .await
        .unwrap();
    let current = store::get(mysql, "task", "ISSUE-ROLLBACK")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.version, 1);
    assert_eq!(current.status, "inbox");
    assert!(current.metadata.0["collaboration_group"].is_null());
    assert_eq!(count(mysql).await, 0);

    let plan = assignment(issue(mysql, "ISSUE-ACCEPT").await, &context);
    let (a, b) = tokio::join!(
        transact(mysql, &project, &plan, &context, "accept", "digest"),
        transact(mysql, &project, &plan, &context, "accept", "digest")
    );
    let first = a.unwrap();
    assert_eq!(first, b.unwrap());
    assert_eq!(count(mysql).await, 1);
    let row = store::get(mysql, "task", "ISSUE-ACCEPT")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.version, 2);
    assert_eq!(row.metadata.0["read_revisions"]["7"], 2);
    assert_eq!(row.metadata.0["collaboration_group"]["id"], "101");
    let receipt:brz_mysql::MysqlRow=mysql.fetch_one("SELECT automation_run_id,assigner_user_id,executor_owner_user_id FROM loop_item_executions",()).await.unwrap();
    assert_eq!(
        receipt.get_required::<String>("automation_run_id").unwrap(),
        ""
    );
    assert_eq!(receipt.get_required::<i64>("assigner_user_id").unwrap(), 7);
    assert_eq!(
        receipt
            .get_required::<i64>("executor_owner_user_id")
            .unwrap(),
        7
    );
    assert_eq!(
        transact(mysql, &project, &plan, &context, "accept", "changed-input")
            .await
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );

    persist_binding(
        mysql,
        7,
        "1001",
        "101",
        "device",
        &json!({"enabled":false,"expectedGeneration":enabled["binding"]["generation"]}),
    )
    .await
    .unwrap();
    assert_eq!(
        transact(mysql, &project, &plan, &context, "accept", "digest")
            .await
            .unwrap(),
        first
    );
    let next = assignment(issue(mysql, "ISSUE-AFTER-STOP").await, &context);
    assert_eq!(
        transact(mysql, &project, &next, &context, "old-generation", "digest")
            .await
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );
    context["generation"] = json!("unissued-generation");
    assert_eq!(
        transact(
            mysql,
            &project,
            &next,
            &context,
            "forged-generation",
            "digest"
        )
        .await
        .unwrap_err()
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(count(mysql).await, 1);
}
