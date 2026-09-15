//! Public integration boundary for moving Wegent backend routes to Rust.
//!
//! Generic routing and transport live in `brz-http-gateway`. This crate owns only
//! Wegent's public route implementation seam and executable configuration.

mod application;
mod hybrid;

pub use application::{AppState, PublicApi};
pub use hybrid::{HybridConfig, run_hybrid, serve_hybrid};

pub use brz_http_gateway::{
    BoxError, ConfigError, Gateway, GatewayBody, GatewayResponse, MatchedService as RustApi,
    OriginService, PathMatch, ProxyConfigError, RejectMatched as NoRustApi, RouteRule, RouteTable,
    RoutesConfig, bind, serve,
};

/// Re-export the exact Breeze server revision used by public and private APIs.
pub use brz_http_server as http_server;
