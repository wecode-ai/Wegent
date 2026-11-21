// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! API export for `GET /api/tasks/{task_id}`.

use std::sync::Arc;

use super::handler::task_detail;
use super::models::TaskDetailResponse;
use crate::state::AppState;

/// GET /api/tasks/{task_id}: the success value is the typed `TaskDetail`
/// document, so the SDK's JSON reply adaptor renders it as raw JSON with
/// `application/json`. The source handler returns the plain dict from
/// `task_kinds_service.get_task_detail`
/// (`backend/app/api/endpoints/adapter/tasks.py:396-411`), which FastAPI
/// renders with its default `JSONResponse`.
#[brz_http_server::get("/api/tasks/:task_id")]
async fn detail_response(
    #[inject(state)] state: &Arc<AppState>,
    task_id: i64,
    #[auth] current_user: crate::auth::SessionUser,
    client_origin: Option<String>,
) -> Result<TaskDetailResponse, super::handler::ApiError> {
    task_detail(state, task_id, client_origin.as_deref(), &current_user).await
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated test group (separate from the crate's real `http_apis`
    // group) so the probe's `/api/tasks/:task_id` route does not collide with
    // the real task-detail endpoint during the test build.
    mod probe {
        brz_http_server::registry!(group = task_detail_probe, dependencies());
    }

    /// A typed detail document, the same return shape as `detail_response`.
    #[derive(serde::Serialize)]
    struct ProbeDetail {
        id: i64,
        title: &'static str,
    }

    /// Renders a typed document through the endpoint's return shape so the
    /// status, content type, and body of its success framing are asserted
    /// exactly as the runtime writes them. The recorded source announces
    /// `application/json` here; a raw body would announce
    /// `application/octet-stream` instead.
    #[brz_http_server::get("/api/tasks/:task_id", group = probe::task_detail_probe, access = public)]
    async fn probe_detail(task_id: i64) -> ProbeDetail {
        ProbeDetail {
            id: task_id,
            title: "t",
        }
    }

    /// Drives the probe router over a real `http-server` socket.
    async fn serve(request: &str) -> String {
        let handler = brz_http_server::handlers!(
            ;
            group = probe::task_detail_probe
        )
        .expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
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

    fn body_of(raw: &str) -> &str {
        raw.split_once("\r\n\r\n").map_or("", |(_, body)| body)
    }

    fn header_of<'a>(raw: &'a str, name: &str) -> &'a str {
        raw.lines()
            .find(|line| line.to_ascii_lowercase().starts_with(name))
            .map_or("", |line| line[name.len()..].trim())
    }

    #[tokio::test]
    async fn success_response_announces_raw_json() {
        let raw = serve(
            "GET /api/tasks/1 HTTP/1.1\r\n\
             Host: localhost\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(header_of(&raw, "content-type:"), "application/json");
        assert_eq!(body_of(&raw), r#"{"id":1,"title":"t"}"#);
    }
}
