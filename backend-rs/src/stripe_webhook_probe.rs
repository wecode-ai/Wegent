// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/stripe/webhook` — a Stripe webhook scanner probe path.
//!
//! The recorded request body carries a placeholder `stripe-signature`
//! header, and no router in the Python source registers a `/stripe` prefix:
//! `app/api/api.py` mounts every feature router under its own prefix and no
//! module registers `/api/stripe`, so FastAPI answers the probe with its
//! default `404 {"detail":"Not Found"}`.
//!
//! Routing the path to Rust reproduces that response directly instead of
//! proxying to the Python fallback, which answers `502 "fallback upstream
//! unavailable"` while no Python upstream runs beside the target. The handler
//! is public and ignores the JSON body and the signature header, exactly
//! like FastAPI's unmatched-route response: signature verification and body
//! validation never run before the 404. The request-ID filter generates the
//! response's `x-request-id` (the recorded `86133d53`) like every other Rust
//! API.

use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// `POST /api/stripe/webhook`: return FastAPI's default not-found body for
/// the scanner probe path the source does not register.
#[brz_http_server::post("/api/stripe/webhook", access = public)]
async fn stripe_webhook_probe() -> Result<(), FastApiError> {
    // FastAPI's default HTTPException(404) renders `{"detail":"Not Found"}`
    // as `application/json`; reproduce it exactly. The route is unmounted, so
    // the framework rejects the request before it parses the JSON body or
    // verifies the signature header.
    Err(FastApiError::detail(StatusCode::NOT_FOUND, "Not Found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_the_fastapi_default_not_found_response() {
        let error = stripe_webhook_probe().await.unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        // FastAPI's default 404 body rendered by the shared error mapper.
        assert_eq!(error.validation_detail(), r#""Not Found""#);
    }

    /// Unverified cutovers keep Python ownership while their handlers stay registered.
    #[test]
    fn registered_route_keeps_python_ownership() {
        const PATH: &str = "/api/stripe/webhook";
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH
                    && rule.methods.iter().any(|method| method == "POST")),
            "POST {PATH} must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::POST, PATH));
        assert!(!table.matches(&http::Method::GET, PATH));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & POST != 0);
        assert!(registered, "POST {PATH} must be registered by the router");
    }
}
