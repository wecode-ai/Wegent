// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/experimental/dags/{dag_id}/paused/{paused}` — an Apache Airflow
//! scanner probe path.
//!
//! The recorded request asks for
//! `/api/experimental/dags/example_trigger_target_dag/paused/false`, the
//! Airflow REST shape for pausing a DAG. No router in the Python source
//! registers an `/api/experimental` or `/api/dags` prefix, and FastAPI defines
//! no catch-all route, so it answers the probe with its default
//! `404 {"detail":"Not Found"}`.
//!
//! Routing the path to Rust reproduces that response directly instead of
//! proxying to the Python fallback, which answers `502 "fallback upstream
//! unavailable"` while no Python upstream runs beside the target. The handler
//! is public and ignores the empty body, exactly like FastAPI's unmatched-route
//! response: authentication and query validation never run before the 404. The
//! request-ID filter stamps the response like every other Rust API.

use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// `GET /api/experimental/dags/example_trigger_target_dag/paused/false`:
/// return FastAPI's default not-found body for the scanner-probe path the
/// source does not register.
#[brz_http_server::get(
    "/api/experimental/dags/example_trigger_target_dag/paused/false",
    access = public
)]
async fn experimental_dag_probe() -> Result<(), FastApiError> {
    // FastAPI's default HTTPException(404) renders `{"detail":"Not Found"}`
    // as `application/json`; reproduce it exactly.
    Err(FastApiError::detail(StatusCode::NOT_FOUND, "Not Found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = "/api/experimental/dags/example_trigger_target_dag/paused/false";

    #[tokio::test]
    async fn returns_the_fastapi_default_not_found_response() {
        let error = experimental_dag_probe().await.unwrap_err();
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
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::GET, PATH));
        assert!(!table.matches(&http::Method::POST, PATH));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
