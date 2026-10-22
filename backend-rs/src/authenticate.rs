// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/authenticate` — a third-party scanner probe path.
//!
//! The request is the Frappe/ERPNext default-credential probe
//! (`{"username":"admin","password":"admin",...}`), and no router in the
//! Python source registers `/authenticate`: `app/api/api.py` mounts the auth
//! router at `/auth` (whose routes are `/oauth2`, `/login`, and
//! `/admin-password/setup`), and no other module registers the path either,
//! so FastAPI answers the probe with its default
//! `404 {"detail":"Not Found"}`.
//!
//! The faithful cutover registers `POST /api/authenticate` so the request is
//! routed to the Rust listener instead of proxying to the Python fallback
//! (which answers `502 "fallback upstream unavailable"` whenever the Python
//! upstream is not live, as during replay). The handler returns exactly the
//! source's framework 404 body with an `application/json` content type, and
//! the request-ID filter stamps the response like every other Rust API.

use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// POST /api/authenticate: return FastAPI's default not-found body for the
/// scanner probe path the source does not register.
#[brz_http_server::post("/api/authenticate", access = public)]
async fn authenticate_probe() -> Result<(), FastApiError> {
    // FastAPI's default HTTPException(404) renders `{"detail":"Not Found"}`
    // as `application/json`; reproduce it exactly.
    Err(FastApiError::detail(StatusCode::NOT_FOUND, "Not Found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_the_fastapi_default_not_found_response() {
        let error = authenticate_probe().await.unwrap_err();
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
                .any(|rule| rule.path == "/api/authenticate"
                    && rule.methods.iter().any(|method| method == "POST")),
            "POST /api/authenticate must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::POST, "/api/authenticate"));
        assert!(!table.matches(&http::Method::GET, "/api/authenticate"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == "/api/authenticate" && route.methods & POST != 0);
        assert!(
            registered,
            "POST /api/authenticate must be registered by the router"
        );
    }
}
