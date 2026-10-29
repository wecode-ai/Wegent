// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Session-policy coverage through the existing real HTTP/MySQL/Redis harness.

use brz_http::Client;
use serde_json::{Value, json};
use std::net::SocketAddr;

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
