// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/system/ExecuteSqlForSingle` — a FineReport SQL-injection
//! scanner probe path.
//!
//! The recorded request body is the scanner's MSSQL HashBytes probe
//! (`token=zxh&sql=select substring(sys.fn_sqlvarbasetostr(
//! HashBytes('MD5','999999999')),3,32)&strParameters`), and no router in the
//! Python source registers `/system/ExecuteSqlForSingle`: `app/api/api.py`
//! mounts feature routers under their own prefixes and no module registers a
//! `/api/system` prefix, so FastAPI answers the probe with its default
//! `404 {"detail":"Not Found"}`.
//!
//! The faithful cutover registers `POST /api/system/ExecuteSqlForSingle` so
//! the request is routed to the Rust listener instead of proxying to the
//! Python fallback (which answers `502 "fallback upstream unavailable"`
//! whenever the Python upstream is not live, as during replay). The handler
//! returns exactly the source's framework 404 body with an
//! `application/json` content type, and the request-ID filter stamps the
//! response like every other Rust API.

use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// `POST /api/system/ExecuteSqlForSingle`: return FastAPI's default
/// not-found body for the scanner probe path the source does not register.
#[brz_http_server::post("/api/system/ExecuteSqlForSingle", access = public)]
async fn execute_sql_for_single_probe() -> Result<(), FastApiError> {
    // FastAPI's default HTTPException(404) renders `{"detail":"Not Found"}`
    // as `application/json`; reproduce it exactly.
    Err(FastApiError::detail(StatusCode::NOT_FOUND, "Not Found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_the_fastapi_default_not_found_response() {
        let error = execute_sql_for_single_probe().await.unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        // FastAPI's default 404 body rendered by the shared error mapper.
        assert_eq!(error.validation_detail(), r#""Not Found""#);
    }

    /// Unverified cutovers keep Python ownership while their handlers stay registered.
    /// Rust listener.
    #[test]
    fn registered_route_keeps_python_ownership() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == "/api/system/ExecuteSqlForSingle"
                    && rule.methods.iter().any(|method| method == "POST")),
            "POST /api/system/ExecuteSqlForSingle must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::POST, "/api/system/ExecuteSqlForSingle"));
        assert!(!table.matches(&http::Method::GET, "/api/system/ExecuteSqlForSingle"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == "/api/system/ExecuteSqlForSingle" && route.methods & POST != 0);
        assert!(
            registered,
            "POST /api/system/ExecuteSqlForSingle must be registered by the router"
        );
    }
}
