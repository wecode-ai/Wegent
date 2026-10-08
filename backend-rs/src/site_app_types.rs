// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/sites/app-types` — the Sites application-type catalog.
//!
//! Mirrors `app.api.endpoints.sites.list_site_app_types`, which requires an
//! authenticated session (`app.core.security.get_current_user`) and renders
//! `app.services.site_application_types.list_application_types()`. The catalog
//! is static: `APPLICATION_TYPE_HANDLERS` in registration order, each rendered
//! by `ApplicationTypeHandler.descriptor()`.
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use serde::Serialize;

/// `BUILTIN_SITES_PLUGIN_NAME` (`app.services.builtin_plugin_registry`), the
/// `create_plugin_name` of `SiteApplicationHandler`.
const SITES_PLUGIN_NAME: &str = "wegent-sites";

/// `BUILTIN_MINI_PROGRAM_PLUGIN_NAME` (`app.services.builtin_plugin_registry`),
/// the `create_plugin_name` of `MiniProgramApplicationHandler`.
const MINI_PROGRAM_PLUGIN_NAME: &str = "weibo-miniapp-h5-develop-agent";

/// The marketplace rendered for both create plugins. `descriptor()` resolves
/// `marketplace_name_for_visibility(builtin_plugin.visibility)`; both builtin
/// plugins use the registry default `visibility="workspace"`, which
/// `app.services.plugin_marketplace_identity` maps to `"wegent"`. The fallback
/// `APPLICATION_PLUGIN_MARKETPLACE` (`marketplace_name_for_visibility(
/// "workspace")`) is the same value.
const APPLICATION_PLUGIN_MARKETPLACE: &str = "wegent";

/// `ApplicationCreatePluginResponse` (`app.schemas.site`); field order
/// preserved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ApplicationCreatePluginResponse {
    plugin_name: &'static str,
    marketplace_name: &'static str,
}

/// `ApplicationTypeResponse` (`app.schemas.site`); field order preserved and
/// `enabled` materialized to the pydantic `True` default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ApplicationTypeResponse {
    app_type: &'static str,
    enabled: bool,
    order: i64,
    capabilities: &'static [&'static str],
    create: ApplicationCreatePluginResponse,
}

/// `ApplicationTypeListResponse` (`app.schemas.site`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct ApplicationTypeListResponse {
    items: Vec<ApplicationTypeResponse>,
}

/// `list_application_types`: the enabled application types in their stable UI
/// order (`APPLICATION_TYPE_HANDLERS`).
fn list_application_types() -> ApplicationTypeListResponse {
    ApplicationTypeListResponse {
        items: vec![
            ApplicationTypeResponse {
                app_type: "web",
                enabled: true,
                order: 10,
                capabilities: &[
                    "create",
                    "publish",
                    "edit",
                    "delete",
                    "configure_environment",
                    "manage_access",
                ],
                create: ApplicationCreatePluginResponse {
                    plugin_name: SITES_PLUGIN_NAME,
                    marketplace_name: APPLICATION_PLUGIN_MARKETPLACE,
                },
            },
            ApplicationTypeResponse {
                app_type: "miniapp",
                enabled: true,
                order: 20,
                capabilities: &["create", "open_experience"],
                create: ApplicationCreatePluginResponse {
                    plugin_name: MINI_PROGRAM_PLUGIN_NAME,
                    marketplace_name: APPLICATION_PLUGIN_MARKETPLACE,
                },
            },
        ],
    }
}

/// GET /api/sites/app-types: the sites free function. The source requires
/// `get_current_user` but never reads the resolved user, so only the session
/// marker is bound.
#[brz_http_server::get("/api/sites/app-types")]
async fn list_site_app_types(
    #[auth] _current_user: SessionUser,
) -> Result<ApplicationTypeListResponse, FastApiError> {
    Ok(list_application_types())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    /// The exact body recorded from the Python source for the representative
    /// case (`GET /api/sites/app-types`).
    const SOURCE_BODY: &str = "{\"items\":[{\"app_type\":\"web\",\"enabled\":true,\
        \"order\":10,\"capabilities\":[\"create\",\"publish\",\"edit\",\"delete\",\
        \"configure_environment\",\"manage_access\"],\"create\":{\"plugin_name\":\
        \"wegent-sites\",\"marketplace_name\":\"wegent\"}},{\"app_type\":\"miniapp\",\
        \"enabled\":true,\"order\":20,\"capabilities\":[\"create\",\"open_experience\"],\
        \"create\":{\"plugin_name\":\"weibo-miniapp-h5-develop-agent\",\
        \"marketplace_name\":\"wegent\"}}]}";

    // A dedicated test group so the probe route does not collide with the real
    // handler's registration in the crate's default `http_apis` group.
    mod probe {
        brz_http_server::registry!(group = site_app_types_probe, dependencies());
    }

    /// Renders the catalog through the route macro over a real socket. The
    /// source declares `response_model=ApplicationTypeListResponse`, so the
    /// response must answer `application/json`; returning raw bytes would
    /// answer `application/octet-stream`.
    #[brz_http_server::get("/api/sites/app-types", group = probe::site_app_types_probe, access = public)]
    async fn list_site_app_types_probe() -> Result<ApplicationTypeListResponse, FastApiError> {
        Ok(list_application_types())
    }

    /// Serves the probe route on a real socket so status, headers, and body are
    /// asserted exactly as the runtime renders them.
    async fn serve_probe() -> String {
        let handler = brz_http_server::handlers!(; group = probe::site_app_types_probe)
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
            .write_all(b"GET /api/sites/app-types HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .expect("send request");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read response");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    #[test]
    fn renders_the_source_application_type_catalog() {
        let body = serde_json::to_string(&list_application_types()).unwrap();
        assert_eq!(body, SOURCE_BODY);
    }

    #[tokio::test]
    async fn answers_application_json_with_the_source_catalog() {
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
        assert_eq!(body, SOURCE_BODY, "{raw}");
    }
}
