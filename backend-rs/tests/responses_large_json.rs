// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[path = "support/responses_mysql.rs"]
mod fixture;
#[path = "support/responses_http.rs"]
mod http_e2e;
#[path = "support/llm_proxy_timeouts.rs"]
mod llm_proxy_timeouts;

use std::{path::Path, sync::Arc};
use wegent_backend_rs::task_store::DefaultTaskStore;

#[tokio::test]
#[ignore = "requires disposable MySQL 8; run explicitly in the Backend Rust CI job"]
async fn responses_mysql_large_json_preserves_message_order_and_owner_filter() {
    let fixture = fixture::Fixture::new().await;
    fixture.seed("subtasks", 42, 7).await;
    fixture.assert_original_query_fails("subtasks", 42, 7).await;
    let store = Arc::new(DefaultTaskStore::new(fixture.mysql.clone()));
    let result = fixture::assert_large_json_read(store.as_ref(), 42, 7).await;
    if result.is_ok() {
        http_e2e::seed_task(&fixture.mysql, "tasks", 42, 7).await;
        http_e2e::assert_http_reads(
            fixture.mysql.clone(),
            store,
            http_e2e::runtime_config()
                .with_routes_file(&Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"))
                .unwrap(),
            &[42],
            7,
            false,
        )
        .await;
    }
    fixture.close().await;
    result.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8; run explicitly in the Backend Rust CI job"]
async fn responses_mysql_long_conversation_exceeds_prepared_statement_limit() {
    let fixture = fixture::Fixture::new().await;
    fixture.seed_long_conversation("subtasks", 42, 7).await;
    let store = Arc::new(DefaultTaskStore::new(fixture.mysql.clone()));
    let result = fixture::assert_long_conversation_read(store.as_ref(), 42, 7).await;
    if result.is_ok() {
        http_e2e::seed_task(&fixture.mysql, "tasks", 42, 7).await;
        http_e2e::assert_http_reads(
            fixture.mysql.clone(),
            store,
            http_e2e::runtime_config()
                .with_routes_file(&Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"))
                .unwrap(),
            &[42],
            7,
            true,
        )
        .await;
    }
    fixture.close().await;
    result.unwrap();
}
