// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real MySQL coverage for the authentication shared by attachment endpoints.

use super::*;
use brz_http_server::StatusCode;
use brz_mysql::MysqlService;
use std::time::{SystemTime, UNIX_EPOCH};

async fn seed(mysql: &MysqlService) {
    mysql
        .execute(
            "CREATE TABLE api_keys (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                key_hash VARCHAR(256) NOT NULL UNIQUE,
                key_type VARCHAR(20) NOT NULL,
                expires_at DATETIME NOT NULL,
                is_active BOOLEAN NOT NULL DEFAULT TRUE
            )",
            (),
        )
        .await
        .unwrap();
    mysql
        .execute(
            "CREATE TABLE users (
                id BIGINT NOT NULL PRIMARY KEY,
                user_name VARCHAR(100) NOT NULL,
                password_hash VARCHAR(100) NOT NULL DEFAULT '',
                email VARCHAR(100),
                git_info JSON NOT NULL,
                is_active TINYINT NOT NULL DEFAULT 1,
                role VARCHAR(20) NOT NULL DEFAULT 'user',
                auth_source VARCHAR(20) NOT NULL DEFAULT 'password',
                preferences TEXT NOT NULL,
                created_at DATETIME NOT NULL,
                updated_at DATETIME NOT NULL
            )",
            (),
        )
        .await
        .unwrap();
    mysql
        .execute(
            "INSERT INTO users (id, user_name, git_info, preferences, created_at, updated_at)
             VALUES (7, 'attachment-owner', JSON_OBJECT(), '{}', UTC_TIMESTAMP(), UTC_TIMESTAMP())",
            (),
        )
        .await
        .unwrap();
    seed_keys(mysql).await;
}

async fn seed_keys(mysql: &MysqlService) {
    for (key, kind, expires_at, active) in [
        ("wg-valid", "personal", "2999-01-01 00:00:00", true),
        ("wg-never-expires", "personal", "9999-12-31 23:59:59", true),
        ("wg-expired", "personal", "2000-01-01 00:00:00", true),
        ("wg-service", "service", "9999-12-31 23:59:59", true),
        ("wg-inactive", "personal", "9999-12-31 23:59:59", false),
    ] {
        mysql
            .execute(
                "INSERT INTO api_keys (user_id, key_hash, key_type, expires_at, is_active)
                 VALUES (7, ?, ?, ?, ?)",
                (hex_sha256(key.as_bytes()), kind, expires_at, active),
            )
            .await
            .unwrap();
    }
}

async fn assert_authentication(mysql: &MysqlService) {
    let config = AuthConfig {
        jwt_key: "fixture-only".into(),
        legacy_jwt_keys: Vec::new(),
        algorithm: "HS256".into(),
    };
    for key in ["wg-valid", "wg-never-expires"] {
        let bearer = format!("Bearer {key}");
        for pairs in [[("x-api-key", key)], [("authorization", bearer.as_str())]] {
            let headers = crate::headers::HeaderSlice::new(&pairs);
            let user = get_current_user(&config, mysql, &headers).await.unwrap();
            assert_eq!(user.id, 7);
            assert_eq!(user.user_name, "attachment-owner");
            assert_eq!(user.subtask_id, None);
        }
    }
    for key in ["wg-expired", "wg-service", "wg-inactive", "wg-missing"] {
        let pairs = [("x-api-key", key)];
        let headers = crate::headers::HeaderSlice::new(&pairs);
        let error = get_current_user(&config, mysql, &headers)
            .await
            .unwrap_err();
        assert_eq!(error.status(), StatusCode::UNAUTHORIZED, "{key}: {error:?}");
        assert_eq!(error.detail(), "Invalid or expired API key");
        assert!(error.uses_challenge());
    }
    mysql
        .execute("UPDATE users SET is_active = 0 WHERE id = 7", ())
        .await
        .unwrap();
    let error = verify_api_key(mysql, "wg-valid").await.unwrap_err();
    assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL 8; explicitly run by the backend Rust CI job"]
async fn personal_api_keys_decode_mysql_datetime() {
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
        .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL fixture");
    assert!(address.starts_with("127.0.0.1:"), "use a loopback fixture");
    let url = |database: &str| format!("mysql://root@{address}/{database}?ssl-mode=disabled");
    let admin = MysqlService::connect(&url("mysql")).await.unwrap();
    let name = format!(
        "attachment_auth_{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    admin
        .execute(format!("CREATE DATABASE {name}"), ())
        .await
        .unwrap();
    let mysql = MysqlService::connect(&url(&name)).await.unwrap();
    let test_mysql = mysql.clone();
    let result = tokio::spawn(async move {
        seed(&test_mysql).await;
        assert_authentication(&test_mysql).await;
    })
    .await;
    mysql.close().await;
    admin
        .execute(format!("DROP DATABASE {name}"), ())
        .await
        .unwrap();
    admin.close().await;
    result.unwrap();
}
