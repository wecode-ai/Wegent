// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/models/unified`.

pub mod aggregation;
pub mod auth;
pub mod config;
pub mod generation_config;
pub mod models;
pub mod mysql;
pub mod state;

mod handler;

pub use state::build_state;
