// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application-owned client construction and concrete HTTP dependency types.
//!
//! Feature modules receive clients through `M: Mysql` and `R: Redis`. Options and
//! independent cache connections live here, alongside routing configuration.
use brz_mysql::MysqlService;
use brz_redis::RedisService;
use std::sync::Arc;

pub mod app;
mod entry_routes;
pub mod models_unified;
pub mod mysql;
pub mod redis;
pub mod remote_workspace_status;
pub mod remote_workspace_tree;
pub mod routes;
pub mod runtime_check;

// HTTP registry functions require concrete types; business logic is generic.
pub type TreeState = Arc<crate::remote_workspace_tree::Deps<MysqlService, RedisService>>;
pub type StatusState = Arc<crate::remote_workspace_status::AppState<MysqlService, RedisService>>;
pub type RuntimeCheckState = crate::runtime_check::AppState<MysqlService, RedisService>;
pub type ModelsState = Arc<crate::models_unified::state::AppState<MysqlService, RedisService>>;
