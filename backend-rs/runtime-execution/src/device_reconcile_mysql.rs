use super::*;

pub async fn verify_reconnect_projection(
    mysql: &brz_mysql::MysqlService,
    activities: &impl ProjectionActivities<brz_mysql::MysqlTransactionService>,
) -> anyhow::Result<()> {
    const PROJECT: &str = "reconnect-fixture-project";
    const ISSUE: &str = "reconnect-fixture-issue";
    const AGENT: &str = "reconnect-fixture-agent";
    mysql.execute(
        "INSERT INTO loop_items(id, resource_type, description, metadata, created_at, updated_at) VALUES (?, 'project', '', JSON_OBJECT(), NOW(), NOW())",
        (PROJECT,),
    ).await?;
    mysql.execute(
        "INSERT INTO loop_items(id, resource_type, cloud_project_id, title, description, metadata, status, assignee_agent_id, created_at, updated_at) VALUES (?, 'task', ?, 'Reconnect issue', '', JSON_OBJECT(), 'in_progress', ?, NOW(), NOW()), (?, 'chat_agent', ?, 'Reconnect agent', '', JSON_OBJECT(), 'active', '', NOW(), NOW())",
        (ISSUE, PROJECT, AGENT, AGENT, PROJECT),
    ).await?;
    let inserted = mysql.execute(
        "INSERT INTO loop_item_executions(loop_item_id, cloud_project_id, agent_id, executor_owner_user_id, status, observed_state, runtime_device_id, runtime_task_id, execution_payload, error_message) VALUES (?, ?, ?, 7, 'running', 'running', 'fixture-device', 'fixture-conversation', '{}', '')",
        (ISSUE, PROJECT, AGENT),
    ).await?;
    let execution_id = inserted.last_insert_id as i64;
    let pending: Vec<ExecutionRow> = mysql
        .fetch_all(reconcile_statement(true), (7_i64, "fixture-device", 0_i64))
        .await?;
    assert!(pending.is_empty());
    let reconnecting: Vec<ExecutionRow> = mysql
        .fetch_all(reconcile_statement(false), (7_i64, "fixture-device", 0_i64))
        .await?;
    assert_eq!(
        reconcile_execution_refs(&reconnecting),
        [(execution_id, "fixture-conversation".into())]
    );

    mysql.execute(
        "UPDATE loop_items SET metadata=JSON_OBJECT('ai_state', JSON_OBJECT('run_id', 'fixture-run', 'status', 'running', 'project_chat_message_id', 'missing-activity', 'runtime_task_id', 'fixture-conversation')) WHERE id=?",
        (ISSUE,),
    ).await?;
    let effects = mysql
        .with_transaction(async |tx| {
            let devices = ["fixture-device".to_owned()];
            let matched = runtime_projection::execution_for_runtime(
                tx,
                &devices,
                "fixture-conversation",
                Some(7),
                false,
            )
            .await?
            .expect("the Runtime lookup resolves the owned execution");
            assert_eq!(matched.id, execution_id);
            assert_eq!(matched.loop_item_id.as_deref(), Some(ISSUE));
            assert!(
                runtime_projection::execution_for_runtime(
                    tx,
                    &devices,
                    "fixture-conversation",
                    Some(8),
                    false,
                )
                .await?
                .is_none()
            );
            let execution = runtime_projection::reload_execution(tx, execution_id)
                .await?
                .unwrap();
            assert!(
                runtime_projection::linked_activity(tx, &execution)
                    .await?
                    .is_none()
            );
            let snapshots = reported_snapshots(&json!({"success": true, "workspaces": [{"tasks": [
                {"taskId": "fixture-conversation", "status": "completed", "running": false}
            ]}]}))
            .unwrap();
            let status = truthy_text(snapshots["fixture-conversation"].get("status"));
            apply_snapshot(tx, activities, &execution, &status, false, None).await
        })
        .await?
        .expect("the snapshot wins the terminal transition");
    assert!(effects.changed);
    assert_eq!(
        effects.matched.as_ref().unwrap().status_or_empty(),
        "completed"
    );
    assert_eq!(effects.messages.len(), 1);
    assert_eq!(effects.messages[0].status, "completed");
    assert_eq!(effects.messages[0].metadata.0["run_id"], "fixture-run");
    assert!(effects.messages[0].metadata.0["runtime_completed_at"].is_string());
    let issue = crate::project_store::get(mysql, "task", ISSUE)
        .await?
        .unwrap();
    assert_eq!(issue.status, "in_review");
    assert_eq!(issue.metadata.0["ai_state"]["status"], "completed");

    let repeat = mysql
        .with_transaction(async |tx| {
            let execution = runtime_projection::reload_execution(tx, execution_id)
                .await?
                .unwrap();
            let activity = runtime_projection::linked_activity(tx, &execution)
                .await?
                .unwrap();
            assert_eq!(activity.message_id, effects.messages[0].message_id);
            assert_eq!(activity.status, "completed");
            apply_snapshot(tx, activities, &execution, "completed", false, None).await
        })
        .await?;
    assert!(
        repeat.is_none(),
        "duplicate snapshots must not produce lifecycle effects"
    );
    Ok(())
}
