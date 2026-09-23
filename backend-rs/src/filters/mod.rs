// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTTP compatibility filters for the hybrid server and migrated Rust APIs.

mod cors;
mod request_id;

pub(crate) use cors::server_config;
pub(crate) use request_id::RequestIdFilter;
