// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Exercise the real SDK, including SQL rendering before network access.

#[path = "mysql_pool_server.rs"]
mod server;

use std::time::Duration;

use brz_mysql::MysqlRow;
use server::capture_queries;
use tokio::net::TcpListener;

/// The application pool is shared with injected plain handles: a statement
/// issued through a clone reaches the same server, and closing the owner
/// closes the clone. A deployment that binds no routing policy issues plain
/// statements only, so no template is involved.
pub(crate) async fn assert_plain_shared_pool() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "mysql://test:test@{}/test?ssl-mode=disabled",
            listener.local_addr().unwrap()
        );
        let pool_owner = wegent_backend_rs::connect_mysql(&url).unwrap();
        let handle = pool_owner.clone();
        let server = tokio::spawn(capture_queries(listener, 1));

        let plain: Result<Option<MysqlRow>, _> = handle
            .fetch_optional("SELECT id FROM users WHERE id = ?", (1_i64,))
            .await;
        assert!(plain.unwrap_err().to_string().contains("test captured SQL"));

        let queries = server.await.unwrap();
        assert_eq!(queries[0], "SELECT id FROM users WHERE id = ?");
        pool_owner.close().await;
        let error = handle.execute("SELECT 1", ()).await.unwrap_err();
        assert!(
            error.to_string().contains("closed"),
            "closing the application pool closes injected handles: {error}"
        );
    })
    .await
    .expect("SDK should render and send the statement using the application pool");
}
