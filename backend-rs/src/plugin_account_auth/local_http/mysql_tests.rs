//! Real account HTTP exchanges with no Device rows or Socket connection.
use super::*;
use crate::{Application, auth::AppAuthenticator, config::AuthConfig};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

mod recovery;

const SIGNING: &str = "native-plugin-contract-test";
const OWNER: i64 = 82001;
const USER: &str = "native-plugin-owner";

#[tokio::test]
#[ignore = "requires disposable MySQL/Redis and plugin credential keyring"]
async fn http_auth_execution_lifecycle_and_uncertain_recovery_without_device() -> anyhow::Result<()>
{
    assert!(crate::plugins_installed::local_sync_enabled());
    crate::migrations::mysql_tests::isolated(verify).await
}
struct Api {
    base: String,
    client: brz_http::Client,
}
impl Api {
    async fn call(&self, token: &str, operation: &str, data: Value, status: u16) -> Value {
        let response = self
            .client
            .post(format!("{}{}", self.base, PATH))
            .unwrap()
            .json(&json!({"operation":operation,"native_token":token,"data":data}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status, "{operation}");
        response.json().await.unwrap()
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
    let api = Api {
        base: format!("http://{address}"),
        client: brz_http::Client::new(),
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
    api.call(token, "plugin.auth.oauth.finish", finish.clone(), 200)
        .await;
    api.call(token, "plugin.auth.oauth.finish", finish, 200)
        .await;
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
    api.call(token, "plugin.auth.oauth.revoke_finish", done.clone(), 200)
        .await;
    api.call(token, "plugin.auth.oauth.revoke_finish", done, 200)
        .await;
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
    api.call(token,"plugin.auth.oauth.finish",json!({"connection_id":lease["connection_id"],"operation_id":lease["operation_id"],"succeeded":false,"attempted":true}),200).await;
    let blocked = api
        .call(token, "plugin.auth.oauth.begin", execution, 409)
        .await;
    assert_eq!(blocked["detail"], "plugin_auth_reconnect_required");
    recovery::verify_refresh_relogin(&api, token, mysql).await?;
    recovery::verify_interleaved_logins(&api, token, &state).await?;
    verify_unicode_account(&api, token, mysql).await?;
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
    mysql
        .execute("UPDATE users SET is_active=0 WHERE id=?", (OWNER,))
        .await?;
    api.call(token, "plugin.auth.execute", request, 401).await;
    stop.send(()).unwrap();
    task.await??;
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
    let complete = api
        .call(token, "plugin.auth.transfer.finish", finish.clone(), 200)
        .await;
    let replay = api
        .call(token, "plugin.auth.transfer.finish", finish, 200)
        .await;
    assert_eq!(complete, replay);
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
