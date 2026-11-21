//! Real account HTTP exchanges with no Device rows or Socket connection.
use crate::{Application, auth::AppAuthenticator, config::AuthConfig};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use brz_mysql::MysqlResult;
use brz_mysql::MysqlTransaction;
use brz_redis::Redis;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;
use std::{net::SocketAddr, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use wegent_plugin_runtime::{
    PluginState,
    test_support::{CONTENTION_HEADER, PATH, credentials, write_coordination::PluginWriteLease},
};

mod grant_scopes;
mod recovery;

const SIGNING: &str = "native-plugin-contract-test";
const OWNER: i64 = 82001;
const USER: &str = "native-plugin-owner";

#[tokio::test]
#[ignore = "requires disposable MySQL/Redis and plugin credential keyring"]
async fn http_auth_execution_lifecycle_and_uncertain_recovery_without_device() -> anyhow::Result<()>
{
    assert!(wegent_plugin_runtime::test_support::local_sync_enabled());
    crate::migrations::mysql_tests::isolated(verify).await
}
// Real HTTP, MySQL, and Redis lease work needs an integration timeout budget.
fn http_client() -> brz_http::Client {
    brz_http::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .read_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap()
}

struct Api {
    base: String,
    client: brz_http::Client,
}

#[derive(Clone, Copy)]
enum ResultProtocol {
    Legacy,
    Marked503,
    Business,
    BusinessV2,
}

impl Api {
    async fn call(&self, token: &str, operation: &str, data: Value, status: u16) -> Value {
        let response = self
            .request(token, operation, data, ResultProtocol::Legacy)
            .await;
        let actual = response.status().as_u16();
        let body: Value = response.json().await.unwrap();
        assert_eq!(actual, status, "{operation}: {}", body["detail"]);
        body
    }

    async fn request(
        &self,
        token: &str,
        operation: &str,
        data: Value,
        protocol: ResultProtocol,
    ) -> brz_http::Response {
        let mut request = self
            .client
            .post(format!("{}{}", self.base, PATH))
            .unwrap()
            .json(&json!({"operation":operation,"native_token":token,"data":data}));
        if matches!(
            protocol,
            ResultProtocol::Marked503 | ResultProtocol::Business | ResultProtocol::BusinessV2
        ) {
            request = request.header(CONTENTION_HEADER, "1");
        }
        request = match protocol {
            ResultProtocol::Business => request.header("x-wegent-plugin-auth-result", "1"),
            ResultProtocol::BusinessV2 => request.header("x-wegent-plugin-auth-result", "2"),
            _ => request,
        };
        request.send().await.unwrap()
    }
    async fn session(&self, data: Value, status: u16) -> Value {
        self.call("", "session", data, status).await
    }
}
fn signed(claims: Value) -> String {
    crate::wework_auth_tokens::create_token(SIGNING, "HS256", claims).unwrap()
}
fn native(user: i64, name: &str, key: &str) -> String {
    signed(
        json!({"user_id":user,"sub":name,"thumbprint":key,"token_use":"plugin_native","scope":"plugin_native","exp":chrono::Utc::now().timestamp()+600}),
    )
}
fn desktop_proof(path: &str) -> Value {
    // Public test key: P-256 scalar 1. Never use it outside synthetic tests.
    let jwk = json!({"kty":"EC","crv":"P-256","x":"axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY","y":"T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"});
    let thumbprint =
        URL_SAFE_NO_PAD.encode(Sha256::digest(credentials::canonical(&jwk).as_bytes()));
    let claims =
        crate::wework_auth_tokens::refresh_claims(USER, OWNER as i32, &thumbprint).unwrap();
    let refresh = signed(claims);
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
    header.jwk = Some(serde_json::from_value(jwk).unwrap());
    let der=STANDARD.decode("MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGhRANCAARrF9Hy4SxCR/i85uVjpEDydwN9gS3rM6D0oTlF2JjClk/jQuL+Gn+bjufrSnwPnhYrzjNXazFezsu2QGg3v1H1").unwrap();
    let proof=jsonwebtoken::encode(&header,&json!({"htm":"POST","htu":path,"iat":chrono::Utc::now().timestamp(),"jti":crate::wework_auth_tokens::uuid4_hex().unwrap(),"ath":URL_SAFE_NO_PAD.encode(Sha256::digest(refresh.as_bytes()))}),&jsonwebtoken::EncodingKey::from_ec_der(&der)).unwrap();
    json!({"refresh_token":refresh,"proof":proof})
}
async fn seed(
    mysql: &brz_mysql::MysqlService,
    slug: &str,
    definition: Value,
) -> anyhow::Result<i64> {
    let spec = json!({"source":{"type":"marketplace","providerKey":"test","pluginKey":slug,"catalogItemId":slug,"marketplace":"test"},"enabled":true,"components":{"connectors":[{"slug":slug,"localAuth":{"type":"command"},"accountAuth":definition}]},"packageRef":{"checksum":format!("sha256:{}","a".repeat(64))}});
    mysql.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (?,'InstalledPlugin','default',?,?,1,NOW(),NOW())",(OWNER,slug,json!({"spec":spec}))).await?;
    #[derive(brz_mysql::FromMysqlRow)]
    struct Id {
        id: i64,
    }
    Ok(mysql.fetch_one::<_,_,Id>("SELECT id FROM kinds WHERE user_id=? AND kind='InstalledPlugin' AND namespace='default' AND name=?",(OWNER,slug)).await?.id)
}
async fn intent(api: &Api, token: &str, id: i64, slug: &str) -> String {
    let result=api.call(token,"plugin.auth.automatic",json!({"installed_plugin_ids":[id],"targets":[{"installed_plugin_id":id,"connector_slug":slug}]}),200).await;
    result["migrations"][0]["id"]
        .as_str()
        .expect("one intent")
        .into()
}
async fn enroll(api: &Api, token: &str, id: i64, slug: &str, raw: Value) -> Value {
    let migration = intent(api, token, id, slug).await;
    api.call(token,"plugin.auth.enroll",json!({"migration_id":migration,"account_id":"account","account_label":"Test account","credential":raw.to_string()}),200).await["connection"].clone()
}

async fn verify_lease_promotion(redis: &brz_redis::RedisService) -> anyhow::Result<()> {
    use brz_redis::{SetExpiration, SetOptions, cmd, pipe};
    use wegent_plugin_runtime::test_support::write_coordination::NATIVE_LEASE_PROMOTION_SCRIPT;

    let key = format!(
        "native-lease-promotion-test:{}",
        crate::wework_auth_tokens::uuid4_hex().expect("generate Redis test key")
    );
    // Each pipeline tests one Redis-side ordering without relying on sleeps
    // or the client scheduler to keep a newly seeded key fresh.
    for (initial_ttl, claimed_owner, expected_promotion) in [
        (1_000, "owner", 1),
        (700, "owner", 0),
        (1_000, "previous-owner", 0),
    ] {
        let mut promote = cmd("EVAL");
        promote
            .arg(NATIVE_LEASE_PROMOTION_SCRIPT)
            .arg(1)
            .arg(&key)
            .arg(claimed_owner)
            .arg(800)
            .arg(180_000);
        let mut ttl = cmd("PTTL");
        ttl.arg(&key);
        let mut pipeline = pipe();
        pipeline
            .set_with(
                &key,
                "owner",
                SetOptions::default()
                    .if_absent()
                    .with_expiration(SetExpiration::Milliseconds(initial_ttl)),
            )?
            .command(promote)?
            .command(ttl)?
            .del([&key])?;
        let mut results = redis.pipe(pipeline).await?;
        assert_eq!(results.take_value::<String>().await?, "OK");
        assert_eq!(results.take_value::<i64>().await?, expected_promotion);
        let remaining = results.take_value::<i64>().await?;
        if expected_promotion == 1 {
            assert!((179_000..=180_000).contains(&remaining));
        } else {
            assert!((1..=initial_ttl as i64).contains(&remaining));
        }
        assert_eq!(results.take::<i64>().await?, 1);
    }
    Ok(())
}

async fn verify_short_admission(
    api: &Api,
    token: &str,
    state: &PluginState,
    installed_id: i64,
) -> anyhow::Result<i64> {
    let lifecycle = "plugin.auth.local_lifecycle";
    let login =
        json!({"installed_plugin_id":installed_id,"connector_slug":"mail","action":"login"});
    let redis = state.redis.as_ref().expect("real Redis fixture");
    verify_lease_promotion(redis).await?;
    let account_policy = PluginWriteLease::acquire(Some(redis), OWNER).await?;
    assert_short_busy(api, token, lifecycle, &login, "account policy lease").await;
    account_policy.verify_owned().await?;
    account_policy.release().await;

    // Acquiring this immediately also verifies cleanup of the installation
    // lease held by the request that found the cold account policy busy.
    let installation = PluginWriteLease::acquire_names_wait(
        Some(redis),
        OWNER,
        vec!["mail".into()],
        Duration::ZERO,
    )
    .await?;
    assert_short_busy(api, token, lifecycle, &login, "installation lease").await;
    installation.verify_owned().await?;

    #[derive(brz_mysql::FromMysqlRow)]
    struct Count {
        n: i64,
    }
    let mysql = &state.mysql;
    assert_eq!(
        mysql
            .fetch_one::<_, _, Count>(
                "SELECT COUNT(*) AS n FROM kinds WHERE user_id=? AND namespace='plugin-auth'",
                (OWNER,)
            )
            .await?
            .n,
        0
    );
    assert_eq!(installed_write_revision(mysql, installed_id).await?, 0);

    let read = api
        .request(
            token,
            lifecycle,
            json!({"installed_plugin_id":installed_id,"connector_slug":"mail","action":"status"}),
            ResultProtocol::Business,
        )
        .await;
    assert_eq!(read.status().as_u16(), 200);
    assert!(read.headers().get(CONTENTION_HEADER).is_none());
    let peer = seed(
        mysql,
        "admission-peer",
        json!({"protocolVersion":1,"credentialType":"bearer","adapter":"auth.py"}),
    )
    .await?;
    let peer_login = api
        .request(
            token,
            lifecycle,
            json!({"installed_plugin_id":peer,"connector_slug":"admission-peer","action":"login"}),
            ResultProtocol::Business,
        )
        .await;
    assert_eq!(peer_login.status().as_u16(), 200);
    assert!(peer_login.headers().get(CONTENTION_HEADER).is_none());
    assert_eq!(peer_login.json::<Value>().await.unwrap()["success"], true);
    installation.release().await;
    Ok(peer)
}

async fn assert_short_busy(api: &Api, token: &str, operation: &str, data: &Value, lock: &str) {
    for (protocol, status, body) in [
        (
            ResultProtocol::Marked503,
            503,
            json!({"detail":"plugin_auth_exchange_failed"}),
        ),
        (
            ResultProtocol::Business,
            200,
            json!({"success":false,"error":"plugin_write_busy","retryable":true}),
        ),
        (
            ResultProtocol::BusinessV2,
            200,
            json!({"success":false,"error":"plugin_write_busy","retryable":true}),
        ),
    ] {
        tokio::time::timeout(Duration::from_millis(500), async {
            let response = api.request(token, operation, data.clone(), protocol).await;
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(response.headers()[CONTENTION_HEADER], "busy-before-write");
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(response.json::<Value>().await.unwrap(), body);
        })
        .await
        .unwrap_or_else(|_| {
            panic!("Native authorization did not report a held {lock} within 500 ms")
        });
    }
}

async fn verify_cancelled_write(
    api: &Api,
    token: &str,
    state: &PluginState,
    address: SocketAddr,
    plugin_id: i64,
) -> anyhow::Result<()> {
    let data =
        json!({"installed_plugin_id":plugin_id,"connector_slug":"admission-peer","action":"login"});
    let before = installed_write_revision(&state.mysql, plugin_id).await?;
    let blocker = cancellation_fixture_mysql(&state.mysql).await?;
    let (locked, ready) = oneshot::channel();
    let (release, unlock) = oneshot::channel();
    let block = blocker.with_transaction(async |tx| {
        tx.execute(
            "UPDATE kinds SET json=json WHERE id=? AND user_id=?",
            (plugin_id, OWNER),
        )
        .await?;
        let _ = locked.send(());
        let _ = unlock.await;
        Ok(())
    });
    let disconnect = async {
        ready.await?;
        let mut socket = TcpStream::connect(address).await?;
        let body =
            json!({"operation":"plugin.auth.local_lifecycle","native_token":token,"data":data})
                .to_string();
        let head = format!(
            "POST {PATH} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{CONTENTION_HEADER}: 1\r\n\r\n",
            body.len()
        );
        socket.write_all(head.as_bytes()).await?;
        socket.write_all(body.as_bytes()).await?;
        wait_for_blocked_write(&blocker).await?;
        socket.shutdown().await?;
        let mut byte = [0];
        let read = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut byte)).await??;
        assert_eq!(
            read, 0,
            "the HTTP connection must close before releasing the MySQL row"
        );
        let _ = release.send(());
        Ok::<(), anyhow::Error>(())
    };
    let (blocked, disconnected) = tokio::join!(block, disconnect);
    blocker.close().await;
    blocked?;
    disconnected?;

    let redis = state.redis.as_ref().expect("real Redis fixture");
    tokio::time::timeout(Duration::from_secs(1), async {
        let mut lookup = brz_redis::cmd("GET");
        lookup.arg(format!("wegent:plugin-write:{OWNER}:admission-peer"));
        while redis
            .command::<Option<brz_redis::RedisBytes>>(lookup.clone())
            .await?
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<(), brz_redis::RedisError>(())
    })
    .await
    .expect("a disconnected Native write must release its plugin lease")?;
    assert_eq!(
        installed_write_revision(&state.mysql, plugin_id).await?,
        before + 1,
        "an already-started Native transaction must complete before releasing its lease"
    );
    let response = api
        .request(
            token,
            "plugin.auth.local_lifecycle",
            data,
            ResultProtocol::Business,
        )
        .await;
    assert_eq!(
        response.status().as_u16(),
        200,
        "the next write must take the released lease"
    );
    Ok(())
}

