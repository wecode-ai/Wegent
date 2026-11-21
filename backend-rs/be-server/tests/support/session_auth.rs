// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication coverage through the existing real HTTP/MySQL/Redis harness.

use brz_http::Client;
use serde_json::{Value, json};
use std::net::SocketAddr;

pub(super) const SKILL_PATH: &str = "/api/v1/kinds/skills/1/download";
const SKILL_ARCHIVE: &[u8] = b"PK\x05\x06\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";

pub(super) async fn assert_skill_identity_compatibility(
    client: &Client,
    address: SocketAddr,
    mysql: &brz_mysql::MysqlService,
    user_id: i32,
) {
    seed_owned_skill(mysql, user_id).await;
    let now = chrono::Utc::now().timestamp();
    let identity = json!({"type":"skill_identity", "user_id":user_id,
        "user_name":format!("responses-fixture-{user_id}"), "runtime_type":"executor",
        "runtime_name":"auth-fixture", "iat":now, "exp":now+300});
    let mut expired = identity.clone();
    expired["exp"] = json!(now - 300);
    let mut mismatched_user = identity.clone();
    mismatched_user["user_name"] = json!("another-user");
    let task = json!({"type":"task_token", "user_id":user_id,
        "user_name":format!("responses-fixture-{user_id}"), "task_id":42, "subtask_id":1});
    let session = json!({"sub":format!("responses-fixture-{user_id}")});
    for (label, claims, scheme, status) in [
        ("identity bearer", &identity, Some("Bearer"), 200),
        ("identity lowercase", &identity, Some("bearer"), 200),
        ("identity mixed case", &identity, Some("bEaReR"), 200),
        ("identity raw", &identity, None, 401),
        ("identity basic", &identity, Some("Basic"), 401),
        ("identity expired", &expired, Some("bearer"), 401),
        ("identity username", &mismatched_user, Some("bearer"), 401),
        ("session bearer", &session, Some("Bearer"), 200),
        ("session lowercase", &session, Some("bearer"), 401),
        ("session raw", &session, None, 200),
        ("task bearer", &task, Some("Bearer"), 200),
        ("task lowercase", &task, Some("bearer"), 401),
        ("task raw", &task, None, 200),
    ] {
        let token = super::signed_claims(claims);
        let authorization =
            scheme.map_or_else(|| token.clone(), |scheme| format!("{scheme} {token}"));
        assert_skill_download(client, address, &authorization, status, label).await;
    }
}

async fn seed_owned_skill(mysql: &brz_mysql::MysqlService, user_id: i32) {
    for sql in [
        "CREATE TABLE kinds (id INT PRIMARY KEY, user_id INT, kind VARCHAR(20),
            name VARCHAR(100), namespace VARCHAR(100), json JSON, is_active TINYINT DEFAULT 1)",
        "CREATE TABLE skill_binaries (kind_id INT PRIMARY KEY, binary_data LONGBLOB)",
    ] {
        mysql.execute(sql, ()).await.unwrap();
    }
    mysql
        .execute(
            "INSERT INTO kinds (id,user_id,kind,name,namespace,json)
            VALUES (1,?,'Skill','auth-fixture','default',JSON_OBJECT())",
            (user_id,),
        )
        .await
        .unwrap();
    mysql
        .execute("INSERT INTO skill_binaries VALUES (1,?)", (SKILL_ARCHIVE,))
        .await
        .unwrap();
}

async fn assert_skill_download(
    client: &Client,
    address: SocketAddr,
    authorization: &str,
    status: u16,
    label: &str,
) {
    let response = client
        .get(format!("http://{address}{SKILL_PATH}"))
        .unwrap()
        .header("authorization", authorization)
        .header("x-forwarded-for", format!("skill-auth-{address}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), status, "{label}");
    let bytes = response.bytes().await.unwrap();
    if status == 200 {
        assert_eq!(bytes.as_ref(), SKILL_ARCHIVE, "{label}");
    } else {
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["detail"], "Could not validate credentials", "{label}");
    }
}

pub(super) async fn assert_session_compatibility(
    client: &Client,
    address: SocketAddr,
    task_id: i64,
    user_id: i32,
) {
    let now = chrono::Utc::now().timestamp();
    let mut cases = vec![
        (json!({}), 404),
        (json!({"exp": (now + 300).to_string()}), 404),
        (json!({"exp": now as f64 + 300.5}), 404),
        (json!({"iat": now + 300}), 404),
        (json!({"exp": now - 300}), 401),
        (json!({"nbf": now + 300}), 401),
        (json!({"iat": "invalid"}), 401),
        (json!({"aud": "another-service"}), 401),
        (json!({"jti": 123}), 401),
        (json!({"scope": "read"}), 401),
        (json!({"token_use": "wework_refresh"}), 401),
    ];
    for scope in [
        Value::Null,
        json!(false),
        json!(0),
        json!(""),
        json!([]),
        json!({}),
    ] {
        cases.push((json!({"scope": scope}), 404));
    }
    let task = json!({"type":"task_token", "task_id":task_id, "subtask_id":2,
        "user_id":user_id, "user_name":format!("responses-fixture-{user_id}"), "scope":"task"});
    cases.push((task.clone(), 404));
    for delta in [json!({"exp":now-300}), json!({"iat":now+300})] {
        let mut invalid = task.clone();
        invalid
            .as_object_mut()
            .unwrap()
            .extend(delta.as_object().unwrap().clone());
        cases.push((invalid, 401));
    }
    let mut missing_identity = task;
    missing_identity
        .as_object_mut()
        .unwrap()
        .remove("user_name");
    cases.push((missing_identity, 401));
    for (changes, status) in cases {
        let mut claims = json!({"sub": format!("responses-fixture-{user_id}")});
        claims
            .as_object_mut()
            .unwrap()
            .extend(changes.as_object().unwrap().clone());
        assert_status(client, address, task_id, &claims, status).await;
    }
}

async fn assert_status(
    client: &Client,
    address: SocketAddr,
    task_id: i64,
    claims: &Value,
    status: u16,
) {
    // Reuse the fixture's denied owner path across base and sharded stores.
    // The handler returns 404 before reading the large conversation; invalid JWTs return 401.
    let response = client
        .get(format!("http://{address}/api/v1/responses/resp_{task_id}"))
        .unwrap()
        .header(
            "authorization",
            format!("Bearer {}", super::signed_claims(claims)),
        )
        .header(
            "x-forwarded-for",
            format!("session-compatibility-{address}"),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), status, "claims={claims}");
    if status == 404 {
        let body: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        assert_eq!(
            body["detail"],
            format!("Response 'resp_{task_id}' not found")
        );
    }
}
