// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication principals and user lookup independent of application assembly.

#![forbid(unsafe_code)]

pub mod auth;
pub mod headers;
pub mod internal_auth;
pub mod jwt_compat;
pub mod user_reader;
pub use wegent_backend_config as config;
pub use wegent_backend_persistence::{request_sql, sql_support};
pub use wegent_http_compat as http_compat;

use std::sync::Arc;

/// The complete credential-verification dependency set, captured after deployment injection.
pub struct AuthServices {
    pub auth: config::AuthConfig,
    pub mysql: brz_mysql::MysqlService,
    pub jwt_secret_keys: Vec<Arc<str>>,
    pub jwt_algorithm: String,
    pub internal_chat: config::InternalChatConfig,
    pub user_reader: Arc<dyn user_reader::UserByIdReader>,
}

#[cfg(test)]
pub use wegent_backend_test_support as sql_test_support;

pub mod repository_credentials;

pub mod wework_auth_tokens;

pub mod task_token;

pub mod access_token;
