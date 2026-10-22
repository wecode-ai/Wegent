// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Python no longer implements this API, but older wework clients still call it.
//! Keep an explicit handler returning the same JSON 404 instead of a router-level 404.

use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

#[brz_http_server::post("/api/v1/loop-item-executions/claim-my-next", access = public)]
async fn claim_my_next_execution() -> Result<(), FastApiError> {
    Err(FastApiError::detail(StatusCode::NOT_FOUND, "Not Found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    mod probe {
        brz_http_server::registry!(group = retired_claim_probe, dependencies());
    }

    #[brz_http_server::post(
        "/api/v1/loop-item-executions/claim-my-next",
        group = probe::retired_claim_probe,
        access = public
    )]
    async fn probe_claim() -> Result<(), FastApiError> {
        claim_my_next_execution().await
    }

    #[tokio::test]
    async fn retired_claim_returns_json_404_without_auth_or_body_validation() {
        let handler =
            brz_http_server::handlers!(; group = probe::retired_claim_probe).expect("claim router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind server");
        let address = server.local_addr().expect("local address");
        let serve =
            tokio::spawn(async move { server.serve_until(std::future::pending::<()>()).await });
        let client = brz_http::Client::builder().build().expect("HTTP client");
        for body in ["", "{}", "invalid json"] {
            let response = client
                .post(format!(
                    "http://{address}/api/v1/loop-item-executions/claim-my-next"
                ))
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
