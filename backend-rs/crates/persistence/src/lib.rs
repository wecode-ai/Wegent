// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! SQL transaction ownership, statement values, and explicit routing contracts.

#![forbid(unsafe_code)]

pub mod request_sql;
pub mod sql_support;
pub mod task_routing;

pub mod entity_query;

pub mod connection;
#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
