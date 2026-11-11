//! Group recovery retains the original project policy and reads fresh group facts.
use super::cloud_context_group::{authority, permissions, projection};
use super::loop_repository::CloudContextBindingRow;

fn binding() -> CloudContextBindingRow {
    CloudContextBindingRow {
        id: "binding".into(),
        cloud_project_id: "9001".into(),
        loop_item_id: Some("9002".into()),
        task_user_id: 7,
        device_id: "device".into(),
        task_id: "private-task".into(),
        task_title: None,
        backend_task_id: None,
        linked_by_user_id: 7,
        linked_at: None,
        unlinked_at: None,
        metadata: None,
    }
}

#[test]
fn group_permissions_keep_reading_participation_and_execution_separate() {
    for role in ["Owner", "Maintainer", "Developer", "Viewer"] {
        for active in [false, true] {
            for joined in [false, true] {
                for status in ["pending", "completed", "cancelled", "archived"] {
                    let actual = permissions(role, active, joined, status);
                    let write = active && role != "Viewer";
                    assert_eq!(actual.edit_content, write);
                    assert_eq!(actual.assign, write);
                    assert_eq!(actual.comment, write && joined);
                    assert_eq!(actual.execute, write && joined && status == "pending");
                }
            }
        }
    }
    let unknown = permissions("Reporter", true, true, "pending");
    assert!(!unknown.execute && !unknown.assign && !unknown.comment && !unknown.edit_content);
}

pub(crate) async fn verify_current_group_context(mysql: &brz_mysql::MysqlService) {
    mysql.execute("INSERT INTO loop_items (id,resource_type,status,name,description,project_key,metadata,version,created_by_user_id,created_at,updated_at) VALUES ('9001','chat_group','active','Independent group','','G9001',JSON_OBJECT(),1,7,UTC_TIMESTAMP(),UTC_TIMESTAMP())",()).await.unwrap();
    mysql.execute("INSERT INTO loop_items (id,resource_type,cloud_project_id,status,metadata,version) VALUES ('9002','task','9001','pending',JSON_OBJECT(),1)",()).await.unwrap();
    let binding = binding();
    // A workspace/project grant deliberately provides no authority to the group.
    assert_eq!(
        authority(mysql, &binding, 7)
            .await
            .err()
            .unwrap()
            .status()
            .as_u16(),
        404
    );
    mysql.execute("INSERT INTO resource_members (resource_type,resource_id,entity_type,entity_id,status,role) VALUES ('CollaborationChatGroup',9001,'user','7','approved','Developer')",()).await.unwrap();
    let (group, id, joined) = authority(mysql, &binding, 7).await.unwrap().unwrap();
    assert_eq!(id, "9002");
    assert!(!joined);
    let view = projection(&group, 7).unwrap();
    assert_eq!(view["resource_type"], "chat_group");
    assert_eq!(view["id"], "9001");
    assert_eq!(view["current_user_id"], 7);
    assert_eq!(view["access_role"], "Developer");
    mysql.execute("INSERT INTO loop_items (id,resource_type,parent_id,user_id,status) VALUES ('9003','thread_participant','9002',7,'active')",()).await.unwrap();
    assert!(authority(mysql, &binding, 7).await.unwrap().unwrap().2);
    assert_eq!(
        authority(mysql, &binding, 8)
            .await
            .err()
            .unwrap()
            .status()
            .as_u16(),
        404
    );
    mysql.execute("UPDATE resource_members SET role='Viewer' WHERE resource_type='CollaborationChatGroup' AND resource_id=9001 AND entity_id='7'",()).await.unwrap();
    let (group, _, joined) = authority(mysql, &binding, 7).await.unwrap().unwrap();
    assert!(!permissions(&group.role, true, joined, "pending").execute);
    mysql.execute("UPDATE resource_members SET status='rejected' WHERE resource_type='CollaborationChatGroup' AND resource_id=9001 AND entity_id='7'",()).await.unwrap();
    assert_eq!(
        authority(mysql, &binding, 7)
            .await
            .err()
            .unwrap()
            .status()
            .as_u16(),
        404
    );
    mysql.execute("UPDATE resource_members SET status='approved',role='Developer',entity_id='07' WHERE resource_type='CollaborationChatGroup' AND resource_id=9001",()).await.unwrap();
    assert_eq!(
        authority(mysql, &binding, 7)
            .await
            .err()
            .unwrap()
            .status()
            .as_u16(),
        404
    );
    mysql.execute("UPDATE resource_members SET entity_id='7' WHERE resource_type='CollaborationChatGroup' AND resource_id=9001",()).await.unwrap();
    mysql
        .execute("UPDATE users SET is_active=false WHERE id=7", ())
        .await
        .unwrap();
    assert_eq!(
        authority(mysql, &binding, 7)
            .await
            .err()
            .unwrap()
            .status()
            .as_u16(),
        404
    );
    mysql
        .execute("UPDATE users SET is_active=true WHERE id=7", ())
        .await
        .unwrap();
    mysql
        .execute(
            "UPDATE loop_items SET deleted_at=UTC_TIMESTAMP() WHERE id='9002'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(
        authority(mysql, &binding, 7)
            .await
            .err()
            .unwrap()
            .status()
            .as_u16(),
        404
    );
    mysql
        .execute(
            "UPDATE loop_items SET deleted_at=NULL,cloud_project_id='1001' WHERE id='9002'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(
        authority(mysql, &binding, 7)
            .await
            .err()
            .unwrap()
            .status()
            .as_u16(),
        404
    );
    mysql
        .execute(
            "UPDATE loop_items SET cloud_project_id='9001' WHERE id='9002'",
            (),
        )
        .await
        .unwrap();
    mysql
        .execute(
            "UPDATE loop_items SET status='archived' WHERE id='9001'",
            (),
        )
        .await
        .unwrap();
    let (group, _, joined) = authority(mysql, &binding, 7).await.unwrap().unwrap();
    assert!(!permissions(&group.role, false, joined, "pending").execute);
    mysql
        .execute(
            "UPDATE loop_items SET deleted_at=UTC_TIMESTAMP() WHERE id='9001'",
            (),
        )
        .await
        .unwrap();
    assert_eq!(
        authority(mysql, &binding, 7)
            .await
            .err()
            .unwrap()
            .status()
            .as_u16(),
        404
    );
    let mut project_binding = binding;
    project_binding.cloud_project_id = "1001".into();
    assert!(
        authority(mysql, &project_binding, 7)
            .await
            .unwrap()
            .is_none()
    );
}
