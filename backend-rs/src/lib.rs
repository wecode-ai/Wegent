//! Public integration boundary for moving Wegent backend routes to Rust.
//!
//! Generic routing and transport live in `brz-http-gateway`. This crate owns only
//! Wegent's public route implementation seam and executable configuration.

// These docs name external frameworks and libraries (FastAPI, SQLAlchemy,
// PyMySQL) in prose, where backticks read worse than plain text. Rust
// identifiers and code spans are still written as code.
#![allow(clippy::doc_markdown)]

use std::sync::Arc;

mod application;
mod hybrid;

pub use application::{AppState, Application};
pub use hybrid::{HybridConfig, run_hybrid, serve_hybrid, serve_hybrid_application};

// General-purpose capabilities shared by every migrated route. They carry no
// organization-specific knowledge, so private applications reuse them instead
// of duplicating them.
pub mod auth;
pub mod config;
pub mod http_compat;
pub mod json_compat;
pub mod mysql;

pub use brz_http_gateway::{
    BoxError, ConfigError, Gateway, GatewayBody, GatewayResponse, MatchedService as RustApi,
    OriginService, PathMatch, ProxyConfigError, RejectMatched as NoRustApi, RouteRule, RouteTable,
    RoutesConfig, bind, serve,
};

/// Re-export the exact Breeze server revision used by public and private APIs.
pub use brz_http_server as http_server;

// Public function APIs use the default registry. Application-specific crates
// merge their own explicitly named registries into `Application::routes`.
brz_http_server::registry!(dependencies(state: Arc<AppState>));
