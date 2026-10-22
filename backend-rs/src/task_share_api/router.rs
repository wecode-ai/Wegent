// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! API export for `POST /api/tasks/{task_id}/share`.

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::auth::ExecutorUser;
use super::handler;
use super::models::TaskShareResponse;

/// `POST /api/tasks/{task_id}/share`: the source route authenticates through
/// `get_current_user_flexible_for_executor` (personal API key or user-session
/// JWT), then validates membership before delegating to
/// `SharedTaskService.share_task`. A missing or unauthorized task is the
/// route's own `404` detail.
#[brz_http_server::post("/api/tasks/:task_id/share")]
async fn share_task_route(
    #[inject(state)] state: &AppState,
    task_id: i64,
    #[auth] current_user: ExecutorUser,
) -> Result<TaskShareResponse, FastApiError> {
    let user_id = i64::from(current_user.id);
    if !handler::validate_task_exists(state, task_id, user_id).await? {
        return Err(handler::not_a_member());
    }
    handler::share_task(state, task_id, user_id).await
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated probe group so the fixture route cannot collide with the
    // real share route during the test build.
    mod probe {
        brz_http_server::registry!(group = task_share_probe, dependencies());
    }

    #[derive(serde::Serialize)]
    struct ProbeShare {
        share_url: &'static str,
        share_token: &'static str,
    }

    /// The success framing: `application/json` and the compact body order.
    #[brz_http_server::post(
        "/api/tasks/:task_id/share",
        group = probe::task_share_probe,
        access = public
    )]
    async fn probe_share(task_id: i64) -> ProbeShare {
        let _ = task_id;
        ProbeShare {
            share_url: "https://example/shared/task?token=t",
            share_token: "t",
        }
    }

    async fn serve(request: &str) -> String {
        let handler = brz_http_server::handlers!(
            ;
            group = probe::task_share_probe
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

    #[tokio::test]
    async fn renders_the_share_response_as_compact_json() {
        let raw = serve(
            "POST /api/tasks/21577915845323/share HTTP/1.1\r\n\
             Host: localhost\r\n\
             Connection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        let (head, body) = raw.split_once("\r\n\r\n").expect("header/body split");
        assert!(
            head.to_ascii_lowercase()
                .contains("content-type: application/json"),
            "{raw}"
        );
        // The success body is the compact `TaskShareResponse` document.
        assert_eq!(
            body, "{\"share_url\":\"https://example/shared/task?token=t\",\"share_token\":\"t\"}",
            "{raw}"
        );
    }
}
