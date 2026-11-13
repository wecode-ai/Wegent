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
    for id in [81001, 81002, 81003, 81004, 81005, 81006] {
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
    // Negative cases exhaust 1.4 seconds of existing CAS retry backoff. Use
    // the protocol's operation budget instead of the 400ms socket default.
    let client = brz_http::Client::builder()
        .read_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let post = |id, path: &'static str, body: Value| {
        let client = client.clone();
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &json!({"sub":format!("local-sync-{id}"),"exp":chrono::Utc::now().timestamp()+300}),
            &jsonwebtoken::EncodingKey::from_secret(b"local-sync-contract-test"),
        )
        .unwrap();
        async move {
            let started = std::time::Instant::now();
            eprintln!(
                "local-sync contract request user_id={id} path={path} instance={}",
                body["instanceId"]
            );
            let response = client
                .post(format!("http://{address}{path}"))
                .unwrap()
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .unwrap_or_else(|error| panic!("local-sync contract request failed user_id={id} path={path} instance={} elapsed={:?}: {error}",body["instanceId"],started.elapsed()));
            eprintln!(
                "local-sync contract response user_id={id} status={} elapsed={:?}",
                response.status(),
                started.elapsed()
            );
            response
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
    mysql.execute("INSERT INTO plugin_states (user_id,plugin_key,installed_kind_id,json) VALUES (81001,'target',?,?)", (target.id,crate::plugins_installed::state_store::initial_document("target"))).await?;
    let mut account: StoredKind = mysql
        .fetch_one(
            "SELECT id,json FROM plugin_states WHERE user_id=81001 AND plugin_key='target'",
            (),
        )
        .await?;
    account.json["spec"]["localIntents"] = json!({"native":{target.id.to_string():slot}});
    mysql
        .execute(
            "UPDATE plugin_states SET json=? WHERE id=?",
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
    assert_eq!(mysql.fetch_one::<_,_,Count>("SELECT COUNT(*) AS n FROM plugin_states WHERE user_id=81001 AND plugin_key='@legacy-v2'",()).await?.n,1);
    let scoped=post(81001,"/api/plugins/local-sync",json!({"protocolVersion":1,"pluginSyncVersion":3,"instanceId":"native","targeted":true,"installedPluginId":target.id})).await.json::<Value>().await?;
    assert_eq!(scoped["payload"]["plugin_sync"]["version"], 3);
    assert_eq!(scoped["payload"]["plugin_sync"]["complete"], false);
    assert_eq!(
        scoped["payload"]["plugin_sync"]["intentRevisions"][target.id.to_string()],
        2
    );
    assert!(
        scoped["payload"]["plugin_sync"]["revisions"][target.id.to_string()]
            .as_i64()
            .unwrap()
            > removed["payload"]["plugin_sync"]["generation"]
                .as_i64()
                .unwrap()
    );
    let unknown = post(
        81002,
        "/api/plugins/local-sync",
        json!({"protocolVersion":1,"pluginSyncVersion":3,"instanceId":"scoped-only"}),
    )
    .await
    .json::<Value>()
    .await?;
    assert_eq!(unknown["payload"]["plugin_sync"]["version"], 3);
    mysql.execute("INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (81003,'InstalledPlugin','scoped-only','default',?,0,NOW(),NOW())",(json!({"spec":{"revision":2,"source":{"pluginKey":"scoped-only"}}}),)).await?;
    let cold: StoredKind=mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81003 AND kind='InstalledPlugin' AND namespace='default' AND name='scoped-only'",()).await?;
    let old_slot = json!({"operationId":"historical-uninstall","requestHash":"old-hash","installedId":cold.id,"installedRevision":2,"intentOrder":7,"action":"uninstall"});
    let frozen = json!({"spec":{"generation":7677,"devices":{"desktop":{"complete_generation":7000,"plugins":{cold.id.to_string():7677}}},"localIntents":{"scoped-only":{cold.id.to_string():old_slot}},"localIntentOrders":{"scoped-only":{cold.id.to_string():7}}}});
    mysql.execute("INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (81003,'PluginSyncState','account','plugin-sync',?,1,NOW(),NOW())",(frozen.clone(),)).await?;
    mysql
        .with_transaction(async |tx| {
            assert!(has_instance(tx, 81003, "scoped-only").await?);
            assert!(!has_instance(tx, 81003, "unknown-instance").await?);
            assert!(!has_instance(tx, 81002, "scoped-only").await?);
            Ok(())
        })
        .await?;
    let recovered=post(81003,"/api/plugins/local-sync",json!({"protocolVersion":1,"pluginSyncVersion":3,"instanceId":"scoped-only","operationId":"historical-uninstall","targeted":true})).await.json::<Value>().await?;
    assert_eq!(recovered["operation"]["state"], "intent_saved");
    assert!(
        recovered["payload"]["plugin_sync"]["revisions"][cold.id.to_string()]
            .as_i64()
            .unwrap()
            > 7677
    );
    let retained: StoredKind=mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81003 AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account'",()).await?;
    assert_eq!(retained.json, frozen);
    mysql
        .with_transaction(async |tx| {
            assert!(has_instance(tx, 81003, "scoped-only").await?);
            Ok(())
        })
        .await?;
    let fresh = post(
        81003,
        "/api/plugins/local-sync",
        json!({"protocolVersion":1,"pluginSyncVersion":3,"instanceId":"scoped-only"}),
    )
    .await
    .json::<Value>()
    .await?;
    assert_eq!(
        fresh["payload"]["removed_plugins"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(mysql.fetch_one::<_,_,Count>("SELECT COUNT(*) AS n FROM plugin_states WHERE user_id=81003 AND plugin_key='@legacy-v2'",()).await?.n,0);
    let tombstone = fresh["payload"]["removed_plugins"][0].clone();
    let old_generation = fresh["payload"]["plugin_sync"]["revisions"]
        [tombstone["installed_plugin_id"].to_string()]
    .as_i64()
    .unwrap();
    mysql
        .execute(
            "DELETE FROM kinds WHERE user_id=81003 AND kind='InstalledPlugin'",
            (),
        )
        .await?;
    let orphan = post(
        81003,
        "/api/plugins/local-sync",
        json!({"protocolVersion":1,"pluginSyncVersion":3,"instanceId":"scoped-only"}),
    )
    .await
    .json::<Value>()
    .await?;
    assert_eq!(orphan["payload"]["removed_plugins"], json!([tombstone]));
    assert!(
        orphan["payload"]["plugin_sync"]["revisions"][tombstone["installed_plugin_id"].to_string()]
            .as_i64()
            .unwrap()
            > old_generation
    );
    mysql.execute("INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (81004,'PluginSyncState','account','plugin-sync',?,1,NOW(),NOW())",(json!({"spec":{"generation":40}}),)).await?;
    let (first, second) = tokio::join!(
        post(
            81004,
            "/api/plugins/local-sync",
            json!({"protocolVersion":1,"instanceId":"legacy-cold"})
        ),
        post(
            81004,
            "/api/plugins/local-sync",
            json!({"protocolVersion":1,"instanceId":"legacy-cold"})
        )
    );
    let mut generations = [
        first.json::<Value>().await?["generation"].as_i64(),
        second.json::<Value>().await?["generation"].as_i64(),
    ];
    generations.sort();
    assert_eq!(generations, [Some(41), Some(42)]);
    let frozen: StoredKind=mysql.fetch_one("SELECT id,json FROM kinds WHERE user_id=81004 AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account'",()).await?;
    assert_eq!(frozen.json["spec"]["generation"], 40);
    for (owner, documents) in [
        (81005, vec![json!({"spec":{"generation":"invalid"}})]),
        (81006, vec![json!({"spec":{"generation":12}}); 2]),
    ] {
        for document in &documents {
            mysql.execute("INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (?,'PluginSyncState','account','plugin-sync',?,1,NOW(),NOW())", (owner,document.clone())).await?;
        }
        let rejected = post(owner,"/api/plugins/local-sync",json!({"protocolVersion":1,"pluginSyncVersion":3,"instanceId":"invalid-history","operationId":"unknown"})).await;
        assert_eq!(rejected.status(), brz_http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            rejected.json::<Value>().await?["detail"],
            "plugin_write_conflict"
        );
        let count: Count = mysql
            .fetch_one(
                "SELECT COUNT(*) AS n FROM plugin_states WHERE user_id=?",
                (owner,),
            )
            .await?;
        assert_eq!(count.n, 0);
        let retained: Vec<StoredKind>=mysql.fetch_all("SELECT id,json FROM kinds WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account' ORDER BY id",(owner,)).await?;
        assert_eq!(
            retained.into_iter().map(|row| row.json).collect::<Vec<_>>(),
            documents
        );
    }
    stop.send(()).unwrap();
    task.await??;
    Ok(())
}