async fn cancellation_fixture_mysql(
    mysql: &brz_mysql::MysqlService,
) -> anyhow::Result<brz_mysql::MysqlService> {
    #[derive(brz_mysql::FromMysqlRow)]
    struct Database {
        name: String,
    }
    let schema: Database = mysql.fetch_one("SELECT DATABASE() AS name", ()).await?;
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")?;
    // Keep the row holder and observer off the isolated application's one-slot pool.
    Ok(brz_mysql::MysqlService::connect_lazy_with_options(
        &format!("mysql://root@{address}/{}?ssl-mode=disabled", schema.name),
        wegent_backend_persistence::connection::pool_options().with_max_connections(2),
    )?)
}

async fn installed_write_revision(mysql: &brz_mysql::MysqlService, id: i64) -> MysqlResult<i64> {
    #[derive(brz_mysql::FromMysqlRow)]
    struct Revision {
        n: i64,
    }
    let revision: Revision = mysql.fetch_one("SELECT COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.writeRevision')) AS SIGNED),0) AS n FROM kinds WHERE user_id=? AND id=?", (OWNER,id)).await?;
    Ok(revision.n)
}

async fn assert_write_receipt_replay(
    api: &Api,
    token: &str,
    mysql: &brz_mysql::MysqlService,
    installed_id: i64,
    operation: &str,
    data: Value,
) -> anyhow::Result<Value> {
    let before = installed_write_revision(mysql, installed_id).await?;
    let first = api
        .request(token, operation, data.clone(), ResultProtocol::BusinessV2)
        .await;
    assert_eq!(first.status().as_u16(), 200, "{operation}");
    let first = first.json::<Value>().await?;
    assert_eq!(first["success"], true, "{operation}");
    assert_eq!(
        installed_write_revision(mysql, installed_id).await?,
        before + 1
    );

    let replay = api
        .request(token, operation, data, ResultProtocol::BusinessV2)
        .await;
    let status = replay.status().as_u16();
    let replay = replay.json::<Value>().await?;
    assert_eq!(status, 200, "{operation} replay: {}", replay["detail"]);
    assert_eq!(replay, first, "{operation}");
    assert_eq!(
        installed_write_revision(mysql, installed_id).await?,
        before + 1,
        "{operation} replay must only return the committed receipt"
    );
    Ok(first)
}

