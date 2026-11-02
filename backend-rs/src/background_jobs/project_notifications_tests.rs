// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! A notification target must use its caller's transaction, even with one connection.

use super::*;
use std::time::Duration;

#[path = "../../tests/support/assignments_fixture.rs"]
#[allow(dead_code)]
mod data;
#[path = "../../tests/support/responses_mysql.rs"]
#[allow(dead_code)]
mod fixture;

#[tokio::test]
#[ignore = "requires disposable MySQL; explicitly run by Backend Rust CI"]
async fn notification_target_uses_current_transaction() {
    let fixture = fixture::Fixture::new().await;
    data::seed(&fixture.mysql).await;
    let project = super::super::store::get(&fixture.mysql, "project", "1001")
        .await
        .unwrap()
        .unwrap();
    let issue = super::super::store::get(&fixture.mysql, "task", "issue-1")
        .await
        .unwrap()
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        fixture.mysql.with_transaction(async |tx| {
            // The payload must see an uncommitted name from this transaction.
            tx.execute(
                "UPDATE users SET user_name='transaction-local-name' WHERE id=7",
                (),
            )
            .await?;
            target_on(tx, &project, &issue, 7).await
        }),
    )
    .await
    .expect("notification target tried to acquire a second connection")
    .unwrap();
    assert_eq!(result["assigneeName"], "transaction-local-name");
    assert_eq!(result["itemId"], "issue-1");
    fixture.close().await;
}
