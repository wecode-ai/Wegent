// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The create flow's ACL-context failure
//! (`app/services/knowledge/knowledge_visibility_query.py:_get_user_or_raise`)
//! and its endpoint response.
use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// `_get_user_or_raise`'s failure (`knowledge_visibility_query.py:645-649`):
/// the source raises `ValueError("User not found")`. `build_execution_request`
/// only wraps the body in `try/finally` (`chat/trigger/unified.py:268-402`), so
/// the error reaches the create endpoint's `except ValueError`
/// (`openapi_responses.py:1202-1210`), which answers `400` with that detail.
/// Every other failure is an unhandled dependency error.
#[derive(Debug)]
pub enum KnowledgeAccessError {
    UserNotFound,
    Mysql(brz_mysql::MysqlError),
}

impl std::fmt::Display for KnowledgeAccessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UserNotFound => formatter.write_str("User not found"),
            Self::Mysql(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for KnowledgeAccessError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::UserNotFound => None,
            Self::Mysql(error) => Some(error),
        }
    }
}

impl From<brz_mysql::MysqlError> for KnowledgeAccessError {
    fn from(error: brz_mysql::MysqlError) -> Self {
        Self::Mysql(error)
    }
}

/// Map [`KnowledgeAccessError`] to the create endpoint's response: the
/// source's `ValueError` is `400` with its detail, a store failure is the
/// dependency `500`.
pub fn knowledge_access_error(error: KnowledgeAccessError) -> FastApiError {
    match error {
        KnowledgeAccessError::UserNotFound => {
            FastApiError::detail(StatusCode::BAD_REQUEST, "User not found")
        }
        KnowledgeAccessError::Mysql(error) => super::request::dependency(error),
    }
}
