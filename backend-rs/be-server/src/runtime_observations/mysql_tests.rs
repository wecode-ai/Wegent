//! Reuses the Backend Rust CI MySQL fixture and real HTTP authentication.
use std::sync::Arc;

use brz_mysql::FromMysqlRow;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wegent_runtime_observations::test_support::{canonical_hash, command};

#[derive(FromMysqlRow)]
struct Document {
    id: i64,
    json: Value,
}

const DEVICE_KEY: &str = "wg-observation-device-fixture";

async fn seed_device_keys(mysql: &brz_mysql::MysqlService) -> anyhow::Result<()> {
    for (token, kind, active, expires) in [
        (DEVICE_KEY, "personal", true, "2999-01-01 00:00:00"),
        (
            "wg-observation-revoked",
            "personal",
            false,
            "2999-01-01 00:00:00",
        ),
        (
            "wg-observation-expired",
            "personal",
            true,
            "2000-01-01 00:00:00",
        ),
        (
            "wg-observation-service",
            "service",
            true,
            "2999-01-01 00:00:00",
        ),
    ] {
        let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
        mysql.execute("INSERT INTO api_keys (user_id,key_hash,key_prefix,name,key_type,description,is_active,expires_at,last_used_at,created_at,updated_at) VALUES (981002,?,'fixture','observation-auth',?,'',?,?,NOW(),NOW(),NOW())",(hash,kind,active,expires)).await?;
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires disposable WEGENT_TEST_MYSQL_ADDRESS; invoked by Backend Rust CI"]
async fn durable_storage_and_scoped_collector_http() -> anyhow::Result<()> {
    crate::migrations::mysql_tests::isolated(verify).await
}

fn attach(task: &str) -> Value {
    let source = json!({"providerId":"documents","profile":"account","kind":"document","id":"release","name":"Release document"});
    let request_intent = json!({"source":source,"match":{"/eventType":"document.updated"},"continuation":"Continue original work","wait_for_event":false});
    let mut activation = source;
    activation["enabledAfter"] = json!("2026-11-15T00:00:00Z");
    json!({"action":"attach","initialCheckpoint":{"cursor":0},"subscription":{"subscription_key":"wait","device_id":"owned-device","task_id":task,"session":{"engine":"Codex","id":"original-thread"},"source":activation,"match":request_intent["match"],"continuation":request_intent["continuation"],"request_intent":request_intent}})
}

async fn verify(mysql: &brz_mysql::MysqlService) -> anyhow::Result<()> {
    crate::migrations::upgrade(mysql).await?;
    #[derive(FromMysqlRow)]
    struct Schema {
        name: String,
    }
    let schema: Schema = mysql.fetch_one("SELECT DATABASE() AS name", ()).await?;
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")?;
    let parallel = brz_mysql::MysqlService::connect_lazy_with_options(
        &format!("mysql://root@{address}/{}?ssl-mode=disabled", schema.name),
        crate::startup::mysql::pool_options().with_max_connections(2),
    )?;
    let result = verify_accounts(&parallel).await;
    parallel.close().await;
    result
}

async fn verify_accounts(mysql: &brz_mysql::MysqlService) -> anyhow::Result<()> {
    for id in [981001, 981002] {
        mysql.execute("INSERT INTO users (id,user_name,password_hash,email,is_active,role,auth_source,preferences,git_info,created_at,updated_at) VALUES (?,?,'unused','',1,'user','password','{}','{}',NOW(),NOW())",(id,format!("observation-user-{id}"))).await?;
    }
    let a = attach("task-a");
    let b = attach("task-b");
    let (first, second) = tokio::join!(command(mysql, 981001, &a), command(mysql, 981001, &b));
    first?;
    second?;
    let snapshot = command(mysql, 981001, &json!({"action":"list"})).await?;
    anyhow::ensure!(snapshot["observations"].as_object().unwrap().len() == 1);
    anyhow::ensure!(snapshot["subscriptions"].as_object().unwrap().len() == 2);
    let rows:Vec<Document>=mysql.fetch_all("SELECT id,json FROM kinds WHERE user_id=981001 AND kind='RuntimeObservations' AND namespace='wework' AND name='account' AND is_active=1",()).await?;
    anyhow::ensure!(
        rows.len() == 1,
        "Concurrent first registrations must create one account ledger"
    );
    let lease = command(mysql, 981001, &json!({"action":"claim"})).await?;
    let before = command(mysql, 981001, &json!({"action":"list"})).await?;
    let invalid = json!({"action":"commit","observationId":lease["observation"]["id"],"leaseId":lease["lease"]["id"],"page":{"events":[{"id":"first","eventType":"document.updated"},7],"nextCheckpoint":{"cursor":999}}});
    anyhow::ensure!(command(mysql, 981001, &invalid).await.is_err());
    anyhow::ensure!(
        command(mysql, 981001, &json!({"action":"list"})).await? == before,
        "Rejected pages must roll back every durable change"
    );
    let mut valid = invalid;
    valid["page"]["events"] =
        json!([{"id":"first","eventType":"document.updated","at":"2026-11-15T00:00:01Z"}]);
    valid["page"]["nextCheckpoint"] = json!({"cursor":1});
    let (a, b) = tokio::join!(
        command(mysql, 981001, &valid),
        command(mysql, 981001, &valid)
    );
    anyhow::ensure!(
        a? == b?,
        "Concurrent identical commits return one original receipt"
    );
    let persisted = command(mysql, 981001, &json!({"action":"list"})).await?;
    anyhow::ensure!(persisted["deliveries"].as_object().unwrap().len() == 2);
    verify_collector_migration(mysql, 981001).await?;
    anyhow::ensure!(
        persisted["observations"][lease["observation"]["id"].as_str().unwrap()]["events"]
            .as_array()
            .unwrap()
            .len()
            == 1
    );
    let private = command(mysql, 981002, &json!({"action":"list"})).await?;
    anyhow::ensure!(private["subscriptions"].as_object().unwrap().is_empty());
    command(mysql, 981002, &json!({"action":"claim"})).await?;
    command(mysql, 981002, &json!({"action":"claim_delivery"})).await?;
    let empty: Vec<Document> = mysql.fetch_all("SELECT id,json FROM kinds WHERE user_id=981002 AND kind='RuntimeObservations' AND namespace='wework' AND name='account' AND is_active=1",()).await?;
    anyhow::ensure!(
        empty.is_empty(),
        "Idle scheduler reads must not create account ledgers"
    );
    verify_http(mysql).await?;
    Ok(())
}

async fn verify_collector_migration(
    mysql: &brz_mysql::MysqlService,
    owner: i64,
) -> anyhow::Result<()> {
    let query = "SELECT id,json FROM kinds WHERE user_id=? AND kind='RuntimeObservations' AND namespace='wework' AND name='account' AND is_active=1";
    let original: Document = mysql.fetch_one(query, (owner,)).await?;
    let mut legacy = original.json.clone();
    legacy["version"] = json!(1);
    for row in legacy["observations"].as_object_mut().unwrap().values_mut() {
        let device = row["collector"]["deviceId"].clone();
        row.as_object_mut().unwrap().remove("collector");
        row["collectorDeviceId"] = device;
    }
    mysql.execute("UPDATE kinds SET json=? WHERE id=? AND user_id=? AND kind='RuntimeObservations' AND namespace='wework' AND name='account'", (legacy,original.id,owner)).await?;
    command(mysql, owner, &json!({"action":"list"})).await?;
    let upgraded: Document = mysql.fetch_one(query, (owner,)).await?;
    anyhow::ensure!(
        upgraded.id == original.id && upgraded.json == original.json,
        "A real durable v1 upgrade must preserve the cursor, deliveries, activation positions and leases"
    );
    Ok(())
}

async fn verify_http(mysql: &brz_mysql::MysqlService) -> anyhow::Result<()> {
    seed_device_keys(mysql).await?;
    let mut state = crate::app_test_support::app(mysql.clone());
    Arc::get_mut(&mut state).unwrap().redis =
        Some(crate::startup::redis::shared(&crate::config::RedisConfig::from_env()?).await?);
    Arc::get_mut(&mut state)
        .unwrap()
        .internal_chat
        .internal_service_token = Some("observation-test-service".into());
    let app = crate::Application::build(state.clone()).await?;
    let server = crate::http_server::Server::bind_with_authenticator(
        "127.0.0.1:0".parse()?,
        app.routes,
        crate::auth::AppAuthenticator::new(state.authentication_services()),
    )
    .await?;
    let address = server.local_addr()?;
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let serving = tokio::spawn(async move {
        server
            .serve_until(async {
                let _ = stopped.await;
            })
            .await
    });
    let client = brz_http::Client::new();
    let post = |path: &str, token: &str, body: Value| {
        let client = client.clone();
        let url = format!("http://{address}{path}");
        let token = token.to_owned();
        async move {
            client
                .post(url)?
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
        }
    };
    let result=async {
        let user=jsonwebtoken::encode(&jsonwebtoken::Header::default(),&json!({"sub":"observation-user-981002","exp":chrono::Utc::now().timestamp()+300}),&jsonwebtoken::EncodingKey::from_secret(state.auth.jwt_key.as_bytes()))?;
        let task_token=jsonwebtoken::encode(&jsonwebtoken::Header::default(),&json!({"type":"task_token","task_id":42,"subtask_id":43,"user_id":981002,"user_name":"observation-user-981002","exp":chrono::Utc::now().timestamp()+300}),&jsonwebtoken::EncodingKey::from_secret(state.auth.jwt_key.as_bytes()))?;
        anyhow::ensure!(wegent_identity::task_token::verify(&state.auth,Some(&format!("Bearer {task_token}"))).is_some(),"The rejected task token must carry a valid signed task identity");
        for credential in ["wg-observation-revoked", "wg-observation-expired", "wg-observation-service", task_token.as_str(), "observation-test-service"] {
            let denied=post("/api/runtime-observations/command",credential,json!({"action":"list"})).await?;
            anyhow::ensure!(denied.status().as_u16()==401,"Revoked, expired, non-personal, task-scoped and service credentials cannot access an account observation ledger");
        }
        let stopped=post("/api/runtime-observations/command",&user,json!({"action":"stop_observer","observerId":"unknown","generation":"before-first-activation"})).await?;
        anyhow::ensure!(stopped.status().as_u16()==200 && stopped.json::<Value>().await?["stopped"]==true,"Stopping an unknown UI activation must remain idempotent before any registration");
        let rows:Vec<Document>=mysql.fetch_all("SELECT id,json FROM kinds WHERE user_id=981002 AND kind='RuntimeObservations' AND namespace='wework' AND name='account' AND is_active=1",()).await?;
        anyhow::ensure!(rows.is_empty(),"An idempotent stop cannot create an empty or invalid account ledger");
        let attached=post("/api/runtime-observations/command",DEVICE_KEY,attach("cloud-task")).await?;
        anyhow::ensure!(attached.status().as_u16()==200,"A personal device key must register its owner's Runtime observation subscription; received {}",attached.status());
        let attached=attached.json::<Value>().await?;
        let before=command(mysql,981002,&json!({"action":"list"})).await?;
        let mut task_attach=attach("forged-task");
        task_attach["action"]=json!("attach_task");
        task_attach["subscription"]["collector"]=json!({"kind":"device","deviceId":"owned-device"});
        task_attach["subscription"]["target"]=json!({"kind":"backend_task","taskId":42,"botId":23,"session":{"engine":"Codex","id":"forged-thread"}});
        let denied=post("/api/runtime-observations/command",&user,task_attach.clone()).await?;
        anyhow::ensure!(denied.status().as_u16()==400,"Device-session commands cannot declare a Backend Task execution identity");
        task_attach["action"]=json!("attach");
        let denied=post("/api/runtime-observations/command",&user,task_attach).await?;
        anyhow::ensure!(denied.status().as_u16()==400,"A caller-provided task target cannot be smuggled into device registration");
        anyhow::ensure!(command(mysql,981002,&json!({"action":"list"})).await?==before,"Rejected task registrations cannot mutate the account ledger");
        let mut wrong_owner=attach("wrong-owner"); wrong_owner["expectedOwnerId"]=json!(981001);
        for credential in [user.as_str(),DEVICE_KEY] {
            let denied=post("/api/runtime-observations/command",credential,wrong_owner.clone()).await?;
            anyhow::ensure!(denied.status().as_u16()==403,"An account change between registration attempts must not write into the newly connected owner's ledger");
        }
        anyhow::ensure!(command(mysql,981002,&json!({"action":"list"})).await?==before);
        let own=post("/api/runtime-observations/command",&user,json!({"action":"get_subscription","subscriptionId":attached["subscriptionId"]})).await?;
        anyhow::ensure!(own.status().as_u16()==200);
        let own=own.json::<Value>().await?;
        anyhow::ensure!(own["ownerId"]==981002 && own["subscription"]["id"]==attached["subscriptionId"]);
        anyhow::ensure!(own["subscription"]["requestIntent"]==attach("cloud-task")["subscription"]["request_intent"] && own["subscription"]["subscriptionKey"]=="wait","A cold task must recover its exact original tool arguments");
        anyhow::ensure!(own["observation"].get("checkpoint").is_none() && own["observation"].get("events").is_none());
        let recovery_query=json!({"action":"get_task_subscriptions","deviceId":"owned-device","taskId":"cloud-task"});
        let recovered=post("/api/runtime-observations/command",&user,recovery_query.clone()).await?;
        anyhow::ensure!(recovered.status().as_u16()==200);
        let recovered=recovered.json::<Value>().await?;
        let mut own_projection=own.clone();
        own_projection.as_object_mut().unwrap().remove("ownerId");
        anyhow::ensure!(recovered["ownerId"]==981002 && recovered["subscriptions"]==json!([own_projection]));
        anyhow::ensure!(command(mysql,981002,&json!({"action":"list"})).await?==before,"Cold recovery must not mutate durable subscription state");
        let mut foreign_query=recovery_query;
        foreign_query["taskId"]=json!("task-a");
        let recovered=post("/api/runtime-observations/command",&user,foreign_query).await?.json::<Value>().await?;
        anyhow::ensure!(recovered["subscriptions"]==json!([]),"Task recovery cannot cross the authenticated account ledger");
        let foreign=command(mysql,981001,&json!({"action":"list"})).await?;
        let foreign_id=foreign["subscriptions"].as_object().unwrap().keys().next().unwrap();
        for credential in [user.as_str(),DEVICE_KEY] {
            let denied=post("/api/runtime-observations/command",credential,json!({"action":"get_subscription","subscriptionId":foreign_id})).await?;
            anyhow::ensure!(denied.status().as_u16()==404,"A subscription identifier cannot cross the authenticated account ledger");
        }
        for credential in [user.as_str(),DEVICE_KEY] {
            let denied=post("/api/internal/runtime-observations/command",credential,json!({"userId":981002,"action":"claim"})).await?;
            anyhow::ensure!(denied.status().as_u16()==401,"Session and personal device credentials cannot claim worker leases");
        }
        let claimed=post("/api/internal/runtime-observations/command","observation-test-service",json!({"userId":981002,"action":"claim"})).await?.json::<Value>().await?;
        let token=claimed["collectorToken"].as_str().ok_or_else(||anyhow::anyhow!("Scoped collector token missing"))?;
        for body in [json!([]), json!("invalid")] {
            let invalid=post("/api/runtime-observations/collector",token,body).await?;
            anyhow::ensure!(invalid.status().as_u16()==400,"Non-object collector requests require an explicit input error");
        }
        let lease=post("/api/runtime-observations/collector",token,json!({"action":"read_lease","userId":981001,"observationId":"forged","leaseId":"forged"})).await?;
        anyhow::ensure!(lease.status().as_u16()==200);
        let lease=lease.json::<Value>().await?;
        anyhow::ensure!(lease["ownerId"]==981002 && lease["observation"]["id"]==claimed["observation"]["id"],"Body fields cannot replace the sealed owner/source/lease");
        let denied=post("/api/runtime-observations/collector",token,json!({"action":"claim_delivery"})).await?;
        anyhow::ensure!(denied.status().as_u16()==403,"Plugin collectors cannot dispatch model work");
        let denied=post("/api/runtime-observations/command",token,json!({"action":"list"})).await?;
        anyhow::ensure!(denied.status().as_u16()==401,"Collector tokens are not user sessions");
        let committed=post("/api/runtime-observations/collector",token,json!({"action":"commit","page":{"events":[{"id":"cloud-update","eventType":"document.updated","at":"2026-11-15T00:00:01Z"}],"nextCheckpoint":{"cursor":1}}})).await?;
        anyhow::ensure!(committed.status().as_u16()==200);
        let pending=post("/api/internal/runtime-observations/command","observation-test-service",json!({"userId":981002,"action":"claim_delivery"})).await?.json::<Value>().await?;
        anyhow::ensure!(pending["delivery"]["subscriptionId"]==attached["subscriptionId"]);
        let renewal=json!({"userId":981002,"action":"renew_delivery","deliveryId":pending["delivery"]["id"],"leaseId":pending["delivery"]["lease"]["id"]});
        let denied=post("/api/runtime-observations/collector",token,renewal.clone()).await?;
        anyhow::ensure!(denied.status().as_u16()==403,"Collectors cannot extend delivery authority");
        let denied=post("/api/runtime-observations/command",&user,renewal.clone()).await?;
        anyhow::ensure!(denied.status().as_u16()==400,"Session commands cannot impersonate the delivery worker");
        let renewed=post("/api/internal/runtime-observations/command","observation-test-service",renewal).await?;
        anyhow::ensure!(renewed.status().as_u16()==200);
        let canonical=post("/api/runtime-observations/command",&user,json!({"action":"get_subscription","subscriptionId":attached["subscriptionId"]})).await?.json::<Value>().await?;
        anyhow::ensure!(canonical["delivery"]["events"][0]["id"]=="cloud-update" && canonical["delivery"]["lease"]["id"]==pending["delivery"]["lease"]["id"]);
        let admission=json!({"action":"admit_delivery","subscriptionId":attached["subscriptionId"],"deliveryId":pending["delivery"]["id"],"leaseId":pending["delivery"]["lease"]["id"],"taskId":"cloud-task","deviceId":"owned-device","operationId":"durable-operation"});
        let private_reservation=json!({"action":"reserve_task_delivery","userId":981002});
        for (path,credential,status) in [
            ("/api/runtime-observations/command",user.as_str(),400),
            ("/api/internal/runtime-observations/command","observation-test-service",400),
            ("/api/runtime-observations/collector",token,403),
        ] {
            anyhow::ensure!(post(path,credential,private_reservation.clone()).await?.status().as_u16()==status,
                "HTTP credentials cannot reserve a Backend Task turn");
        }
        let mut forged=admission.clone(); forged["taskId"]=json!("other-task");
        anyhow::ensure!(post("/api/runtime-observations/command",&user,forged).await?.status().as_u16()==409);
        let admitted=post("/api/runtime-observations/command",&user,admission.clone()).await?;
        anyhow::ensure!(admitted.status().as_u16()==200 && admitted.json::<Value>().await?["admitted"]==true);
        let cancelled=post("/api/runtime-observations/command",&user,json!({"action":"cancel","subscriptionId":attached["subscriptionId"]})).await?.json::<Value>().await?;
        anyhow::ensure!(cancelled["deliveryAdmitted"]==true && cancelled["subscription"]["terminalSynced"]!=true,"Cancellation retains and reports an earlier durable admission until the Runtime acknowledges its projection");
        anyhow::ensure!(post("/api/runtime-observations/command",&user,admission).await?.status().as_u16()==409,"A cancelled delivery cannot obtain fresh admission");
        let projected=post("/api/runtime-observations/command",&user,json!({"action":"ack_projection","subscriptionId":attached["subscriptionId"]})).await?;
        anyhow::ensure!(projected.status().as_u16()==200);
        let canonical=post("/api/runtime-observations/command",&user,json!({"action":"get_subscription","subscriptionId":attached["subscriptionId"]})).await?.json::<Value>().await?;
        anyhow::ensure!(canonical["subscription"]["status"]=="cancelled" && canonical["subscription"]["terminalSynced"]==true);
        let late=attach("late-registration");
        let mut cancel_first=late.clone(); cancel_first["action"]=json!("cancel_registration"); cancel_first["expectedOwnerId"]=json!(981002);
        let cancelled=post("/api/runtime-observations/command",&user,cancel_first).await?;
        anyhow::ensure!(cancelled.status().as_u16()==200 && cancelled.json::<Value>().await?["subscription"]["status"]=="cancelled");
        let late=post("/api/runtime-observations/command",&user,late).await?.json::<Value>().await?;
        anyhow::ensure!(late["subscription"]["status"]=="cancelled","A delayed registration request must not reactivate a cancelled wait");
        anyhow::ensure!(command(mysql,981002,&json!({"action":"claim"})).await?["lease"].is_null());
        let observer_input=json!({"action":"observe","expectedOwnerId":981002,"initialCheckpoint":{"cursor":9},"observer":{"deviceId":"owned-device","consumerKey":"status-window","generation":"window-activation","source":attach("observer")["subscription"]["source"]}});
        let observing=post("/api/runtime-observations/command",&user,observer_input).await?;
        anyhow::ensure!(observing.status().as_u16()==200);
        let observing=observing.json::<Value>().await?;
        anyhow::ensure!(observing["ownerId"]==981002 && observing["observer"]["expiresAt"].as_i64().is_some());
        for field in ["checkpoint","events","lease"] { anyhow::ensure!(observing["observation"].get(field).is_none()); }
        let renew_observer=json!({"action":"renew_observer","observerId":observing["observer"]["id"],"deviceId":"owned-device","generation":"window-activation"});
        let another=jsonwebtoken::encode(&jsonwebtoken::Header::default(),&json!({"sub":"observation-user-981001","exp":chrono::Utc::now().timestamp()+300}),&jsonwebtoken::EncodingKey::from_secret(state.auth.jwt_key.as_bytes()))?;
        anyhow::ensure!(post("/api/runtime-observations/command",&another,renew_observer.clone()).await?.status().as_u16()==404,"Observer identifiers cannot cross account ledgers");
        anyhow::ensure!(post("/api/runtime-observations/collector",token,renew_observer.clone()).await?.status().as_u16()==403,"Collector credentials cannot keep UI consumers alive");
        let renewed=post("/api/runtime-observations/command",&user,renew_observer).await?;
        anyhow::ensure!(renewed.status().as_u16()==200 && renewed.json::<Value>().await?["observer"]["id"]==observing["observer"]["id"]);
        anyhow::ensure!(command(mysql,981002,&json!({"action":"claim"})).await?["lease"].is_object(),"The UI can keep collection alive after model subscriptions stop");
        let stopped=post("/api/runtime-observations/command",&user,json!({"action":"stop_observer","observerId":observing["observer"]["id"],"generation":"window-activation"})).await?;
        anyhow::ensure!(stopped.status().as_u16()==200);
        anyhow::ensure!(command(mysql,981002,&json!({"action":"claim"})).await?["lease"].is_null());
        let late_observer=json!({"deviceId":"owned-device","consumerKey":"late-ui","generation":"late-activation","source":attach("observer")["subscription"]["source"]});
        let late_id=canonical_hash(&json!(["observer","owned-device","late-ui","late-activation"]));
        let stopped=post("/api/runtime-observations/command",&user,json!({"action":"stop_observer","observerId":late_id,"generation":"late-activation","observer":late_observer,"initialCheckpoint":{"cursor":77}})).await?;
        anyhow::ensure!(stopped.status().as_u16()==200);
        let late=post("/api/runtime-observations/command",&user,json!({"action":"observe","observer":late_observer,"initialCheckpoint":{"cursor":77}})).await?;
        anyhow::ensure!(late.status().as_u16()==409,"Stopping an unconfirmed registration must fence its late arrival");
        anyhow::ensure!(command(mysql,981002,&json!({"action":"claim"})).await?["lease"].is_null());
        mysql.execute("UPDATE users SET is_active=0 WHERE id=981002",()).await?;
        let denied=post("/api/runtime-observations/collector",token,json!({"action":"renew"})).await?;
        anyhow::ensure!(denied.status().as_u16()==404,"Revoked owners cannot renew collection");
        Ok::<(),anyhow::Error>(())
    }.await;
    let _ = stop.send(());
    serving.await??;
    result
}
