// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Real gateway, subscription transaction, polling and MySQL delivery;
//! only the external provider boundary is simulated.

#[path = "../../tests/support/assignments_http.rs"]
#[allow(dead_code)]
mod http;
#[path = "../../../shared/issue_follow_test_provider.rs"]
mod provider;

use super::super::{test_data as data, test_fixture as fixture};
use super::*;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn config(source: &str, base: &str, key: &str) -> Value {
    let context = format!("{source}:127.0.0.1:acme/repo");
    let material = Sha256::digest(format!("wegent-cloud-project-provider:{key}").as_bytes());
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&material).unwrap();
    let nonce = [1u8; 12];
    let encrypted = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: b"test-token",
                aad: context.as_bytes(),
            },
        )
        .unwrap();
    let encode = base64::engine::general_purpose::STANDARD;
    json!({"repository":"acme/repo","domain":"127.0.0.1","api_base":base,"credential":{"version":2,"algorithm":"aes-256-gcm","context":context,"nonce":encode.encode(nonce),"ciphertext":encode.encode(encrypted)}})
}

async fn following(server: &http::Server, value: bool) {
    assert_eq!(
        http::request(
            &server.base,
            "PUT",
            "EXT-7/follow",
            Some(&http::token(8, 300)),
            Some(json!({"following":value}))
        )
        .await,
        (200, json!({"following":value}))
    );
}

async fn inbox(server: &http::Server) -> Vec<Value> {
    let response = brz_http::Client::new()
        .get(format!(
            "{}/api/v1/wework-notifications?category=collaboration&limit=100",
            server.base
        ))
        .unwrap()
        .header("authorization", format!("Bearer {}", http::token(8, 300)))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let body: Value = response.json().await.unwrap();
    body["items"].as_array().unwrap().clone()
}

async fn count(mysql: &brz_mysql::MysqlService) -> i64 {
    mysql
        .fetch_one(
            "SELECT COUNT(*) FROM wework_notifications WHERE user_id=8 AND kind='issue_follow'",
            (),
        )
        .await
        .unwrap()
}

async fn due(mysql: &brz_mysql::MysqlService) {
    mysql.execute("UPDATE loop_items SET metadata=JSON_SET(metadata,'$.follow_poll.next_at',0) WHERE id='EXT-7'",()).await.unwrap();
}

