//! Exercise current-fact permission reads in the existing real MySQL CI fixture.
use super::project_authority::lock_project_edits;
use brz_mysql::{MysqlResult, MysqlService};

async fn authorize(mysql: &MysqlService) -> MysqlResult<()> {
    mysql
        .with_transaction(async |tx| lock_project_edits(tx, &[1001].into_iter().collect(), 7).await)
        .await
}

async fn denied(mysql: &MysqlService, code: u16) {
    let error = authorize(mysql).await.unwrap_err().to_string();
    assert!(error.contains(&format!("chat-group:{code}:")), "{error}");
}

pub(crate) async fn verify_project_classification_facts(mysql: &MysqlService) {
    authorize(mysql).await.unwrap();
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CloudProject',1001,'user','7','approved','Viewer')",()).await.unwrap();
    denied(mysql, 403).await;
    mysql.execute("UPDATE resource_members SET role='Maintainer' WHERE resource_type='Workspace' AND resource_id=2001 AND entity_id='7'",()).await.unwrap();
    authorize(mysql).await.unwrap();
    mysql.execute("DELETE FROM resource_members WHERE resource_type='Workspace' AND resource_id=2001 AND entity_id='7'",()).await.unwrap();
    denied(mysql, 403).await;
    mysql.execute("UPDATE resource_members SET role='Developer' WHERE resource_type='CloudProject' AND resource_id=1001 AND entity_type='user' AND entity_id='7'",()).await.unwrap();
    authorize(mysql).await.unwrap();
    mysql
        .execute("UPDATE users SET is_active=0 WHERE id=7", ())
        .await
        .unwrap();
    denied(mysql, 404).await;
    mysql
        .execute("UPDATE users SET is_active=1 WHERE id=7", ())
        .await
        .unwrap();
    mysql
        .execute("UPDATE kinds SET is_active=0 WHERE id=2001", ())
        .await
        .unwrap();
    denied(mysql, 404).await;
    mysql
        .execute("UPDATE kinds SET is_active=1 WHERE id=2001", ())
        .await
        .unwrap();
    mysql
        .execute(
            "UPDATE loop_items SET status='archived' WHERE id='1001'",
            (),
        )
        .await
        .unwrap();
    denied(mysql, 404).await;
    mysql.execute("UPDATE loop_items SET status='active',deleted_at='1970-01-01 00:00:01' WHERE id='1001'",()).await.unwrap();
    authorize(mysql).await.unwrap();
    mysql
        .execute(
            "UPDATE loop_items SET deleted_at='2026-11-11' WHERE id='1001'",
            (),
        )
        .await
        .unwrap();
    denied(mysql, 404).await;
    mysql.execute("UPDATE loop_items SET deleted_at=NULL,metadata=JSON_OBJECT('membership_mode',CAST('null' AS JSON)) WHERE id='1001'",()).await.unwrap();
    mysql.execute("DELETE FROM resource_members WHERE resource_type='CloudProject' AND resource_id=1001 AND entity_type='user' AND entity_id='7'",()).await.unwrap();
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('Workspace',2001,'user','7','approved','Developer')",()).await.unwrap();
    authorize(mysql).await.unwrap();
    mysql.execute("UPDATE loop_items SET metadata=JSON_OBJECT('membership_mode','restricted') WHERE id='1001'",()).await.unwrap();
    denied(mysql, 404).await;
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CloudProject',1001,'authenticated_users','*','approved','Developer')",()).await.unwrap();
    denied(mysql, 403).await;
}
