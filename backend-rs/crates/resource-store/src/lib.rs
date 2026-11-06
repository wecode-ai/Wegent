// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Stable persisted-resource projections and database lookup primitives.

#![forbid(unsafe_code)]

pub mod crd;
pub mod kind_rows;
pub mod resource_refs;

pub mod decision_model;

pub mod owned_kind;
pub mod shell_resolution;
#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
