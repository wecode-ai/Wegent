// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application-wide CORS compatibility for the hybrid HTTP server.

const EXPOSED_HEADERS: [&str; 2] = ["Content-Disposition", "X-Request-ID"];

pub(crate) fn server_config() -> brz_http_server::ServerConfig {
    let mut cors = brz_http_server::Cors::permissive();
    cors.allow_credentials = true;
    cors.expose_headers = EXPOSED_HEADERS.map(str::to_owned).to_vec();

    brz_http_server::ServerConfig {
        cors: Some(cors),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io::Write as _;

    use brz_http_server::{Handler, HeaderBlock, NoAuthenticator, Request, Response, StatusCode};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    use super::*;

    struct Probe;

    impl Handler for Probe {
        fn call<'a>(
            &'a self,
            request: Request<'a>,
            _authenticator: &'a NoAuthenticator,
        ) -> impl Future<Output = Response> + Send + 'a {
            let mut bytes = request.response_bytes(34);
            bytes
                .write_all(b"cache-control: private, no-store\r\n")
                .expect("write response header");
            let headers = HeaderBlock::new(bytes.freeze()).expect("valid response header");
            std::future::ready(
                Response::static_bytes(StatusCode::OK, b"ok")
                    .content_type("text/plain")
                    .headers(headers),
            )
        }
    }

    async fn serve(request: &str) -> String {
        let server = brz_http_server::Server::bind_with_config(
            "127.0.0.1:0".parse().unwrap(),
            Probe,
            server_config(),
        )
        .await
        .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client.write_all(request.as_bytes()).await.expect("send");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    fn header_of<'a>(raw: &'a str, name: &str) -> &'a str {
        raw.lines()
            .find(|line| line.to_ascii_lowercase().starts_with(name))
            .map_or("", |line| line[name.len()..].trim())
    }

    #[tokio::test]
    async fn adds_fastapi_compatible_headers_and_preserves_handler_headers() {
        let raw = serve(
            "GET /api/devices HTTP/1.1\r\n\
             Host: localhost\r\n\
             Origin: http://127.0.0.1:51577\r\n\
             Connection: close\r\n\r\n",
        )
        .await;

        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(
            header_of(&raw, "access-control-allow-origin:"),
            "http://127.0.0.1:51577"
        );
        assert_eq!(header_of(&raw, "access-control-allow-credentials:"), "true");
        assert_eq!(
            header_of(&raw, "access-control-expose-headers:"),
            "Content-Disposition, X-Request-ID"
        );
        assert_eq!(header_of(&raw, "vary:"), "Origin");
        assert_eq!(header_of(&raw, "cache-control:"), "private, no-store");
    }

    #[tokio::test]
    async fn leaves_responses_without_an_origin_without_cors_headers() {
        let raw = serve(
            "GET /api/devices HTTP/1.1\r\n\
             Host: localhost\r\n\
             Connection: close\r\n\r\n",
        )
        .await;

        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(header_of(&raw, "access-control-allow-origin:"), "");
        assert_eq!(header_of(&raw, "cache-control:"), "private, no-store");
    }

    #[tokio::test]
    async fn answers_preflight_before_the_handler() {
        let raw = serve(
            "OPTIONS /api/devices HTTP/1.1\r\n\
             Host: localhost\r\n\
             Origin: http://127.0.0.1:51577\r\n\
             Access-Control-Request-Method: GET\r\n\
             Access-Control-Request-Headers: authorization, content-type\r\n\
             Connection: close\r\n\r\n",
        )
        .await;

        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(
            header_of(&raw, "access-control-allow-origin:"),
            "http://127.0.0.1:51577"
        );
        assert_eq!(
            header_of(&raw, "access-control-allow-headers:"),
            "authorization, content-type"
        );
        assert!(
            header_of(&raw, "access-control-allow-methods:")
                .split(", ")
                .any(|method| method == "GET")
        );
        assert_eq!(header_of(&raw, "access-control-max-age:"), "600");
        assert_eq!(raw.split_once("\r\n\r\n").unwrap().1, "OK");
    }
}