async fn verify(source: &'static str) {
    let fixture = fixture::Fixture::new().await;
    data::seed(&fixture.mysql).await;
    for schema in [
        include_str!("../../tests/fixtures/issue_follow_notifications.sql"),
        include_str!("../../tests/fixtures/issue_follow_executions.sql"),
    ] {
        fixture.mysql.execute(schema, ()).await.unwrap();
    }
    let provider = provider::Provider::start(source).await;
    for _ in 0..101 {
        provider.state.lock().unwrap().push("comment");
    }
    let (server, state) = http::Server::start(fixture.mysql.clone()).await;
    fixture
        .mysql
        .execute("UPDATE loop_items SET id='EXT-7' WHERE id='issue-1'", ())
        .await
        .unwrap();
    fixture.mysql.execute("UPDATE loop_items SET project_key='EXT',metadata=JSON_SET(metadata,'$.task_provider',?,'$.provider_config',CAST(? AS JSON)) WHERE id='1001'",(source,config(source,&provider.base,&state.auth.jwt_key).to_string())).await.unwrap();
    following(&server, true).await;
    assert_eq!(check(&state).await.unwrap(), 0);
    assert!(
        inbox(&server).await.is_empty(),
        "all baseline pages must be suppressed"
    );
    for _ in 0..805 {
        provider.state.lock().unwrap().push("comment");
    }
    provider.state.lock().unwrap().push("status");
    provider.state.lock().unwrap().push("assignee");
    due(&fixture.mysql).await;
    assert_eq!(check(&state).await.unwrap(), 699);
    assert_eq!(count(&fixture.mysql).await, 699);
    server.close().await;
    drop(state);
    let (server, state) = http::Server::start(fixture.mysql.clone()).await;
    assert_eq!(
        check(&state).await.unwrap(),
        108,
        "a new application must resume after the eight-page budget"
    );
    assert_eq!(count(&fixture.mysql).await, 807);
    let items = inbox(&server).await;
    assert!(!items.is_empty());
    assert!(items.iter().all(|row| row["kind"] == "issue_follow"));
    for kind in ["comment", "status", "assignee"] {
        let present: i64 = fixture.mysql.fetch_one("SELECT COUNT(*) FROM wework_notifications WHERE user_id=8 AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.event'))=?",(kind,)).await.unwrap();
        assert_eq!(present, if kind == "comment" { 805 } else { 1 });
    }
    assert!(
        provider
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|path| path.ends_with("page=10"))
    );
    server.close().await;
    drop(state);
    let (server, state) = http::Server::start(fixture.mysql.clone()).await;
    due(&fixture.mysql).await;
    assert_eq!(
        check(&state).await.unwrap(),
        0,
        "new application must retain event receipts"
    );
    assert_eq!(check(&state).await.unwrap(), 0);
    assert_eq!(count(&fixture.mysql).await, 807);
    provider.state.lock().unwrap().push("comment");
    provider.state.lock().unwrap().allowed = false;
    due(&fixture.mysql).await;
    assert_eq!(check(&state).await.unwrap(), 0);
    assert_eq!(
        count(&fixture.mysql).await,
        807,
        "revoked provider access must prevent delivery"
    );
    provider.state.lock().unwrap().allowed = true;
    fixture
        .mysql
        .execute(
            "UPDATE resource_members SET status='rejected' WHERE id=3",
            (),
        )
        .await
        .unwrap();
    due(&fixture.mysql).await;
    assert_eq!(check(&state).await.unwrap(), 0);
    assert_eq!(check(&state).await.unwrap(), 0);
    assert_eq!(
        count(&fixture.mysql).await,
        807,
        "revoked project membership must prevent delivery"
    );
    fixture
        .mysql
        .execute(
            "UPDATE resource_members SET status='approved' WHERE id=3",
            (),
        )
        .await
        .unwrap();
    following(&server, false).await;
    due(&fixture.mysql).await;
    let requests = provider.state.lock().unwrap().requests.len();
    assert_eq!(check(&state).await.unwrap(), 0);
    assert_eq!(provider.state.lock().unwrap().requests.len(), requests);
    following(&server, true).await;
    due(&fixture.mysql).await;
    assert_eq!(
        check(&state).await.unwrap(),
        0,
        "refollowing must not replay intervening events"
    );
    assert_eq!(check(&state).await.unwrap(), 0);
    provider.state.lock().unwrap().push("comment");
    due(&fixture.mysql).await;
    assert_eq!(check(&state).await.unwrap(), 0);
    assert_eq!(check(&state).await.unwrap(), 1);
    assert_eq!(count(&fixture.mysql).await, 808);
    let unexpected: i64 = fixture
        .mysql
        .fetch_one(
            "SELECT COUNT(*) FROM wework_notifications WHERE user_id<>8",
            (),
        )
        .await
        .unwrap();
    assert_eq!(unexpected, 0);
    server.close().await;
    drop(state);
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires disposable MySQL and Redis; explicitly run by Backend Rust CI"]
async fn external_follow_protocol_lifecycle() {
    let directory = std::env::var_os("WEGENT_E2E_LOG_DIRECTORY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("follow-protocol-{}", std::process::id()))
        });
    let _logs = brz_logs::init(
        brz_logs::LogsConfig::default()
            .with_directory(&directory)
            .with_flush_policy(brz_logs::FlushPolicy::EveryLine),
    )
    .unwrap();
    eprintln!("Follow protocol logs: {}", directory.display());
    verify("github").await;
    verify("gitlab").await;
}
