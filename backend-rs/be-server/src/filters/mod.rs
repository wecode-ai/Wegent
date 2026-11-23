// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTTP compatibility filters for the hybrid server and migrated Rust APIs.

mod cors;
mod request_id;
mod response_cors;

pub(crate) use cors::{FastApiCorsFilter, gateway_cors, server_config};
pub use request_id::RequestIdFilter;
pub use response_cors::SourceCorsFilter;
pub(crate) use wegent_http_compat::source_cors;
