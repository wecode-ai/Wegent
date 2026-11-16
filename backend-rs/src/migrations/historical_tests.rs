//! Populated historical upgrades run on the existing disposable MySQL service.
use super::*;
use serde_json::{Value, json};

async fn sql(mysql: &MysqlService, statements: &[&str]) -> Result<()> {
    for statement in statements {
        mysql.execute(*statement, ()).await?;
    }
    Ok(())
}
async fn data(mysql: &MysqlService, query: &str) -> Result<Vec<Value>> {
    Ok(mysql
        .with_transaction(async |tx| super::super::rows::query(tx, query, ()).await)
        .await?)
}
async fn target(mysql: &MysqlService, revision: &str) -> Result<()> {
    migrate(mysql, &graph::Graph::load()?, revision, false).await
}
async fn item(mysql: &MysqlService, value: Value) -> Result<()> {
    mysql
        .with_transaction(async |tx| {
            super::super::rows::insert(tx, "loop_items", &value).await?;
            Ok(())
        })
        .await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated schema"]
async fn historical_marketplace_backfill_and_failure_preflight() -> Result<()> {
    isolated(async |mysql| {
        // These are the pre-publication tables consumed by e6f7a8b9c013, not the latest schema.
        sql(mysql, &[
            "CREATE TABLE kinds (id INT PRIMARY KEY,user_id INT,kind VARCHAR(50),json JSON,is_active BOOL,created_at DATETIME,updated_at DATETIME)",
            "CREATE TABLE resource_members (resource_type VARCHAR(50),resource_id BIGINT,status VARCHAR(20))",
            VERSION_TABLE,
            "INSERT INTO alembic_version VALUES ('d5e6f7a8b9c0')",
            "INSERT INTO kinds VALUES (1,7,'Team','{\"spec\":{\"capability\":{\"visibility\":\"public\",\"publishStatus\":\"published\"}}}',1,'2026-01-01','2026-02-01'),(2,7,'Skill','{\"spec\":{\"capability\":{\"visibility\":\"public\",\"publishStatus\":\"published\"}}}',1,'2026-01-01','2026-02-01'),(10,8,'SkillBinding','{\"spec\":{\"skillRef\":{\"skillId\":2}}}',1,NOW(),NOW()),(11,9,'SkillBinding','{\"spec\":{\"skillRef\":{\"skillId\":2}}}',0,NOW(),NOW())",
            "INSERT INTO kinds SELECT 3,7,'Team',JSON_SET(json,'$.spec.capability.visibility','private'),1,created_at,updated_at FROM kinds WHERE id=1",
            "INSERT INTO kinds SELECT 4,0,kind,json,1,created_at,updated_at FROM kinds WHERE id=1",
            "INSERT INTO kinds SELECT 5,7,kind,json,0,created_at,updated_at FROM kinds WHERE id=1",
            "INSERT INTO kinds SELECT 6,7,kind,JSON_SET(json,'$.spec.capability.publishStatus','draft'),1,created_at,updated_at FROM kinds WHERE id=1",
            "INSERT INTO resource_members VALUES ('Team',1,'approved'),('Team',1,'approved'),('Team',1,'pending'),('Skill',1,'approved')",
        ]).await?;
        target(mysql,"e6f7a8b9c013").await?;
        let expected=json!([{"id":1,"type":"agent","n":2,"published":"2026-01-01 00:00:00","updated":"2026-02-01 00:00:00"},{"id":2,"type":"skill","n":1,"published":"2026-01-01 00:00:00","updated":"2026-02-01 00:00:00"}]);
        let query="SELECT JSON_OBJECT('id',kind_id,'type',resource_type,'n',install_count,'published',CAST(published_at AS CHAR),'updated',CAST(updated_at AS CHAR)) AS data FROM marketplace_resources ORDER BY kind_id";
        assert_eq!(json!(data(mysql,query).await?),expected);
        downgrade(mysql,"d5e6f7a8b9c0").await?;
        let mut invalid=graph::Graph::load()?;
        invalid.revisions.iter_mut().find(|r|r.revision=="e6f7a8b9c013").unwrap().upgrade.as_mut().unwrap().last_mut().unwrap().sql=vec!["SELECT %s".into()];
        assert!(migrate(mysql,&invalid,"e6f7a8b9c013",false).await.is_err());
        assert!(data(mysql,"SELECT JSON_OBJECT('name',TABLE_NAME) AS data FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='marketplace_resources'").await?.is_empty());
        assert_eq!(current(mysql).await?, BTreeSet::from(["d5e6f7a8b9c0".into()]));
        target(mysql,"e6f7a8b9c013").await?;
        assert_eq!(json!(data(mysql,query).await?),expected);
        sql(mysql,&["UPDATE alembic_version SET version_num='unknown-review-test'"]).await?;
        assert!(upgrade(mysql).await.is_err());
        assert_eq!(json!(data(mysql,query).await?),expected);
        Ok(())
    }).await
}

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated schema"]
async fn historical_runtime_profiles_preserve_robot_workspace_and_model() -> Result<()> {
    isolated(async |mysql| {
        upgrade(mysql).await?;
        downgrade(mysql,"d47dd270f4b6").await?;
        sql(mysql,&["INSERT INTO projects (id,user_id,name,sort_order,is_expanded,is_active,created_at,updated_at) VALUES (42,7,'Legacy workspace',0,1,1,NOW(),NOW())"]).await?;
        item(mysql,json!({"id":"1001","resource_type":"project","created_by_user_id":7,"description":"Legacy cloud project","metadata":{}})).await?;
        item(mysql,json!({"id":"robot","resource_type":"chat_agent","created_by_user_id":7,"cloud_project_id":"1001","device_id":"device","local_project_id":42,"name":"Robot","title":"Robot","description":"","metadata":{"model":{"name":"model"},"execution_environment":"local","retained":"yes"}})).await?;
        target(mysql,"e58ee381a7c2").await?;
        let profiles=data(mysql,"SELECT JSON_OBJECT('model',JSON_EXTRACT(p.metadata,'$.model'),'device',p.device_id) AS data FROM loop_items p JOIN loop_items r ON p.id=JSON_UNQUOTE(JSON_EXTRACT(r.metadata,'$.default_runtime_profile_id')) WHERE p.resource_type='runtime_profile' AND r.id='robot' AND r.local_project_id IS NULL").await?;
        assert_eq!(profiles,vec![json!({"model":{"name":"model"},"device":"device"})]);
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('workspace',local_project_id) AS data FROM loop_items WHERE resource_type='local_binding'").await?,vec![json!({"workspace":42})]);
        downgrade(mysql,"d47dd270f4b6").await?;
        let robots=data(mysql,"SELECT JSON_OBJECT('device',device_id,'workspace',local_project_id,'metadata',metadata) AS data FROM loop_items WHERE id='robot'").await?;
        assert_eq!(robots,vec![json!({"device":"device","workspace":42,"metadata":{"model":{"name":"model"},"execution_environment":"local","retained":"yes"}})]);
        target(mysql,"e58ee381a7c2").await?;
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('model',JSON_EXTRACT(p.metadata,'$.model'),'device',p.device_id) AS data FROM loop_items p JOIN loop_items r ON p.id=JSON_UNQUOTE(JSON_EXTRACT(r.metadata,'$.default_runtime_profile_id')) WHERE p.resource_type='runtime_profile' AND r.id='robot' AND r.local_project_id IS NULL").await?,profiles);
        Ok(())
    }).await
}

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated schema"]
async fn historical_collaboration_grants_and_assignment_round_trip() -> Result<()> {
    isolated(async |mysql| {
        upgrade(mysql).await?;
        downgrade(mysql,"580031eb7ddc").await?;
        item(mysql,json!({"id":"1001","resource_type":"project","created_by_user_id":7,"description":"","metadata":{}})).await?;
        item(mysql,json!({"id":"task","resource_type":"task","cloud_project_id":"1001","created_by_user_id":7,"assignee_user_id":8,"description":"keep task","metadata":{"retained":true}})).await?;
        target(mysql,"b8e2c4f6a901").await?;
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('role',role,'user',user_id) AS data FROM resource_members WHERE resource_type='Workspace'").await?,vec![json!({"role":"Owner","user":7})]);
        let comments=data(mysql,"SELECT JSON_OBJECT('target',JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.target_id')),'notify',JSON_EXTRACT(metadata,'$.notify')) AS data FROM loop_items WHERE resource_type='comment'").await?;
        assert_eq!(comments,vec![json!({"target":"8","notify":false})]);
        downgrade(mysql,"580031eb7ddc").await?;
        assert!(data(mysql,"SELECT JSON_OBJECT('id',id) AS data FROM kinds WHERE kind='CollaborationWorkspace'").await?.is_empty());
        assert!(data(mysql,"SELECT JSON_OBJECT('id',id) AS data FROM loop_items WHERE resource_type='comment'").await?.is_empty());
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('text',description,'metadata',metadata) AS data FROM loop_items WHERE id='task'").await?,vec![json!({"text":"keep task","metadata":{"retained":true}})]);
        target(mysql,"b8e2c4f6a901").await?;
        Ok(())
    }).await
}

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated schema"]
async fn historical_plugin_submissions_survive_publication_round_trip() -> Result<()> {
    isolated(async |mysql| {
        upgrade(mysql).await?;
        downgrade(mysql,"8d3d51c83c99").await?;
        sql(mysql,&[
            "INSERT INTO plugins (id,slug,name,owner_user_id,keywords_json,interface_json,visibility,status,created_at,updated_at) VALUES (1,'pending','pending',7,'[]','{}','workspace','draft',NOW(),NOW())",
            "INSERT INTO plugin_releases (id,plugin_id,version,manifest_json,interface_json,storage_key,sha256,size_bytes,status,scan_report_json,created_at) VALUES (1,1,'1.2.3','{\"name\":\"pending\"}','{}','packages/pending.zip',REPEAT('a',64),42,'ready','{}',NOW())",
            "INSERT INTO plugin_submissions (id,plugin_id,release_id,submitter_user_id,status,review_note,submitted_at) VALUES (1,1,1,7,'pending','retain review',NOW())",
        ]).await?;
        target(mysql,"c2f8d4a6b901").await?;
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('status',aggregate_status,'user',submitter_user_id) AS data FROM plugin_publication_requests").await?,vec![json!({"status":"changes_requested","user":7})]);
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('version',requested_version,'storage',storage_key,'size',size_bytes) AS data FROM plugin_publication_revisions").await?,vec![json!({"version":"1.2.3","storage":"packages/pending.zip","size":42})]);
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('status',status) AS data FROM plugin_submissions").await?,vec![json!({"status":"cancelled"})]);
        // A global-slug downgrade must fail before changing any publication data.
        sql(mysql,&["INSERT INTO plugins (slug,name,catalog_namespace,keywords_json,interface_json,created_at,updated_at) VALUES ('pending','duplicate','other','[]','{}',NOW(),NOW())"]).await?;
        let before=current(mysql).await?;
        assert!(downgrade(mysql,"8d3d51c83c99").await.is_err());
        assert_eq!(current(mysql).await?,before);
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('status',status) AS data FROM plugin_submissions").await?,vec![json!({"status":"cancelled"})]);
        sql(mysql,&["DELETE FROM plugins WHERE catalog_namespace='other'"]).await?;
        downgrade(mysql,"8d3d51c83c99").await?;
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('status',status,'note',review_note) AS data FROM plugin_submissions").await?,vec![json!({"status":"pending","note":"retain review"})]);
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('visibility',visibility,'owner',owner_user_id) AS data FROM plugins").await?,vec![json!({"visibility":"workspace","owner":7})]);
        target(mysql,"c2f8d4a6b901").await?;
        Ok(())
    }).await
}

#[tokio::test]
#[ignore = "requires existing loopback MySQL and Redis CI services"]
async fn startup_prepares_schema_and_releases_lock_on_migration_failure() -> Result<()> {
    use brz_redis::{Redis, RedisService, RedisServiceOptions, SetExpiration, SetOptions};
    let address = std::env::var("WEGENT_TEST_REDIS_ADDRESS")?;
    ensure!(
        address.starts_with("127.0.0.1:"),
        "only a disposable loopback Redis is allowed"
    );
    let redis = RedisService::noshard_with_options(
        address.clone(),
        [address],
        RedisServiceOptions::default(),
    )
    .await?;
    isolated(async |mysql| {
        assert!(crate::prepare_database(mysql,None).await.is_err());
        redis.set_with("wegent:startup_lock","held",SetOptions::default().with_expiration(SetExpiration::Seconds(120))).await?;
        crate::prepare_database(mysql,Some(&redis)).await?;
        assert!(current(mysql).await?.is_empty());
        redis.del("wegent:startup_lock").await?;
        crate::prepare_database(mysql,Some(&redis)).await?;
        check(mysql).await?;
        let shells=data(mysql,"SELECT JSON_OBJECT('name',name) AS data FROM kinds WHERE kind='Shell' AND user_id=0 AND name IN ('Chat','ClaudeCode','Codex') ORDER BY name").await?;
        assert_eq!(shells,vec![json!({"name":"Chat"}),json!({"name":"ClaudeCode"}),json!({"name":"Codex"})]);
        sql(mysql,&["UPDATE alembic_version SET version_num='invalid-startup-revision'"]).await?;
        assert!(crate::prepare_database(mysql,Some(&redis)).await.is_err());
        let lock:Option<String>=redis.get("wegent:startup_lock").await?;
        assert!(lock.is_none(),"migration failure must release the startup lock");
        assert_eq!(current(mysql).await?,BTreeSet::from(["invalid-startup-revision".into()]));
        Ok(())
    }).await
}

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated schema"]
async fn staged_builtin_is_packaged_and_published_to_marketplace() -> Result<()> {
    isolated(async |mysql| {
        upgrade(mysql).await?;
        let root=std::env::temp_dir().join(format!("wegent-staged-{}",super::super::rows::uuid()));
        let source=root.join("source/.codex-plugin");
        std::fs::create_dir_all(&source)?;
        std::fs::write(source.join("plugin.json"),r#"{"name":"wegent-sites","version":"1.0.0","description":"staged fixture"}"#)?;
        let script=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("scripts/builtin-plugin-staging.mjs");
        let status=std::process::Command::new("node").args(["--input-type=module","-e","const {stageBuiltinPlugin,builtinPluginStagingDefinitions}=await import(process.argv[1]); await stageBuiltinPlugin(builtinPluginStagingDefinitions[0],{sourceRoot:process.argv[2],workspaceRoot:process.argv[3],required:true});"]).arg(format!("file://{}",script.display())).arg(root.join("source")).arg(&root).status()?;
        ensure!(status.success(),"staging failed");
        let outcome=crate::initialization::test_publish_builtin(mysql,root.join("backend-rs/init_data/plugins/wegent-sites"),"wegent-sites").await;
        std::fs::remove_dir_all(&root)?;
        outcome?;
        let rows=data(mysql,"SELECT JSON_OBJECT('name',JSON_UNQUOTE(JSON_EXTRACT(k.json,'$.spec.name')),'state',JSON_UNQUOTE(JSON_EXTRACT(k.json,'$.status.state')),'size',OCTET_LENGTH(b.binary_data)) AS data FROM kinds k JOIN skill_binaries b ON b.kind_id=k.id WHERE k.kind='PluginMarketplaceItem'").await?;
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0]["name"],"wegent-sites");
        assert_eq!(rows[0]["state"],"Available");
        assert!(rows[0]["size"].as_u64().unwrap()>0);
        #[derive(FromMysqlRow)]
        struct Package { bytes: Vec<u8> }
        let package:Package=mysql.fetch_one("SELECT b.binary_data AS bytes FROM skill_binaries b JOIN kinds k ON k.id=b.kind_id WHERE k.kind='PluginMarketplaceItem'",()).await?;
        let mut zip=zip::ZipArchive::new(std::io::Cursor::new(package.bytes))?;
        let manifest:Value=serde_json::from_reader(zip.by_name(".codex-plugin/plugin.json")?)?;
        assert_eq!(manifest["name"],"wegent-sites");
        assert_eq!(manifest["version"],"1.0.0");
        assert!(zip.by_name(".claude-plugin/plugin.json").is_ok());
        Ok(())
    }).await
}

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated schema"]
async fn historical_integer_ids_and_member_constraints_preserve_rows() -> Result<()> {
    isolated(async |mysql| {
        sql(mysql,&[
            "CREATE TABLE tasks (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY)",
            "CREATE TABLE subtasks (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,task_id INT NOT NULL,parent_id INT NULL,reply_to_subtask_id INT NOT NULL)",
            "CREATE TABLE resource_members (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,resource_type VARCHAR(50),resource_id INT NOT NULL,copied_resource_id INT NOT NULL DEFAULT 0,user_id INT NOT NULL,role VARCHAR(20),status VARCHAR(20),UNIQUE KEY legacy_member(resource_type,resource_id,user_id))",
            "INSERT INTO tasks VALUES (123)",
            "INSERT INTO subtasks VALUES (456,123,NULL,0)",
            "INSERT INTO resource_members (resource_type,resource_id,user_id,role,status) VALUES ('Task',123,7,'Owner','approved')",
        ]).await?;
        mysql.with_transaction(async |tx| super::super::schema_changes::bigint_ids(tx,false).await).await?;
        sql(mysql,&["INSERT INTO tasks VALUES (3000000000)","INSERT INTO subtasks VALUES (3000000000,3000000000,456,0)"]).await?;
        mysql.with_transaction(async |tx| super::super::schema_changes::members(tx,false).await).await?;
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('id',entity_id,'type',entity_type,'role',role) AS data FROM resource_members").await?,vec![json!({"id":"7","type":"user","role":"Owner"})]);
        assert!(mysql.execute("INSERT INTO resource_members(resource_type,resource_id,user_id,entity_type,entity_id) VALUES ('Task',123,7,'user','7')",()).await.is_err());
        sql(mysql,&["DELETE FROM subtasks WHERE id=3000000000","DELETE FROM tasks WHERE id=3000000000"]).await?;
        mysql.with_transaction(async |tx| super::super::schema_changes::members(tx,true).await).await?;
        mysql.with_transaction(async |tx| super::super::schema_changes::bigint_ids(tx,true).await).await?;
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('id',id,'task',task_id,'parent',parent_id) AS data FROM subtasks").await?,vec![json!({"id":456,"task":123,"parent":null})]);
        Ok(())
    }).await
}

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated schema"]
async fn historical_secure_share_tokens_backfill_existing_rows() -> Result<()> {
    isolated(async |mysql| {
        sql(
            mysql,
            &[
                "CREATE TABLE share_links (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,resource_type VARCHAR(50) NOT NULL,resource_id BIGINT NOT NULL,share_token VARCHAR(512) NOT NULL,require_approval BOOL NOT NULL,default_role VARCHAR(20) NOT NULL,expires_at DATETIME NOT NULL,created_by_user_id INT NOT NULL,is_active BOOL NOT NULL,created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL,UNIQUE KEY uniq_share_links_share_token (share_token))",
                VERSION_TABLE,
                "INSERT INTO alembic_version VALUES ('f3a7c9e1b2d4')",
                "INSERT INTO share_links (resource_type,resource_id,share_token,require_approval,default_role,expires_at,created_by_user_id,is_active,created_at,updated_at) VALUES ('Task',1,'legacy-a',0,'Reporter','9999-12-31',7,1,NOW(),NOW()),('Task',2,'legacy-b%2B%3D',0,'Reporter','9999-12-31',7,1,NOW(),NOW()),('Team',3,'inactive-c',0,'Reporter','9999-12-31',7,0,NOW(),NOW())",
            ],
        )
        .await?;
        target(mysql, "b1c2d3e4f5a6").await?;
        let rows = data(
            mysql,
            "SELECT JSON_OBJECT('hash',token_hash,'expected',SHA2(REPLACE(REPLACE(share_token,'%2B','+'),'%3D','='),256),'active',is_active,'version',token_version) AS data FROM share_links ORDER BY id",
        )
        .await?;
        assert_eq!(rows.len(), 3);
        for (index, row) in rows.into_iter().enumerate() {
            assert_eq!(row["active"], json!(u8::from(index < 2)));
            assert_eq!(row["version"], json!(1));
            assert_eq!(row["hash"], row["expected"]);
        }
        // Old binaries omit both new columns. Multiple late writes must remain
        // version-1 locators, without colliding on a default empty hash.
        sql(mysql, &["INSERT INTO share_links(resource_type,resource_id,share_token,require_approval,default_role,expires_at,created_by_user_id,is_active,created_at,updated_at) VALUES ('Task',4,'late-a%2B%3D',0,'Reporter','9999-12-31',7,1,NOW(),NOW()),('Task',5,'late-b',0,'Reporter','9999-12-31',7,1,NOW(),NOW())"]).await?;
        assert_eq!(
            data(mysql, "SELECT JSON_OBJECT('version',token_version,'hash',token_hash) AS data FROM share_links WHERE resource_id IN (4,5) ORDER BY id").await?,
            vec![json!({"version": 1, "hash": null}), json!({"version": 1, "hash": null})],
        );
        let hash = crate::share_access::token_hash("late-a+=");
        let row: Option<crate::share_access::TaskShareLink> = mysql
            .fetch_optional(
                "SELECT resource_id,created_by_user_id,token_version FROM share_links WHERE (token_hash=? OR (token_hash IS NULL AND token_version=1 AND SHA2(REPLACE(REPLACE(share_token,'%2B','+'),'%3D','='),256)=?)) AND is_active=true",
                (hash.clone(), hash),
            )
            .await?;
        let row = row.expect("late legacy writer must remain discoverable");
        assert_eq!(row.resource_id, 4);
        assert_eq!(row.token_version, 1);
        assert!(crate::share_access::legacy_viewer(row.token_version, None).is_err());
        sql(mysql, &["INSERT INTO share_links(resource_type,resource_id,share_token,token_hash,token_version,require_approval,default_role,expires_at,created_by_user_id,is_active,created_at,updated_at) VALUES ('TaskShare',6,'opaque-new',SHA2('opaque-new',256),2,0,'Reporter','9999-12-31',7,1,NOW(),NOW())"]).await?;
        assert_eq!(
            data(mysql, "SELECT JSON_OBJECT('version',token_version) AS data FROM share_links WHERE share_token='opaque-new'").await?,
            vec![json!({"version": 2})],
        );
        assert!(mysql.execute("INSERT INTO share_links(resource_type,resource_id,share_token,token_hash,require_approval,default_role,expires_at,created_by_user_id,is_active,created_at,updated_at) SELECT resource_type,resource_id,'different-token',token_hash,require_approval,default_role,expires_at,created_by_user_id,is_active,created_at,updated_at FROM share_links WHERE id=1",()).await.is_err());
        // MySQL implicitly drops the named index when the indexed column is
        // removed, so the JSON migration treats dropping it as optional.
        mysql.with_transaction(async |tx| {
            let graph = graph::Graph::load()
                .map_err(|_| brz_mysql::MysqlError::InvalidQuery {
                    reason: "migration graph failed to load".into(),
                })?;
            let revision = graph
                .get("b1c2d3e4f5a6")
                .map_err(|_| brz_mysql::MysqlError::InvalidQuery {
                    reason: "secure share migration is missing".into(),
                })?;
            legacy::execute(tx, revision, true).await?;
            Ok(())
        })
        .await?;
        assert!(data(mysql, "SELECT JSON_OBJECT('name',COLUMN_NAME) AS data FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='share_links' AND COLUMN_NAME IN ('token_hash','token_version')").await?.is_empty());
        Ok(())
    })
    .await
}

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; uses an isolated schema"]
async fn partial_ddl_failure_retains_revision_and_requires_cleanup() -> Result<()> {
    isolated(async |mysql| {
        sql(mysql,&[VERSION_TABLE,"INSERT INTO alembic_version VALUES ('d5e6f7a8b9c0')"]).await?;
        let mut graph=graph::Graph::load()?;
        let revision=graph.revisions.iter_mut().find(|r|r.revision=="e6f7a8b9c013").unwrap();
        revision.upgrade=Some(serde_json::from_value(json!([{"sql":["CREATE TABLE review_partial (id INT PRIMARY KEY)","INSERT INTO absent_review_table VALUES (1)"]}]))?);
        assert!(migrate(mysql,&graph,"e6f7a8b9c013",false).await.is_err());
        assert_eq!(current(mysql).await?,BTreeSet::from(["d5e6f7a8b9c0".into()]));
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('name',TABLE_NAME) AS data FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='review_partial'").await?,vec![json!({"name":"review_partial"})]);
        // A blind retry cannot roll back an already committed CREATE TABLE.
        assert!(migrate(mysql,&graph,"e6f7a8b9c013",false).await.is_err());
        sql(mysql,&["DROP TABLE review_partial"]).await?;
        graph.revisions.iter_mut().find(|r|r.revision=="e6f7a8b9c013").unwrap().upgrade=Some(serde_json::from_value(json!([{"sql":["CREATE TABLE review_partial (id INT PRIMARY KEY)","INSERT INTO review_partial VALUES (1)"]}]))?);
        migrate(mysql,&graph,"e6f7a8b9c013",false).await?;
        assert_eq!(current(mysql).await?,BTreeSet::from(["e6f7a8b9c013".into()]));
        assert_eq!(data(mysql,"SELECT JSON_OBJECT('id',id) AS data FROM review_partial").await?,vec![json!({"id":1})]);
        Ok(())
    }).await
}
