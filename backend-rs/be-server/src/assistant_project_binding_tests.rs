//! Project adoption on the shared, isolated MySQL permissions fixture.
use super::*;
use crate::assistant_shares::mysql_tests::{team, user};

pub(in crate::assistant_shares) async fn verify(state: &AppState) -> anyhow::Result<()> {
    let mysql = &state.mysql;
    mysql.execute("INSERT INTO kinds(id,user_id,name,kind,namespace,json,is_active) VALUES (8101,7103,'adoption-space','CollaborationWorkspace','default',JSON_OBJECT(),true)",()).await?;
    mysql.execute("INSERT INTO loop_items(created_at,updated_at,id,resource_type,description,status,metadata,cloud_project_id,created_by_user_id,name) VALUES (NOW(),NOW(),'8201','project','','active',JSON_OBJECT('membership_mode','direct'),'8201',7101,'Project'),(NOW(),NOW(),'8202','chat_agent','','active',JSON_OBJECT(),'8201',7103,'Project reviewer'),(NOW(),NOW(),'8203','chat_agent','','active',JSON_OBJECT('visibility','private'),'8201',7103,'Private reviewer')",()).await?;
    mysql.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,role,status,requested_at,created_at,updated_at) VALUES ('CloudProject',8201,'workspace','8101','Owner','approved',NOW(),NOW(),NOW()),('CloudProject',8201,'user','7101','Maintainer','approved',NOW(),NOW(),NOW()),('CloudProject',8201,'user','7102','Developer','approved',NOW(),NOW(),NOW())",()).await?;
    mysql.execute("INSERT INTO kinds(id,user_id,kind,namespace,name,json,is_active) VALUES (8102,7101,'Team','default','Review',?,TRUE),(8103,7101,'Bot','default','first',?,TRUE),(8104,7101,'Bot','default','second',?,TRUE),(8105,7101,'Ghost','default','first',?,TRUE),(8106,7101,'Ghost','default','second',?,TRUE),(8107,7101,'Shell','default','Codex',?,TRUE)",(
        Json(json!({"spec":{"collaborationModel":"pipeline","members":[{"botRef":{"name":"first"},"role":"leader","requireConfirmation":true},{"botRef":{"name":"second"},"role":"worker"}]}})),
        Json(json!({"metadata":{"displayName":"First"},"spec":{"ghostRef":{"name":"first"},"shellRef":{"name":"Codex"}}})),
        Json(json!({"metadata":{"displayName":"Second"},"spec":{"ghostRef":{"name":"second"},"shellRef":{"name":"Codex"}}})),
        Json(json!({"spec":{"systemPrompt":"Plan","mcpServers":{"project-only":{}}}})),Json(json!({"spec":{"systemPrompt":"Check"}})),Json(json!({"spec":{"shellType":"Codex"}})),
    )).await?;
    mysql.execute("UPDATE loop_items SET metadata=JSON_OBJECT('wegent_team_id','8102','runtime','wegent') WHERE id='8202'",()).await?;
    mysql.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,role,status,requested_at,created_at,updated_at) VALUES ('Team',8102,'workspace','8101','Developer','approved',NOW(),NOW(),NOW())",()).await?;
    let request = |id: &str| {
        let portable = serde_json::from_value(json!({
            "name":"Personal display name", "collaboration_model":"pipeline",
            "bot":[
                {"id":"first","name":"A personal display label","description":"Personal catalog description",
                 "shell_type":"Codex","role":"leader","system_prompt":"Plan","requireConfirmation":true},
                {"id":"second","name":"Second","shell_type":"Codex","role":"worker","system_prompt":"Check"}
            ]
        })).unwrap();
        Adoption {
            root: team("adopted", false),
            member_agent_ids: BTreeMap::from([("data".into(), id.into())]),
            member_team_definitions: BTreeMap::from([("data".into(), portable)]),
            member_source_team_ids: BTreeMap::new(),
            expected_revision: None,
        }
    };
    assert_eq!(
        adopt(state, user(7102), 8201, "adopted", request("8202"))
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        adopt(state, user(7101), 8201, "adopted", request("8203"))
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let mut unrelated_source = request("8202");
    unrelated_source
        .member_source_team_ids
        .insert("data".into(), 8102);
    assert_eq!(
        adopt(state, user(7101), 8201, "adopted", unrelated_source)
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    mysql.execute("INSERT INTO kinds(id,user_id,kind,namespace,name,json,is_active) VALUES (8310,7101,'Team','personal-assistant','account-review',?,TRUE),(8311,7101,'PersonalAssistantSettings','personal-assistant','primary',?,TRUE)",(
        Json(json!({"spec":{"members":[{"botRef":{"name":"first","namespace":"default"}},{"botRef":{"name":"second","namespace":"default"}}],"collaborationModel":"pipeline"}})),
        Json(json!({"spec":{"identities":[{"roleId":"data","teamRef":{"name":"account-review","namespace":"personal-assistant"}}]}}))
    )).await?;
    mysql.execute("INSERT INTO loop_items(created_at,updated_at,id,resource_type,description,status,metadata,cloud_project_id,created_by_user_id,name) VALUES (NOW(),NOW(),'8210','chat_agent','','active',JSON_OBJECT('runtime','wegent','wegent_team_id',8310),'8201',7103,'Renamed account actor')",()).await?;
    mysql.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,role,status,requested_at,created_at,updated_at) VALUES ('Team',8310,'workspace','8101','Developer','approved',NOW(),NOW(),NOW())",()).await?;
    let mut account = request("8210");
    account.root = team("account-roster", false);
    account.member_team_definitions.clear();
    account.member_source_team_ids.insert("data".into(), 8310);
    assert!(
        adopt(state, user(7101), 8201, "account-roster", account)
            .await
            .is_ok()
    );

    let mut wrong = request("8202");
    wrong.member_team_definitions.insert("data".into(),serde_json::from_value(json!({"name":"Review","collaboration_model":"solo","bot":[{"id":"first","name":"First","shell_type":"Codex"}]})).unwrap());
    assert_eq!(
        adopt(state, user(7101), 8201, "adopted", wrong)
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    let initial = || {
        let mut body = request("8202");
        body.expected_revision = Some(0);
        body
    };
    let bound = adopt(state, user(7101), 8201, "adopted", initial())
        .await
        .unwrap();
    let again = adopt(state, user(7101), 8201, "adopted", initial())
        .await
        .unwrap();
    assert_eq!(bound.group_id, again.group_id);
    assert_eq!(bound.publication_id, again.publication_id);
    let read_group = async || {
        mysql
            .fetch_one::<_, _, Json<Value>>(
                "SELECT json FROM kinds WHERE id=?",
                (bound.group_id.as_str(),),
            )
            .await
    };
    let doc = read_group().await?;
    assert_eq!(
        doc.0["spec"]["leader"],
        json!({"kind":"agent","id":"8202","name":"Project reviewer","responsibility":"Verify figures"})
    );
    assert_eq!(doc.0["status"]["version"], 1);
    let grants:i64=mysql.fetch_one("SELECT COUNT(*) FROM resource_members WHERE resource_type LIKE 'PersonalAssistant%' AND resource_id=? AND entity_type='user'",(bound.publication_id.as_str(),)).await?;
    assert_eq!(grants, 0);
    mysql
        .with_transaction(async |tx| {
            let source = storage::publication(tx, 7101, "team", "adopted")
                .await?
                .unwrap();
            storage::update_publication(tx, &source, &team("adopted", true)).await
        })
        .await?;
    assert_eq!(read_group().await?.0["status"]["state"], "binding_required");
    let authorize = async || {
        wegent_project_coordination::project_group_access::authorize(
            mysql,
            "8201",
            &bound.group_id,
            7101,
        )
        .await
    };
    assert!(authorize().await.is_err());
    mysql.execute("INSERT INTO loop_items(created_at,updated_at,id,resource_type,description,status,metadata,cloud_project_id,created_by_user_id,name) VALUES (NOW(),NOW(),'8204','chat_agent','','active',JSON_OBJECT('runtime','wegent','wegent_team_id',8102),'8201',7103,'Second project identity')",()).await?;
    let mut repaired = request("8202");
    repaired.root = team("adopted", true);
    repaired
        .member_agent_ids
        .insert("review".into(), "8204".into());
    repaired.member_team_definitions.insert(
        "review".into(),
        request("8204")
            .member_team_definitions
            .remove("data")
            .unwrap(),
    );
    let repaired = adopt(state, user(7101), 8201, "adopted", repaired)
        .await
        .unwrap();
    assert_eq!(repaired.group_id, bound.group_id);
    assert_eq!(authorize().await?["members"].as_array().unwrap().len(), 2);
    mysql.execute("INSERT INTO kinds(id,user_id,name,kind,namespace,json,is_active) VALUES (8300,7101,'occupied','CollaborationGroup','projects/8201',JSON_OBJECT(),TRUE)",()).await?;
    mysql.execute("INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,role,status,requested_at,created_at,updated_at) VALUES ('CollaborationGroup',8300,'project','8201','Developer','approved',NOW(),NOW(),NOW())",()).await?;
    let mut renamed = team("adopted", true);
    let Definition::Team(ref mut roster) = renamed else {
        unreachable!()
    };
    roster.name = "occupied".into();
    mysql
        .with_transaction(async |tx| {
            let source = storage::publication(tx, 7101, "team", "adopted")
                .await?
                .unwrap();
            storage::update_publication(tx, &source, &renamed).await?;
            let saved = storage::publication(tx, 7101, "team", "adopted")
                .await?
                .unwrap();
            assert!(saved.definition.0 == renamed);
            Ok(())
        })
        .await?;
    let pending: (i64, String, Json<Value>) = mysql
        .fetch_one(
            "SELECT CAST(is_active AS SIGNED),name,json FROM kinds WHERE id=?",
            (bound.group_id.as_str(),),
        )
        .await?;
    assert_eq!((pending.0, pending.1.as_str()), (1, "adopted"));
    assert_eq!(pending.2.0["status"]["bindingIssue"], "name_conflict");
    assert!(authorize().await.is_err());
    mysql
        .with_transaction(async |tx| {
            let source = storage::publication(tx, 7101, "team", "adopted")
                .await?
                .unwrap();
            storage::update_publication(tx, &source, &team("adopted", true)).await
        })
        .await?;
    assert!(authorize().await.is_ok());

    mysql
        .execute(
            "UPDATE loop_items SET metadata=JSON_OBJECT('runtime','codex') WHERE id='8204'",
            (),
        )
        .await?;
    assert!(authorize().await.is_err());

    let before_revocation = read_group().await?;
    mysql.execute("DELETE FROM resource_members WHERE resource_type='CloudProject' AND resource_id=8201 AND entity_type='user' AND entity_id='7101'", ()).await?;
    let personal_edit = team("adopted", false);
    mysql
        .with_transaction(async |tx| {
            let source = storage::publication(tx, 7101, "team", "adopted")
                .await?
                .unwrap();
            storage::update_publication(tx, &source, &personal_edit).await?;
            Ok(())
        })
        .await?;
    let saved = mysql
        .with_transaction(async |tx| storage::publication(tx, 7101, "team", "adopted").await)
        .await?
        .unwrap();
    assert!(saved.definition.0 == personal_edit);
    assert_eq!(read_group().await?.0, before_revocation.0);

    Ok(())
}
