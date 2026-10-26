// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[path = "support/knowledge_python_upstream.rs"]
mod upstream;

use http::Method;
use std::path::Path;
use std::time::Duration;
use upstream::{KNOWLEDGE_PATHS, PythonUpstream, request};
use wegent_backend_rs::{Gateway, HybridConfig, NoRustApi, RouteTable, bind, serve};

#[tokio::test]
async fn knowledge_rollback_forwards_through_public_gateway_to_python() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let python = PythonUpstream::start(&root.join("../backend"));
    let config = HybridConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        python.uri.clone(),
        RouteTable::empty(),
    )
    .with_routes_file(&root.join("config/routes.toml"))
    .unwrap();
    let gateway = Gateway::new(config.routes.clone(), NoRustApi, &python.uri).unwrap();
    let listener = bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        serve(
            listener,
            gateway,
            async {
                let _ = stopped.await;
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    });
    for path in KNOWLEDGE_PATHS.iter().copied().chain([
        "/api/knowledge/documents-extra",
        "/api/api/mcp/knowledge-external/documents/11/file",
    ]) {
        for method in ["GET", "HEAD", "DELETE"] {
            assert!(!config.selects_rust(
                &method.parse::<Method>().unwrap(),
                path.split('?').next().unwrap()
            ));
            let response = request(address, method, path).await;
            assert!(
                response.starts_with("HTTP/1.1 200"),
                "{method} {path}: {response}"
            );
            assert!(
                response
                    .to_ascii_lowercase()
                    .contains("x-test-owner: python")
            );
            if method != "HEAD" {
                assert!(response.contains(&format!("python {method} {path}")));
            }
        }
    }
    assert!(config.selects_rust(&Method::GET, "/api/attachments/11/download"));
    let response = request(address, "GET", "/api/attachments/11/download").await;
    assert!(
        !response
            .to_ascii_lowercase()
            .contains("x-test-owner: python")
    );
    stop.send(()).unwrap();
    task.await.unwrap();
}
