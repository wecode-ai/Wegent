//! Real HTTP/MySQL/Redis contract; invoked by the existing Backend Rust CI job.
use super::*;
use crate::{Application, auth::AppAuthenticator, config::AuthConfig};
use std::sync::Arc;

#[derive(FromMysqlRow)]
struct StoredKind {
    id: i64,
    json: Value,
}

#[tokio::test]
#[ignore = "requires disposable MySQL/Redis and PLUGIN_LOCAL_SYNC_ENABLED=true"]
async fn http_without_device_reuses_account_state_without_ledgers() -> anyhow::Result<()> {
    assert!(enabled());
    crate::migrations::mysql_tests::isolated(verify).await
}

async fn verify(mysql: &brz_mysql::MysqlService) -> anyhow::Result<()> {
    crate::migrations::upgrade(mysql).await?;
    for id in [81001, 81002] {
        mysql.execute("INSERT INTO users (id,user_name,password_hash,email,is_active,role,auth_source,preferences,git_info,created_at,updated_at) VALUES (?,?,'unused','',1,'user','password','{}','{}',NOW(),NOW())",(id,format!("local-sync-{id}"))).await?;
    }
    let mut state = crate::build_app_state().await?;
    state.mysql = mysql.clone();
    state.user_reader = Arc::new(crate::user_reader::PublicUserReader::new(mysql.clone()));
    state.auth = AuthConfig {
        jwt_key: "local-sync-contract-test".into(),
        legacy_jwt_keys: Vec::new(),
        algorithm: "HS256".into(),
    };
    let state = Arc::new(state);
    let app = Application::build(state.clone()).await?;
    let server = crate::http_server::Server::bind_with_authenticator(
        "127.0.0.1:0".parse()?,
        app.routes,
        AppAuthenticator::new(state.authentication_services()),
    )
    .await?;
    let address = server.local_addr()?;
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        server
            .serve_until(async {
                let _ = stopped.await;
            })
            .await
    });
    let client = brz_http::Client::new();
    let post = |id, path: &'static str, body: Value| {
        let client = client.clone();
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &json!({"sub":format!("local-sync-{id}"),"exp":chrono::Utc::now().timestamp()+300}),
            &jsonwebtoken::EncodingKey::from_secret(b"local-sync-contract-test"),
        )
        .unwrap();
        async move {
            client
                .post(format!("http://{address}{path}"))
                .unwrap()
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .unwrap()
        }
    };
    let probe = post(
        81001,
        "/api/plugins/local-sync",
        json!({"protocolVersion":1,"instanceId":"native","probeOnly":true}),
    )
    .await
    .json::<Value>()
    .await?;
    assert_eq!(probe["contractRevision"], 3);
    #[derive(FromMysqlRow)]
    struct Count {
        n: i64,
    }
    assert_eq!(
        mysql
            .fetch_one::<_, _, Count>("SELECT COUNT(*) AS n FROM kinds WHERE user_id=81001", ())
            .await?
            .n,
        0
    );
    let read = || {
        post(
            81001,
            "/api/plugins/local-sync",
            json!({"protocolVersion":1,"instanceId":"native"}),
        )
    };
    let plan = read().await.json::<Value>().await?;
    assert_eq!(plan["generation"], 1);
    assert!(plan.get("snapshotId").is_none());
    let unchanged=post(81001,"/api/plugins/local-sync",json!({"protocolVersion":1,"instanceId":"native","knownRevision":plan["revision"],"actualRevision":plan["revision"]})).await.json::<Value>().await?;
    assert_eq!(unchanged["unchanged"], true);
    assert_eq!(read().await.json::<Value>().await?["generation"], 2);
    mysql.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (81001,'InstalledPlugin','default','target',?,1,NOW(),NOW())",(json!({"metadata":{"name":"target","namespace":"default"},"spec":{"revision":1,"installState":"installed","version":"1.0","enabled":true,"source":{"pluginKey":"target"}}}),)).await?;
    let target:StoredKind=mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81001 AND kind='InstalledPlugin' AND name='target'",()).await?;
    let slot = json!({"operationId":"target-operation","requestHash":"hash","installedId":target.id,"installedRevision":1,"intentOrder":7,"action":"install"});
    let mut account:StoredKind=mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81001 AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account'",()).await?;
    account.json["spec"]["localIntents"] = json!({"native":{target.id.to_string():slot}});
    mysql
        .execute(
            "UPDATE kinds SET json=? WHERE id=?",
            (account.json, account.id),
        )
        .await?;
    // An unrelated bad package must not enter the targeted execution plan.
    mysql.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (81001,'InstalledPlugin','default','unrelated',?,1,NOW(),NOW())",(json!({"spec":{"installState":"installed","version":"bad","source":{"pluginKey":"unrelated"},"packageRef":{"checksum":"invalid"}}}),)).await?;
    let plan=post(81001,"/api/plugins/local-sync",json!({"protocolVersion":1,"instanceId":"native","targeted":true,"operationId":"target-operation"})).await.json::<Value>().await?;
    assert_eq!(plan["operation"]["state"], "intent_saved");
    assert_eq!(
        plan["operation"]["plugin"]["metadata"]["labels"]["id"],
        target.id.to_string()
    );
    assert_eq!(plan["payload"]["plugins"].as_array().unwrap().len(), 1);
    assert_eq!(plan["payload"]["scope"], "plugin_delta");
    for (user, instance) in [(81002, "native"), (81001, "other-native")] {
        let isolated = post(
            user,
            "/api/plugins/local-sync",
            json!({"protocolVersion":1,"instanceId":instance,"operationId":"target-operation"}),
        )
        .await
        .json::<Value>()
        .await?;
        assert_eq!(isolated["operation"]["state"], "unknown");
        assert!(isolated["operation"]["plugin"].is_null());
    }
    assert_eq!(post(81002,"/api/plugins/local-sync",json!({"protocolVersion":1,"instanceId":"native","targeted":true,"installedPluginId":target.id})).await.status().as_u16(),403);
    mysql
        .execute(
            "UPDATE kinds SET json=JSON_SET(json,'$.spec.revision',2),is_active=0 WHERE id=?",
            (target.id,),
        )
        .await?;
    let removed=post(81001,"/api/plugins/local-sync",json!({"protocolVersion":1,"instanceId":"native","targeted":true,"operationId":"target-operation"})).await.json::<Value>().await?;
    assert_eq!(removed["operation"]["state"], "superseded");
    assert_eq!(
        removed["payload"]["removed_plugins"][0]["installed_plugin_id"],
        target.id
    );
    assert_eq!(removed["payload"]["plugins"], json!([]));
    assert_eq!(mysql.fetch_one::<_,_,Count>("SELECT COUNT(*) AS n FROM kinds WHERE namespace='plugin-local-sync' OR kind='Device'",()).await?.n,0);
    assert_eq!(mysql.fetch_one::<_,_,Count>("SELECT COUNT(*) AS n FROM kinds WHERE user_id=81001 AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account'",()).await?.n,1);
    stop.send(()).unwrap();
    task.await??;
    Ok(())
}