async fn verify_refresh_receipt_replay(
    api: &Api,
    token: &str,
    state: &PluginState,
    installed_id: i64,
    data: Value,
    expected_state: &str,
) -> anyhow::Result<()> {
    let redis = state.redis.as_ref().expect("real Redis fixture");
    let channel = crate::socketio_emit::SOCKETIO_CHANNEL;
    let mut subscription = redis.subscribe(channel).await?;
    let receipt = assert_write_receipt_replay(
        api,
        token,
        &state.mysql,
        installed_id,
        "plugin.auth.oauth.finish",
        data,
    )
    .await?;
    assert_eq!(receipt["state"], expected_state);
    // Both HTTP replies are complete before this ordered pub/sub marker.
    // Seeing the marker second proves no duplicate notification was published.
    let marker = "native-refresh-replay-fixture-complete";
    redis.publish(channel, marker).await?;
    let first = tokio::time::timeout(Duration::from_secs(1), subscription.next_message())
        .await??
        .expect("refresh notification");
    let notification = serde_json::from_slice::<Value>(&first.payload)?;
    assert_eq!(notification["event"], "plugin.auth.changed");
    assert_eq!(notification["room"], format!("user:{OWNER}"));
    assert_eq!(
        notification["data"],
        json!([{"installed_plugin_id":installed_id}])
    );
    let second = tokio::time::timeout(Duration::from_secs(1), subscription.next_message())
        .await??
        .expect("notification completion marker");
    assert_eq!(second.payload.as_ref(), marker.as_bytes());
    subscription.close().await?;
    Ok(())
}

