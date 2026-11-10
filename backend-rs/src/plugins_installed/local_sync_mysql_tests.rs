//! Real MySQL/Redis/HTTP coverage, invoked by the existing Backend Rust CI job.
use super::*;
use crate::{Application, auth::AppAuthenticator, config::AuthConfig};
use std::sync::Arc;

#[tokio::test]
#[ignore = "requires disposable MySQL/Redis and PLUGIN_LOCAL_SYNC_ENABLED=true"]
async fn http_without_device_isolation_generation_and_receipts() -> anyhow::Result<()> {
    assert!(
        enabled(),
        "set PLUGIN_LOCAL_SYNC_ENABLED=true for this contract test"
    );
    crate::migrations::mysql_tests::isolated(verify).await
}

async fn verify(mysql: &brz_mysql::MysqlService) -> anyhow::Result<()> {
    crate::migrations::upgrade(mysql).await?;
    for id in [81001, 81002] {
        mysql.execute("INSERT INTO users (id,user_name,password_hash,email,is_active,role,auth_source,preferences,git_info,created_at,updated_at) VALUES (?,?,'unused','',1,'user','password','{}','{}',NOW(),NOW())", (id,format!("local-sync-{id}"))).await?;
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
    let token = |id| {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &json!({"sub":format!("local-sync-{id}"),"exp":chrono::Utc::now().timestamp()+300}),
            &jsonwebtoken::EncodingKey::from_secret(b"local-sync-contract-test"),
        )
        .unwrap()
    };
    let post = |id, path: &'static str, body: Value| {
        let client = client.clone();
        let token = token(id);
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
    .await;
    assert_eq!(probe.status().as_u16(), 200);
    let capabilities = probe.json::<Value>().await?;
    assert_eq!(capabilities["accountId"], 81001);
    assert_eq!(capabilities["contractRevision"], 2);
    #[derive(FromMysqlRow)]
    struct Count {
        n: i64,
    }
    let rows: Count = mysql
        .fetch_one("SELECT COUNT(*) AS n FROM kinds WHERE user_id=81001", ())
        .await?;
    assert_eq!(rows.n, 0, "Probe created dispatch metadata or a Device");
    let read = || {
        post(
            81001,
            "/api/plugins/local-sync",
            json!({"protocolVersion":1,"instanceId":"native"}),
        )
    };
    let snapshot = read().await.json::<Value>().await?;
    assert_eq!(snapshot["generation"], 1);
    assert_eq!(snapshot["payload"]["plugins"], json!([]));
    let unchanged=post(81001,"/api/plugins/local-sync",json!({"protocolVersion":1,"instanceId":"native","knownRevision":snapshot["revision"],"actualRevision":snapshot["revision"]})).await.json::<Value>().await?;
    assert_eq!(unchanged["unchanged"], true);
    let body = json!({"protocolVersion":1,"instanceId":"native","snapshotId":snapshot["snapshotId"],"generation":1,"result":{"success":true,"scope":"plugins","plugin_sync":snapshot["payload"]["plugin_sync"],"plugins":[]}});
    assert_eq!(
        post(81002, "/api/plugins/local-sync/receipts", body.clone())
            .await
            .status()
            .as_u16(),
        403
    );
    let mut other_instance = body.clone();
    other_instance["instanceId"] = json!("other-native");
    assert_eq!(
        post(81001, "/api/plugins/local-sync/receipts", other_instance)
            .await
            .status()
            .as_u16(),
        403
    );
    let newer = read().await.json::<Value>().await?;
    assert_eq!(newer["generation"], 2);
    let receipt = post(81001, "/api/plugins/local-sync/receipts", body.clone()).await;
    assert_eq!(receipt.status().as_u16(), 200);
    assert_eq!(receipt.json::<Value>().await?["state"], "superseded");
    assert_eq!(
        post(81001, "/api/plugins/local-sync/receipts", body)
            .await
            .status()
            .as_u16(),
        200
    );
    mysql.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (81001,'InstalledPlugin','default','old-client-write',?,1,NOW(),NOW())", (json!({"spec":{"installState":"installed","version":"1.0","enabled":true,"source":{"pluginKey":"old-client-write"}}}),)).await?;
    let latest_body = json!({"protocolVersion":1,"instanceId":"native","snapshotId":newer["snapshotId"],"generation":2,"result":{"success":true,"scope":"plugins","plugin_sync":newer["payload"]["plugin_sync"],"plugins":[]}});
    assert_eq!(
        post(81001, "/api/plugins/local-sync/receipts", latest_body)
            .await
            .json::<Value>()
            .await?["state"],
        "superseded",
        "A legacy account write must supersede an old receipt even without a new instance snapshot"
    );
    let rows: Count = mysql
        .fetch_one(
            "SELECT COUNT(*) AS n FROM kinds WHERE user_id=81001 AND kind='Device'",
            (),
        )
        .await?;
    assert_eq!(rows.n, 0);
    let target: StateRow=mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81001 AND name='old-client-write' AND namespace='default' AND kind='InstalledPlugin'",()).await?;
    mysql.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (81001,'InstalledPlugin','default','unrelated-plugin',?,1,NOW(),NOW())", (json!({"spec":{"installState":"installed","version":"bad-historical-package","source":{"pluginKey":"unrelated-plugin"},"packageRef":{"checksum":"invalid"}}}),)).await?;
    let unrelated:StateRow=mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81001 AND name='unrelated-plugin' AND kind='InstalledPlugin' AND namespace='default'",()).await?;
    for (operation, id, doc) in [
        ("target-operation", target.id, target.json.clone()),
        ("unrelated-operation", unrelated.id, unrelated.json.clone()),
    ] {
        mysql.execute("INSERT INTO plugin_local_sync_operations (user_id,instance_id,operation_id,action,installed_id,document,created_at,updated_at) VALUES (81001,'native',?,'install',?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",(operation,id,json!({"state":"intent_saved","plugin":doc}))).await?;
    }
    let accepted = mysql
        .with_transaction(async |tx| {
            read_operation(tx, 81001, "native", Some("target-operation")).await
        })
        .await?;
    assert_eq!(accepted["state"], "intent_saved", "{accepted}");
    let targeted=post(81001,"/api/plugins/local-sync",json!({"protocolVersion":1,"instanceId":"native","targeted":true,"operationId":"target-operation","operationIds":["target-operation"],"installedPluginId":target.id})).await.json::<Value>().await?;
    assert_eq!(targeted["payload"]["scope"], "plugin_delta", "{targeted}");
    assert_eq!(targeted["payload"]["plugin_sync"]["complete"], false);
    assert_eq!(
        targeted["payload"]["plugins"].as_array().unwrap().len(),
        1,
        "A single mutation included an unrelated historical plugin"
    );
    assert_eq!(
        targeted["payload"]["plugins"][0]["installed_plugin_id"],
        target.id
    );
    let ack = json!({"protocolVersion":1,"instanceId":"native","snapshotId":targeted["snapshotId"],"generation":targeted["generation"],"result":{"success":true,"scope":"plugin_delta","plugin_sync":targeted["payload"]["plugin_sync"],"plugins":[{"id":target.id,"generation":targeted["generation"],"operation":"upsert","status":"synced","version":targeted["payload"]["plugins"][0]["version"],"checksum":targeted["payload"]["plugins"][0]["checksum"]}]}});
    assert_eq!(
        post(81001, "/api/plugins/local-sync/receipts", ack)
            .await
            .status()
            .as_u16(),
        200
    );
    let ended:OperationRow=mysql.fetch_one("SELECT id,document FROM plugin_local_sync_operations WHERE user_id=81001 AND instance_id='native' AND operation_id='target-operation'",()).await?;
    let waiting:OperationRow=mysql.fetch_one("SELECT id,document FROM plugin_local_sync_operations WHERE user_id=81001 AND instance_id='native' AND operation_id='unrelated-operation'",()).await?;
    assert_eq!(ended.document["state"], "reconciled");
    assert_eq!(
        waiting.document["state"], "intent_saved",
        "A receipt ended an unrelated pending operation"
    );
    assert_eq!(post(81002,"/api/plugins/local-sync",json!({"protocolVersion":1,"instanceId":"native","targeted":true,"installedPluginId":target.id})).await.status().as_u16(),403);
    mysql
        .execute(
            "UPDATE kinds SET is_active=0 WHERE id=? AND user_id=81001",
            (target.id,),
        )
        .await?;
    let removal=post(81001,"/api/plugins/local-sync",json!({"protocolVersion":1,"instanceId":"native","targeted":true,"installedPluginId":target.id})).await.json::<Value>().await?;
    assert_eq!(removal["payload"]["plugins"], json!([]));
    assert_eq!(
        removal["payload"]["removed_plugins"][0]["installed_plugin_id"],
        target.id
    );
    let mut body = json!({"protocolVersion":1,"instanceId":"native","snapshotId":removal["snapshotId"],"generation":removal["generation"],"result":{"success":true,"scope":"plugin_delta","plugin_sync":removal["payload"]["plugin_sync"],"plugins":[]}});
    assert_eq!(
        post(81001, "/api/plugins/local-sync/receipts", body.clone())
            .await
            .status()
            .as_u16(),
        422
    );
    body["result"]["plugins"] = json!([{"id":target.id,"generation":removal["generation"],"operation":"remove","status":"removed"}]);
    assert_eq!(
        post(81001, "/api/plugins/local-sync/receipts", body)
            .await
            .status()
            .as_u16(),
        200
    );
    stop.send(()).unwrap();
    task.await??;
    Ok(())
}
