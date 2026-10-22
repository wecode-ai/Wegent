// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/sessions` — a third-party scanner probe posting credential
//! guesses (the recorded request body is `{"email": "admin@localhost",
//! "password": "admin"}`).
//!
//! The Wegent backend registers no `/api/sessions` route (the only `sessions`
//! routers are mounted at `/api/auth/wework/sessions` and
//! `/api/internal/chat/sessions`), so FastAPI answers the probe with its
//! default `404 {"detail":"Not Found"}` rendered as `application/json`.
//! Routing it to Rust reproduces that not-found response instead of proxying
//! to Python, which answers `502 "fallback upstream unavailable"` whenever the
//! fallback upstream is unavailable. The handler is public and ignores the
//! request body, exactly like FastAPI's unmatched-route response: no
//! authentication or validation runs before the 404.

use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// `POST /api/sessions`: return FastAPI's default not-found body for the
/// scanner-probe path.
#[brz_http_server::post("/api/sessions", access = public)]
async fn sessions_post() -> Result<(), FastApiError> {
    Err(FastApiError::detail(StatusCode::NOT_FOUND, "Not Found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    mod probe {
        brz_http_server::registry!(group = sessions_probe, dependencies());
    }

    #[brz_http_server::post("/api/sessions", group = probe::sessions_probe, access = public)]
    async fn probe_sessions_post() -> Result<(), FastApiError> {
        sessions_post().await
    }

    #[tokio::test]
    async fn scanner_probe_returns_fastapi_default_404_json() {
        let handler =
            brz_http_server::handlers!(; group = probe::sessions_probe).expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve =
            tokio::spawn(async move { server.serve_until(std::future::pending::<()>()).await });
        let client = brz_http::Client::builder().build().expect("HTTP client");
        for body in [
            r#"{\r\n  "email": "admin@localhost",\r\n  "password": "admin"\r\n}"#,
            "",
        ] {
            let response = client
                .post(format!("http://{address}/api/sessions"))
                .expect("request")
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .expect("response");
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(response.headers()["content-type"], "application/json");
            assert_eq!(
                response.json::<serde_json::Value>().await.unwrap(),
                serde_json::json!({"detail": "Not Found"})
            );
        }
        serve.abort();
    }
}
