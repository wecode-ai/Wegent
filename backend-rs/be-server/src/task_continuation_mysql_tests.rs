// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use crate::task_continuation::continuation_for;
use brz_mysql::Json;
use brz_mysql::MysqlService;
use serde_json::json;

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated schema"]
async fn task_continuation_requires_the_original_owner_and_execution_device() -> anyhow::Result<()>
{
    crate::migrations::mysql_tests::isolated(verify).await
}

async fn verify(mysql: &MysqlService) -> anyhow::Result<()> {
    crate::migrations::upgrade(mysql).await?;
    let state = crate::app_test_support::app(mysql.clone());
    mysql.execute("INSERT INTO tasks (id,user_id,kind,name,namespace,json,is_active,created_at,updated_at,project_id,is_group_chat) \
        VALUES (12,7,'Task','example','default',JSON_OBJECT('spec',JSON_OBJECT('device_id','app-record-10','title','Example')),1,NOW(),NOW(),0,0)", ()).await?;
    mysql.execute("INSERT INTO kinds (id,user_id,kind,name,namespace,json,is_active,created_at,updated_at) \
        VALUES (10,7,'Device','desktop','default',JSON_OBJECT('spec',JSON_OBJECT('deviceType','app')),1,NOW(),NOW())", ()).await?;
    mysql.execute("INSERT INTO subtasks (id,user_id,task_id,team_id,title,bot_ids,`role`,executor_namespace,executor_name,executor_deleted_at, \
        message_id,status,progress,created_at,updated_at,completed_at,sender_type,sender_user_id,reply_to_subtask_id,result) \
        VALUES (42,7,12,1,'','[9]','ASSISTANT','user-7','device-app-record-10',0,2,'COMPLETED',100,NOW(),NOW(),NOW(),'TEAM',0,0,?)",
        (Json(json!({"executor_session":{"agent":"Codex","botId":"9","threadId":"native-42"}})),)).await?;
    assert_eq!(
        continuation_for(&state, 12, 7).await.unwrap(),
        json!({
            "team_id":1,"model_id":null,"model_type":null,"model_options":null,
            "user_id":7,"task_id":12,"device_id":"app-record-10","shell_type":"Codex","thread_id":"native-42","title":"Example","workspace_path":""
        })
    );
    assert_eq!(
        continuation_for(&state, 12, 8).await.unwrap_err().status(),
        brz_http_server::StatusCode::NOT_FOUND
    );
    mysql
        .execute("UPDATE tasks SET json=JSON_OBJECT() WHERE id=12", ())
        .await?;
    assert_eq!(
        continuation_for(&state, 12, 7).await.unwrap_err().status(),
        brz_http_server::StatusCode::NOT_FOUND
    );
    mysql.execute("UPDATE tasks SET json=JSON_OBJECT('spec', JSON_OBJECT('device_id','app-record-10')) WHERE id=12", ()).await?;
    for mutation in [
        "UPDATE subtasks SET executor_name='device-another' WHERE id=42",
        "UPDATE subtasks SET executor_name='device-app-record-10', executor_namespace='user-8' WHERE id=42",
        "UPDATE subtasks SET executor_namespace='user-7', result=JSON_OBJECT() WHERE id=42",
    ] {
        mysql.execute(mutation, ()).await?;
        assert_eq!(
            continuation_for(&state, 12, 7).await.unwrap_err().status(),
            brz_http_server::StatusCode::NOT_FOUND
        );
    }
    Ok(())
}
