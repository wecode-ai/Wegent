// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/api/v1/wework-notifications` — a doubled-prefix probe path.
//!
//! The Python source registers the wework-notifications router at
//! `/api/v1/wework-notifications`: `app/api/api.py` includes it with
//! `prefix="/v1/wework-notifications"` and `app/main.py` mounts `api_router`
//! at `settings.API_PREFIX` (`/api`). No router registers the nested
//! `/api/api/...` path, and FastAPI defines no catch-all route, so it answers
//! this request with its default `404 {"detail":"Not Found"}`.
//!
//! Routing the path to Rust reproduces that response directly instead of
//! proxying to the Python fallback, which answers `502 "fallback upstream
//! unavailable"` while no Python upstream runs beside the target. The handler
//! is public and ignores the JSON body, exactly like FastAPI's unmatched-route
//! response: authentication and body validation never run before the 404. The
//! request-ID filter stamps the response like every other Rust API.

use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// `POST /api/api/v1/wework-notifications`: return FastAPI's default
/// not-found body for the nested path the source does not register.
#[brz_http_server::post("/api/api/v1/wework-notifications", access = public)]
async fn nested_wework_notifications_probe() -> Result<(), FastApiError> {
    // FastAPI's default HTTPException(404) renders `{"detail":"Not Found"}`
    // as `application/json`; reproduce it exactly.
    Err(FastApiError::detail(StatusCode::NOT_FOUND, "Not Found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_the_fastapi_default_not_found_response() {
        let error = nested_wework_notifications_probe().await.unwrap_err();
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
                .any(|rule| rule.path == "/api/api/v1/wework-notifications"
                    && rule.methods.iter().any(|method| method == "POST")),
            "POST /api/api/v1/wework-notifications must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::POST, "/api/api/v1/wework-notifications"));
        assert!(!table.matches(&http::Method::GET, "/api/api/v1/wework-notifications"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == "/api/api/v1/wework-notifications" && route.methods & POST != 0);
        assert!(
            registered,
            "POST /api/api/v1/wework-notifications must be registered by the router"
        );
    }
}
