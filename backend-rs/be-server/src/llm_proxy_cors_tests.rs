// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use brz_http_server::{Response, StatusCode};
use wegent_http_compat::source_cors;

// A dedicated test group so the probe renders through the production
// origin/gateway hop without the application's authentication or upstream.
mod probe {
    brz_http_server::registry!(group = llm_proxy_cors_probe, dependencies());
}

#[brz_http_server::post(
    "/api/runtime-work/llm-responses-proxy/messages",
    group = probe::llm_proxy_cors_probe,
    access = public
)]
async fn probe_messages(#[header("origin")] origin: Option<&str>) -> Response {
    source_cors(Response::static_bytes(StatusCode::OK, b"ok"), origin)
}

/// Renders the probe through the production gateway boundary (`hybrid`):
/// the loopback origin exports the response-local CORS decision and the
/// public gateway applies the configured policy.
async fn render_through_gateway(origin: Option<&str>) -> String {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let handler =
        brz_http_server::handlers!(; group = probe::llm_proxy_cors_probe).expect("probe router");
    let server = brz_http_server::Server::bind_with_config(
        "127.0.0.1:0".parse().unwrap(),
        handler,
        crate::filters::server_config(),
    )
    .await
    .expect("bind origin");
    let origin_address = server.local_addr().expect("local address");
    let inner = tokio::spawn(async move {
        let _ = server.serve_until(std::future::pending::<()>()).await;
    });
    let api_origin = format!("http://{origin_address}").parse().unwrap();
    let routes = brz_http_gateway::RouteTable::compile(
        toml::from_str::<brz_http_gateway::RoutesConfig>(
            "[[routes]]\nmethods = [\"POST\"]\npath = \"/api/runtime-work/*path\"",
        )
        .unwrap(),
    )
    .unwrap();
    let gateway = brz_http_gateway::Gateway::new(
        routes,
        brz_http_gateway::OriginService::new(&api_origin)
            .unwrap()
            .with_response_cors(),
        &"http://127.0.0.1:1".parse().unwrap(),
    )
    .unwrap()
    .with_cors(crate::filters::gateway_cors())
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let outer = tokio::spawn(brz_http_gateway::serve(
        listener,
        gateway,
        std::future::pending(),
        std::time::Duration::from_secs(1),
    ));
    let mut client = tokio::net::TcpStream::connect(address)
        .await
        .expect("connect");
    let origin = origin.map_or_else(String::new, |origin| format!("Origin: {origin}\r\n"));
    client
        .write_all(
            format!(
                "POST /api/runtime-work/llm-responses-proxy/messages HTTP/1.1\r\n\
                 Host: localhost\r\n{origin}\
                 Content-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await
        .expect("send");
    let mut raw = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        client.read_to_end(&mut raw),
    )
    .await
    .expect("response deadline")
    .expect("read");
    outer.abort();
    inner.abort();
    String::from_utf8_lossy(&raw).into_owned()
}

fn header_of<'a>(raw: &'a str, name: &str) -> &'a str {
    raw.lines()
        .find(|line| line.to_ascii_lowercase().starts_with(name))
        .map_or("", |line| line[name.len()..].trim())
}

/// The recorded cases carry no `Origin`, so the public response must keep
/// the source's header set: no `Vary: Origin` and no CORS permissions.
/// A cross-origin request keeps the configured source policy.
#[tokio::test]
async fn gateway_hop_keeps_headerless_replies_free_of_vary() {
    let raw = render_through_gateway(None).await;
    assert!(
        raw.starts_with("HTTP/1.1 200"),
        "unexpected response: {raw}"
    );
    assert_eq!(header_of(&raw, "vary:"), "");
    assert_eq!(header_of(&raw, "access-control-allow-origin:"), "");
    assert_eq!(header_of(&raw, "x-breeze-response-cors:"), "");

    let raw = render_through_gateway(Some("https://app.example")).await;
    assert!(
        raw.starts_with("HTTP/1.1 200"),
        "unexpected response: {raw}"
    );
    assert_eq!(header_of(&raw, "vary:"), "Origin");
    assert_eq!(
        header_of(&raw, "access-control-allow-origin:"),
        "https://app.example"
    );
    assert_eq!(header_of(&raw, "x-breeze-response-cors:"), "");
}
