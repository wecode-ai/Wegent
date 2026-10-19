// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/user/login` — a third-party scanner probe path.
//!
//! The recorded request carries a JSON `{"username":..., "password": ...}`
//! body (a Nexus/SonarQube-style default-credential probe), and no router in
//! the Python source registers `/v1/user`: `app/api/api.py` mounts routers
//! under `/v1` only for cloud-projects, projects, workspaces, resources,
//! runtime-profiles, dsh-plugin-storage, incoming-hooks, deliveries,
//! feedback, responses, deep-research, token-issuers, knowledge-base,
//! attachments, transition-pages, and wework-notifications; the closest
//! real login routes are `POST /api/auth/login` and the CAS route at
//! `/api/internal/auth/login`. FastAPI therefore answers the probe with its
//! default `404 {"detail":"Not Found"}`.
//!
//! The faithful cutover registers `POST /api/v1/user/login` so the request is
//! routed to the Rust listener instead of proxying to the Python fallback
//! (which answers `502 "fallback upstream unavailable"` whenever the Python
//! upstream is not live, as during replay). The handler returns exactly the
//! source's framework 404 body with an `application/json` content type, and
//! the request-ID filter stamps the response like every other Rust API.

use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// POST /api/v1/user/login: return FastAPI's default not-found body for the
/// scanner probe path the source does not register.
#[brz_http_server::post("/api/v1/user/login", access = public)]
async fn user_login_probe() -> Result<(), FastApiError> {
    // FastAPI's default HTTPException(404) renders `{"detail":"Not Found"}`
    // as `application/json`; reproduce it exactly.
    Err(FastApiError::detail(StatusCode::NOT_FOUND, "Not Found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_the_fastapi_default_not_found_response() {
        let error = user_login_probe().await.unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        // FastAPI's default 404 body rendered by the shared error mapper.
        assert_eq!(error.validation_detail(), r#""Not Found""#);
    }

    /// Unverified cutovers keep Python ownership while their handlers stay registered.
    #[test]
    fn registered_route_keeps_python_ownership() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == "/api/v1/user/login"
                    && rule.methods.iter().any(|method| method == "POST")),
            "POST /api/v1/user/login must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::POST, "/api/v1/user/login"));
        assert!(!table.matches(&http::Method::GET, "/api/v1/user/login"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == "/api/v1/user/login" && route.methods & POST != 0);
        assert!(
            registered,
            "POST /api/v1/user/login must be registered by the router"
        );
    }
}