async fn wait_for_blocked_write(mysql: &brz_mysql::MysqlService) -> anyhow::Result<()> {
    #[derive(brz_mysql::FromMysqlRow)]
    struct Count {
        n: i64,
    }
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let waiters: Count = mysql.fetch_one("SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks b ON b.ENGINE_LOCK_ID=w.BLOCKING_ENGINE_LOCK_ID WHERE b.OBJECT_SCHEMA=DATABASE() AND b.OBJECT_NAME='kinds'", ()).await?;
            if waiters.n > 0 {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("the Native write must reach the real MySQL revision update")
}

async fn verify(mysql: &brz_mysql::MysqlService) -> anyhow::Result<()> {
    crate::migrations::upgrade(mysql).await?;
    // Produced by Python PluginCredentialCipher with the synthetic zero key,
    // fixed test nonce and a Unicode account/source. This is format evidence,
    // independent of a Rust encrypt/decrypt round trip.
    let spec = json!({"sourceIdentity":"{\"catalogItemId\":\"id\",\"marketplace\":\"test\",\"pluginKey\":\"\\u4e2d\\u6587\",\"providerKey\":null,\"type\":\"marketplace\"}","connectorSlug":"mail","accountId":"账号","credentialType":"bearer","authDefinition":{"protocolVersion":1,"credentialType":"bearer","adapter":"auth.py"}});
    let vector = json!({"version":1,"keyId":"native-test","nonce":"AAECAwQFBgcICQoL","ciphertext":"8+lHPWuY4dv4WieLlGCxaDFBzvPH6fqEqumZAQ27SgsZAMIz6yDMvG74SQ=="});
    assert_eq!(
        credentials::decrypt(&vector, &credentials::context(OWNER, &spec))?,
        "{\"token\":\"unicode-fixture\"}"
    );
    assert!(credentials::decrypt(&vector, &credentials::context(82002, &spec)).is_err());

    for (id, name) in [(OWNER, USER), (82002, "other-native-user")] {
        mysql.execute("INSERT INTO users (id,user_name,password_hash,email,is_active,role,auth_source,preferences,git_info,created_at,updated_at) VALUES (?,?,'unused','',1,'user','password','{}','{}',NOW(),NOW())",(id,name)).await?;
    }
    let mut state = crate::build_app_state().await?;
    state.mysql = mysql.clone();
    state.user_reader = Arc::new(crate::user_reader::PublicUserReader::new(mysql.clone()));
    state.auth = AuthConfig {
        jwt_key: SIGNING.into(),
        legacy_jwt_keys: vec![],
        algorithm: "HS256".into(),
    };
    let state = Arc::new(state);
    let plugins = state.plugin_runtime_state();
    let app = Application::build(state.clone()).await?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let handler = brz_http_server::hyper::HandlerService::with_authenticator(
        app.routes,
        AppAuthenticator::new(state.authentication_services()),
        crate::filters::server_config(),
    )?;
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(brz_http_server::hyper::serve(
        listener,
        move |_| handler.clone(),
        async {
            let _ = stopped.await;
        },
        Default::default(),
    ));
    let api = Api {
        base: format!("http://{address}"),
        client: http_client(),
    };
    // Session creation proves desktop key possession; no Device query or row exists.
    api.session(desktop_proof("/api/auth/wework/refresh"), 401)
        .await;
    let proof = desktop_proof(PATH);
    let opened = api.session(proof.clone(), 200).await;
    api.session(proof, 401).await;
    let token = opened["native_token"].as_str().unwrap();
    let missing = api
        .call(
            token,
            "plugin.auth.oauth.revoke.begin",
            json!({"connection_id": "c".repeat(64)}),
            409,
        )
        .await;
    assert_eq!(missing["detail"], "plugin_auth_connection_not_found");
    let expired = api
        .call(
            token,
            "plugin.auth.transfer.finish",
            json!({"migration_id": "d".repeat(64)}),
            409,
        )
        .await;
    assert_eq!(expired["detail"], "plugin_auth_migration_expired");
    assert_eq!(opened["account_id"], OWNER);
    assert!(
        crate::auth::verify_token(&state.auth, token).is_err(),
        "plugin sessions cannot authorize shared APIs"
    );
    for wrong in [
        signed(json!({"sub":USER,"exp":chrono::Utc::now().timestamp()+600})),
        desktop_proof(PATH)["refresh_token"]
            .as_str()
            .unwrap()
            .into(),
        native(82002, USER, "forged-owner"),
    ] {
        api.call(
            &wrong,
            "plugin.auth.automatic",
            json!({"installed_plugin_ids":[]}),
            401,
        )
        .await;
    }
    let bearer = seed(
        mysql,
        "mail",
        json!({"protocolVersion":1,"credentialType":"bearer","adapter":"auth.py"}),
    )
    .await?;
    let peer = verify_short_admission(&api, token, &plugins, bearer).await?;
    verify_cancelled_write(&api, token, &plugins, address, peer).await?;
    let connection = enroll(
        &api,
        token,
        bearer,
        "mail",
        json!({"token":"private-bearer"}),
    )
    .await;
    let request =
        json!({"installed_plugin_id":bearer,"connector_slug":"mail","account_id":"account"});
    let execute = api
        .call(token, "plugin.auth.execute", request.clone(), 200)
        .await;
    assert_eq!(
        serde_json::from_str::<Value>(execute["credential"].as_str().unwrap())?["token"],
        "private-bearer"
    );
    let other_key = native(OWNER, USER, "other-key");
    api.call(&other_key, "plugin.auth.execute", request.clone(), 409)
        .await;
    let other_user = native(82002, "other-native-user", "other-key");
    api.call(&other_user, "plugin.auth.execute", request.clone(), 409)
        .await;
    // Native grants do not create a Device grant, and repeated observations do
    // not replace a newer central credential with the source's old export.
    #[derive(brz_mysql::FromMysqlRow)]
    struct Document {
        json: Value,
    }
    let query = "SELECT json FROM kinds WHERE user_id=? AND kind='ConnectorConnection' AND namespace='plugin-auth' AND name=?";
    let row: Document = mysql
        .fetch_one(query, (OWNER, connection["id"].as_str().unwrap()))
        .await?;
    assert_eq!(row.json["spec"]["deviceGrants"], json!({}));
    let mut s = row.json["spec"].clone();
    s["credential"] = credentials::encrypt(
        "{\"token\":\"central-new\"}",
        &credentials::context(OWNER, &s),
    )?;
    mysql.execute("UPDATE kinds SET json=? WHERE user_id=? AND kind='ConnectorConnection' AND namespace='plugin-auth' AND name=?",(json!({"spec":s}),OWNER,connection["id"].as_str().unwrap())).await?;
    enroll(
        &api,
        token,
        bearer,
        "mail",
        json!({"token":"private-bearer"}),
    )
    .await;
    let execute = api
        .call(token, "plugin.auth.execute", request.clone(), 200)
        .await;
    assert!(
        execute["credential"]
            .as_str()
            .unwrap()
            .contains("central-new")
    );
    let lifecycle = json!({"installed_plugin_id":bearer,"connector_slug":"mail","action":"logout"});
    api.call(token, "plugin.auth.local_lifecycle", lifecycle, 200)
        .await;
    api.call(token, "plugin.auth.execute", request.clone(), 409)
        .await;
    api.call(
        token,
        "plugin.auth.local_lifecycle",
        json!({"installed_plugin_id":bearer,"connector_slug":"mail","action":"login"}),
        200,
    )
    .await;
    enroll(
        &api,
        token,
        bearer,
        "mail",
        json!({"token":"explicit-login"}),
    )
    .await;
    api.call(token, "plugin.auth.execute", request.clone(), 200)
        .await;
    mysql.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.components.connectors[0].accountAuth.adapter','changed.py') WHERE user_id=? AND kind='InstalledPlugin' AND namespace='default' AND id=?",(OWNER,bearer)).await?;
    api.call(token, "plugin.auth.execute", request.clone(), 409)
        .await;
    api.call(
        token,
        "plugin.auth.local_lifecycle",
        json!({"installed_plugin_id":bearer,"connector_slug":"mail","action":"login"}),
        200,
    )
    .await;
    enroll(
        &api,
        token,
        bearer,
        "mail",
        json!({"token":"after-definition-change"}),
    )
    .await;
    api.call(token, "plugin.auth.execute", request.clone(), 200)
        .await;
    let malformed = seed(
        mysql,
        "malformed",
        json!({"protocolVersion":2,"credentialType":"bearer","adapter":"auth.py"}),
    )
    .await?;
    let discovery = api
        .call(
            token,
            "plugin.auth.automatic",
            json!({"installed_plugin_ids":[malformed,bearer],"prepare_only":true}),
            200,
        )
        .await;
    assert_eq!(discovery["packages"].as_array().unwrap().len(), 1);
    assert_eq!(discovery["packages"][0]["installed_plugin_id"], bearer);
    // OAuth refresh is one-owner; an uncertain result must never retry a
    // potentially consumed refresh token or leak refresh material to business.
    let oauth=seed(mysql,"oauth",json!({"protocolVersion":1,"credentialType":"oauth2","adapter":"auth.py","oauth2":["refresh","revoke"]})).await?;
    enroll(
        &api,
        token,
        oauth,
        "oauth",
        json!({"access_token":"expired","refresh_token":"old-refresh","expires_at":1}),
    )
    .await;
    let execution =
        json!({"installed_plugin_id":oauth,"connector_slug":"oauth","account_id":"account"});
    api.call(token, "plugin.auth.execute", execution.clone(), 409)
        .await;
    let lease = api
        .call(token, "plugin.auth.oauth.begin", execution.clone(), 200)
        .await;
    assert_eq!(lease["state"], "claimed");
    api.call(token, "plugin.auth.oauth.begin", execution.clone(), 409)
        .await;
    api.call(&other_key,"plugin.auth.oauth.finish",json!({"connection_id":lease["connection_id"],"operation_id":lease["operation_id"],"succeeded":false}),409).await;
    let finish = json!({"connection_id":lease["connection_id"],"operation_id":lease["operation_id"],"succeeded":true,"account_id":"account","credential":json!({"access_token":"fresh-business","refresh_token":"rotated-private","expires_at":chrono::Utc::now().timestamp()+600,"provider_private":{"secret":"private"}}).to_string()});
    verify_refresh_receipt_replay(&api, token, &plugins, oauth, finish, "finished").await?;
    let result = api
        .call(token, "plugin.auth.execute", execution.clone(), 200)
        .await;
    assert_eq!(
        serde_json::from_str::<Value>(result["credential"].as_str().unwrap())?["access_token"],
        "fresh-business"
    );
    let raw = result["credential"].as_str().unwrap();
    assert!(!raw.contains("private") && !raw.contains("refresh_token"));
    // Logout retains revocation escrow while removing both Native and Device grants.
    api.call(
        token,
        "plugin.auth.local_lifecycle",
        json!({"installed_plugin_id":oauth,"connector_slug":"oauth","action":"logout"}),
        200,
    )
    .await;
    let pending = api
        .call(token, "plugin.auth.oauth.revocations", json!({}), 200)
        .await;
    assert_eq!(pending["revocations"].as_array().unwrap().len(), 1);
    let revoke = api
        .call(
            token,
            "plugin.auth.oauth.revoke_begin",
            json!({"connection_id":lease["connection_id"]}),
            200,
        )
        .await;
    api.call(
        token,
        "plugin.auth.oauth.revoke_begin",
        json!({"connection_id":lease["connection_id"]}),
        200,
    )
    .await;
    let done = json!({"connection_id":lease["connection_id"],"operation_id":revoke["operation_id"],"succeeded":true});
    assert_write_receipt_replay(
        &api,
        token,
        mysql,
        oauth,
        "plugin.auth.oauth.revoke_finish",
        done,
    )
    .await?;
    let uncertain=seed(mysql,"uncertain",json!({"protocolVersion":1,"credentialType":"oauth2","adapter":"auth.py","oauth2":["refresh"]})).await?;
    enroll(
        &api,
        token,
        uncertain,
        "uncertain",
        json!({"access_token":"expired","refresh_token":"single-use","expires_at":1}),
    )
    .await;
    let execution = json!({"installed_plugin_id":uncertain,"connector_slug":"uncertain"});
    let lease = api
        .call(token, "plugin.auth.oauth.begin", execution.clone(), 200)
        .await;
    let connection_id = lease["connection_id"].as_str().expect("refresh connection");
    let before: Document = mysql.fetch_one(query, (OWNER, connection_id)).await?;
    let cancelled = json!({"connection_id":lease["connection_id"],"operation_id":lease["operation_id"],"succeeded":false,"attempted":false});
    verify_refresh_receipt_replay(
        &api,
        token,
        &plugins,
        uncertain,
        cancelled.clone(),
        "cancelled",
    )
    .await?;
    let after: Document = mysql.fetch_one(query, (OWNER, connection_id)).await?;
    assert_eq!(
        after.json["spec"]["revision"],
        before.json["spec"]["revision"].as_i64().unwrap() + 1
    );
    let cancelled_revision = installed_write_revision(mysql, uncertain).await?;
    let mut attempted = cancelled.clone();
    attempted["attempted"] = json!(true);
    let mismatched = api
        .call(token, "plugin.auth.oauth.finish", attempted, 409)
        .await;
    assert_eq!(mismatched["detail"], "plugin_auth_reconnect_required");
    let wrong_principal = api
        .call(
            &other_key,
            "plugin.auth.oauth.finish",
            cancelled.clone(),
            409,
        )
        .await;
    assert_eq!(wrong_principal["detail"], "plugin_auth_operation_mismatch");
    assert_eq!(
        installed_write_revision(mysql, uncertain).await?,
        cancelled_revision
    );

    let next = api
        .call(token, "plugin.auth.oauth.begin", execution.clone(), 200)
        .await;
    assert_eq!(next["state"], "claimed");
    assert_ne!(next["operation_id"], lease["operation_id"]);
    let stale = api
        .call(token, "plugin.auth.oauth.finish", cancelled, 409)
        .await;
    assert_eq!(stale["detail"], "plugin_auth_operation_mismatch");
    let finish = json!({"connection_id":next["connection_id"],"operation_id":next["operation_id"],"succeeded":false,"attempted":true});
    let result = api
        .call(token, "plugin.auth.oauth.finish", finish, 200)
        .await;
    assert_eq!(result["state"], "uncertain");
    let blocked = api
        .call(token, "plugin.auth.oauth.begin", execution, 409)
        .await;
    assert_eq!(blocked["detail"], "plugin_auth_reconnect_required");
    recovery::verify_refresh_relogin(&api, token, mysql).await?;
    recovery::verify_interleaved_logins(&api, token, &plugins).await?;
    verify_unicode_account(&api, token, mysql).await?;
    verify_transfer_abort(&api, token, mysql).await?;
    verify_transfer(&api, token, mysql).await?;
    #[derive(brz_mysql::FromMysqlRow)]
    struct Count {
        n: i64,
    }
    assert_eq!(
        mysql
            .fetch_one::<_, _, Count>("SELECT COUNT(*) AS n FROM kinds WHERE kind='Device'", ())
            .await?
            .n,
        0
    );
    grant_scopes::verify(&api, token, &plugins).await?;
    mysql
        .execute("UPDATE users SET is_active=0 WHERE id=?", (OWNER,))
        .await?;
    api.call(token, "plugin.auth.execute", request, 401).await;
    stop.send(()).unwrap();
    task.await??;
    Ok(())
}

async fn verify_transfer_abort(
    api: &Api,
    token: &str,
    mysql: &brz_mysql::MysqlService,
) -> anyhow::Result<()> {
    let id=seed(mysql,"exclusive-abort",json!({"protocolVersion":1,"credentialType":"oauth2","exportMode":"exclusive","adapter":"auth.py","oauth2":["refresh"]})).await?;
    let migration = intent(api, token, id, "exclusive-abort").await;
    let stage = json!({"migration_id":migration,"account_id":"account","credential":json!({"access_token":"aborted-copy","refresh_token":"aborted-refresh"}).to_string()});
    assert_write_receipt_replay(api, token, mysql, id, "plugin.auth.transfer.stage", stage).await?;
    assert_write_receipt_replay(
        api,
        token,
        mysql,
        id,
        "plugin.auth.transfer.abort",
        json!({"migration_id":migration}),
    )
    .await?;
    Ok(())
}

async fn verify_transfer(
    api: &Api,
    token: &str,
    mysql: &brz_mysql::MysqlService,
) -> anyhow::Result<()> {
    let id=seed(mysql,"exclusive",json!({"protocolVersion":1,"credentialType":"oauth2","exportMode":"exclusive","adapter":"auth.py","oauth2":["refresh"]})).await?;
    let migration = intent(api, token, id, "exclusive").await;
    let stage = json!({"migration_id":migration,"account_id":"account","credential":json!({"access_token":"only-copy","refresh_token":"only-refresh"}).to_string()});
    api.call(token, "plugin.auth.transfer.stage", stage.clone(), 200)
        .await;
    mysql.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.enabled',false) WHERE user_id=? AND kind='ConnectorAuthPolicy' AND namespace='plugin-auth' AND name='account'",(OWNER,)).await?;
    let recovery = api
        .call(
            token,
            "plugin.auth.automatic",
            json!({"installed_plugin_ids":[id],"prepare_only":true}),
            200,
        )
        .await;
    assert_eq!(
        recovery["packages"].as_array().unwrap().len(),
        1,
        "disabling automation cannot strand staged escrow"
    );
    assert_eq!(intent(api, token, id, "exclusive").await, migration);
    // A replay after a lost stage ACK cannot overwrite the only escrow copy.
    let mut replay = stage;
    replay["credential"] = json!("{\"access_token\":\"different\"}");
    api.call(token, "plugin.auth.transfer.stage", replay, 200)
        .await;
    let request =
        json!({"installed_plugin_id":id,"connector_slug":"exclusive","account_id":"account"});
    api.call(token, "plugin.auth.execute", request.clone(), 409)
        .await;
    let prepared = api
        .call(
            token,
            "plugin.auth.transfer.prepare",
            json!({"migration_id":migration}),
            200,
        )
        .await;
    assert!(
        prepared["credential"]
            .as_str()
            .unwrap()
            .contains("only-refresh")
    );
    let finish = json!({"migration_id":migration});
    assert_write_receipt_replay(api, token, mysql, id, "plugin.auth.transfer.finish", finish)
        .await?;
    api.call(token, "plugin.auth.execute", request, 200).await;
    Ok(())
}

// Legacy schemas count Unicode characters, not UTF-8 bytes. This exercises
// both request acceptance and the persisted account ID used by refresh.
async fn verify_unicode_account(
    api: &Api,
    token: &str,
    mysql: &brz_mysql::MysqlService,
) -> anyhow::Result<()> {
    let id=seed(mysql,"unicode-account",json!({"protocolVersion":1,"credentialType":"oauth2","adapter":"auth.py","oauth2":["refresh"]})).await?;
    let account = "账".repeat(128);
    let migration = intent(api, token, id, "unicode-account").await;
    let connection=api.call(token,"plugin.auth.enroll",json!({"migration_id":migration,"account_id":account,"account_label":"名".repeat(128),"credential":json!({"access_token":"expired","refresh_token":"unicode-refresh","expires_at":1}).to_string()}),200).await;
    assert_eq!(connection["connection"]["account_id"], account);
    let refresh=api.call(token,"plugin.auth.oauth.begin",json!({"installed_plugin_id":id,"connector_slug":"unicode-account","account_id":account}),200).await;
    assert_eq!(refresh["state"], "claimed");
    Ok(())
}
