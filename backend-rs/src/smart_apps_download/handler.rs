// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/smart-apps/marketplace/{smart_app_id}/download` handler.
use brz_http_server::{HttpResponse, StatusCode};
use chrono::Utc;

use super::models::SmartAppDownloadDescriptor;
use super::service::{DescriptorError, download_descriptor};
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `download_marketplace_item` (`app/api/endpoints/smart_apps.py`): required
/// session authentication, then the service's descriptor.
#[brz_http_server::post("/api/smart-apps/marketplace/:smart_app_id/download")]
async fn download_marketplace_item(
    #[inject(state)] state: &AppState,
    smart_app_id: i64,
    #[auth] user: SessionUser,
) -> Result<HttpResponse<SmartAppDownloadDescriptor>, FastApiError> {
    let user_id = i64::from(user.id);
    match download_descriptor(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &state.auth,
        smart_app_id,
        user_id,
        Utc::now(),
    )
    .await
    {
        // `response_model=SmartAppDownloadDescriptor` renders as JSON; the
        // serializable view keeps that content type.
        Ok(descriptor) => Ok(HttpResponse::new(descriptor)),
        Err(DescriptorError::NotFound(detail)) => {
            Err(FastApiError::detail(StatusCode::NOT_FOUND, detail))
        }
        Err(DescriptorError::Dependency) => Err(FastApiError::unhandled()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated test group (separate from the crate's real `http_apis`
    // group) so the probe's route does not collide with the real handler.
    mod probe {
        brz_http_server::registry!(group = smart_app_download_probe, dependencies());
    }

    /// Renders a descriptor through the route macro over a real socket. The
    /// source declares `response_model=SmartAppDownloadDescriptor`, so the
    /// response must answer `application/json` with the camelCase field order
    /// and the pydantic datetime form.
    #[brz_http_server::post(
        "/api/smart-apps/marketplace/:smart_app_id/download",
        group = probe::smart_app_download_probe,
        access = public
    )]
    async fn descriptor_probe(
        smart_app_id: i64,
    ) -> Result<HttpResponse<SmartAppDownloadDescriptor>, FastApiError> {
        Ok(HttpResponse::new(SmartAppDownloadDescriptor {
            smart_app_id,
            release_id: 32,
            version: "0.1.5".to_owned(),
            filename: "dsh-terminal-workbench-0.1.5.zip".to_owned(),
            download_url: "/api/smart-apps/marketplace/9/artifact?token=x".to_owned(),
            sha256: "sha".to_owned(),
            size_bytes: 351009,
            expires_at: "2026-10-10T06:37:30.688045Z".to_owned(),
        }))
    }

    async fn serve_probe() -> String {
        let handler = brz_http_server::handlers!(; group = probe::smart_app_download_probe)
            .expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client
            .write_all(
                b"POST /api/smart-apps/marketplace/9/download HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("send request");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read response");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    #[tokio::test]
    async fn descriptor_answers_application_json_in_source_order() {
        let raw = serve_probe().await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        let content_type = raw
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("content-type:"))
            .expect("content-type header");
        assert_eq!(
            content_type["content-type:".len()..].trim(),
            "application/json",
            "{raw}"
        );
        let body = raw.split_once("\r\n\r\n").map_or("", |(_, body)| body);
        assert_eq!(
            body,
            "{\"smartAppId\":9,\"releaseId\":32,\"version\":\"0.1.5\",\
             \"filename\":\"dsh-terminal-workbench-0.1.5.zip\",\
             \"downloadUrl\":\"/api/smart-apps/marketplace/9/artifact?token=x\",\
             \"sha256\":\"sha\",\"sizeBytes\":351009,\
             \"expiresAt\":\"2026-10-10T06:37:30.688045Z\"}",
            "{raw}"
        );
    }
}
