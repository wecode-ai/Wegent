// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/git/repositories`.
//!
//! Mirrors `app/api/endpoints/repository.py::get_repositories` and its
//! `app.services.repository.RepositoryService.get_repositories` aggregation:
//! authenticate the current user, then render every configured Git provider's
//! repositories for the requested page.
//!
//! The route is a public endpoint. Its only deployment-specific hook is a
//! provider patch that resolves `"***"` GitLab tokens
//! through the application's credential service; the target exposes that as
//! [`crate::repository_tokens::RepositoryTokenResolver`], defaulting to the
//! stored value.
//!
//! `GET /api/git/repositories/branches` lives in the same router and shares
//! the provider, entry-projection, and token-resolution infrastructure; see
//! [`branches`] and [`branch_providers`].
mod branch_providers;
mod branches;
mod cache;
pub(crate) mod crypto;
mod digest;
mod projection;
mod providers;
mod service;
mod worker;

pub use branches::Branch;
pub use service::GitRepositoriesService;

use serde::{Deserialize, Serialize};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// The serializable `app.schemas.github.RepositoryResult` model in its
/// declaration order. `response_model=List[RepositoryResult]` renders as
/// `application/json`.
#[derive(Debug, Serialize)]
pub struct RepositoryResult {
    git_repo_id: i64,
    name: String,
    git_repo: String,
    git_url: String,
    git_domain: String,
    #[serde(rename = "type")]
    kind: String,
    private: bool,
}

impl RepositoryResult {
    /// The route's `RepositoryResult(git_repo_id=repo["id"], ...)` mapping.
    fn from_repo(repo: providers::ProviderRepo) -> Self {
        Self {
            git_repo_id: repo.id,
            name: repo.name,
            git_repo: repo.full_name,
            git_url: repo.clone_url,
            git_domain: repo.git_domain,
            kind: repo.kind.to_string(),
            private: repo.private,
        }
    }
}

/// `GET /api/git/repositories`.
#[brz_http_server::get("/api/git/repositories")]
async fn get_repositories(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<RepositoriesQuery>,
) -> Result<Vec<RepositoryResult>, FastApiError> {
    let params = query.0.validated()?;
    state
        .git_repositories
        .get_repositories(
            state.repository_tokens.as_ref(),
            &user.0,
            params.page,
            params.limit,
        )
        .await
}

/// The endpoint's `page`/`limit` query parameters.
#[derive(Debug, Deserialize)]
struct RepositoriesQuery {
    page: Option<String>,
    limit: Option<String>,
}

impl RepositoriesQuery {
    /// `page: int = Query(1, ge=1)` and
    /// `limit: int = Query(1000, ge=1, le=5000)`.
    fn validated(self) -> Result<PageParams, FastApiError> {
        let page = parse_query_int(self.page.as_deref(), "page", 1, 1, i64::MAX)?;
        let limit = parse_query_int(self.limit.as_deref(), "limit", 1000, 1, 5000)?;
        Ok(PageParams { page, limit })
    }
}

#[derive(Debug)]
struct PageParams {
    page: i64,
    limit: i64,
}

/// One FastAPI `422` validation entry (`detail[]`).
#[derive(Debug, Serialize)]
struct ValidationEntry<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: String,
    input: String,
}

/// Parse an optional integer query parameter with FastAPI-compatible
/// validation. The default is used when the parameter is absent.
fn parse_query_int(
    raw: Option<&str>,
    field: &'static str,
    default: i64,
    min: i64,
    max: i64,
) -> Result<i64, FastApiError> {
    match raw {
        None => Ok(default),
        Some(value) => match value.parse::<i64>() {
            Ok(parsed) if parsed >= min && parsed <= max => Ok(parsed),
            Ok(_) => Err(validation_error(
                field,
                "greater_than_equal",
                format!("Input should be greater than or equal to {min}"),
                value,
            )),
            Err(_) => Err(validation_error(
                field,
                "int_parsing",
                "Input should be a valid integer, unable to parse string as an integer".to_string(),
                value,
            )),
        },
    }
}

/// FastAPI-style `422` validation-error body.
fn validation_error(
    field: &'static str,
    kind: &'static str,
    msg: String,
    input: &str,
) -> FastApiError {
    FastApiError::validation([ValidationEntry {
        kind,
        loc: ["query", field],
        msg,
        input: input.to_string(),
    }])
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;

    #[test]
    fn defaults_apply_when_parameters_are_absent() {
        let params = RepositoriesQuery {
            page: None,
            limit: None,
        }
        .validated()
        .unwrap();
        assert_eq!((params.page, params.limit), (1, 1000));
    }

    #[test]
    fn recorded_parameters_are_accepted() {
        let params = RepositoriesQuery {
            page: Some("1".to_string()),
            limit: Some("5000".to_string()),
        }
        .validated()
        .unwrap();
        assert_eq!((params.page, params.limit), (1, 5000));
    }

    #[test]
    fn out_of_range_and_non_integer_values_are_unprocessable() {
        for (field, raw, kind) in [
            ("page", "0", "greater_than_equal"),
            ("limit", "5001", "greater_than_equal"),
            ("page", "x", "int_parsing"),
        ] {
            let query = match field {
                "page" => RepositoriesQuery {
                    page: Some(raw.to_string()),
                    limit: None,
                },
                _ => RepositoriesQuery {
                    page: None,
                    limit: Some(raw.to_string()),
                },
            };
            let error = query.validated().unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert!(
                error.validation_detail().contains(kind),
                "{}",
                error.validation_detail()
            );
        }
    }

    #[test]
    fn repository_result_uses_the_source_field_order_and_names() {
        let repo = providers::ProviderRepo {
            id: 1131734767,
            name: "Wegent".to_string(),
            full_name: "wecode-ai/Wegent".to_string(),
            clone_url: "https://github.com/wecode-ai/Wegent.git".to_string(),
            git_domain: "github.com".to_string(),
            kind: "github",
            private: false,
        };
        assert_eq!(
            serde_json::to_string(&RepositoryResult::from_repo(repo)).unwrap(),
            r#"{"git_repo_id":1131734767,"name":"Wegent","git_repo":"wecode-ai/Wegent","git_url":"https://github.com/wecode-ai/Wegent.git","git_domain":"github.com","type":"github","private":false}"#
        );
    }
}
