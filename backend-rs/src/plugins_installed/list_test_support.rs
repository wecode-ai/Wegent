// SPDX-License-Identifier: Apache-2.0

pub(super) use crate::plugins_installed::test_support::{ObservedMysql, installed_document};
use brz_mysql::Mysql;
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) async fn authenticated_list<M: Mysql>(mysql: &M, device: Option<&str>) -> Value {
    let secret = "installed-list-fixture-only";
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &json!({"sub": "list-fixture"}),
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap();
    let authorization = format!("Bearer {token}");
    let headers =
        crate::headers::OwnedHeaders::from_pairs([("authorization", Some(authorization.as_str()))]);
    let user = super::auth::authenticate(mysql, &headers.view(), &[Arc::from(secret)], "HS256")
        .await
        .expect("fixture session authenticates");
    let response = super::list_installed(mysql, user.id, device).await.unwrap();
    serde_json::to_value(response).unwrap()
}
