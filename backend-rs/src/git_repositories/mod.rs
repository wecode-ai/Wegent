// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/git/repositories` and `GET /api/git/repositories/search`.
//!
//! Mirrors `app/api/endpoints/repository.py::get_repositories` and its
//! `app.services.repository.RepositoryService.get_repositories` aggregation:
//! authenticate the current user, then render every configured Git provider's
//! repositories for the requested page. `search_repositories` shares that
//! projection and renders the providers' `q` matches instead.
//!
//! The routes are public endpoints. Their only deployment-specific hook is a
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
mod search;
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

/// `GET /api/git/repositories/search`.
///
/// `app.api/endpoints/repository.py::search_repositories`: `q: str =
/// Query(...)`, `timeout: int = Query(30, ge=5, le=60)`, `fullmatch: bool =
/// Query(False)`, session authentication, then the provider search and the
/// `RepositoryResult` projection.
#[brz_http_server::get("/api/git/repositories/search")]
async fn search_repositories(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<SearchQuery>,
) -> Result<Vec<RepositoryResult>, FastApiError> {
    let params = query.0.validated()?;
    state
        .git_repositories
        .search_repositories(
            state.repository_tokens.as_ref(),
            &user.0,
            &params.query,
            params.timeout,
            params.fullmatch,
        )
        .await
}

/// The endpoint's `q`/`timeout`/`fullmatch` query parameters.
///
/// `Vec<String>` collects repeated keys because FastAPI resolves a repeated
/// parameter to its last value; `#[serde(default)]` makes an absent key an
/// empty vector. Unknown parameters are ignored like FastAPI ignores them.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SearchQuery {
    q: Vec<String>,
    timeout: Vec<String>,
    fullmatch: Vec<String>,
}

/// `timeout: int = Query(30, ge=5, le=60)`.
const DEFAULT_TIMEOUT: i64 = 30;
const MIN_TIMEOUT: i64 = 5;
const MAX_TIMEOUT: i64 = 60;

/// `validation_exception_handler`'s fixed `detail` marker.
const VALIDATION_FAILED: &str = "Request parameter validation failed";

impl SearchQuery {
    /// FastAPI validates every parameter before the endpoint body runs and
    /// reports all failures in one `422`, in declaration order.
    fn validated(self) -> Result<SearchParams, FastApiError> {
        let mut errors: Vec<serde_json::Value> = Vec::new();

        let query = self.q.last().cloned().unwrap_or_else(|| {
            errors.push(missing_error("q"));
            String::new()
        });

        let timeout = self
            .timeout
            .last()
            .map_or(DEFAULT_TIMEOUT, |raw| match parse_timeout(raw) {
                Ok(value) => value,
                Err(error) => {
                    errors.push(error);
                    DEFAULT_TIMEOUT
                }
            });

        let fullmatch = self
            .fullmatch
            .last()
            .is_some_and(|raw| match parse_fullmatch(raw) {
                Ok(value) => value,
                Err(error) => {
                    errors.push(error);
                    false
                }
            });

        if !errors.is_empty() {
            return Err(FastApiError::json_body(
                brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
                ValidationBody {
                    error_code: 422,
                    detail: VALIDATION_FAILED,
                    errors,
                },
            ));
        }
        Ok(SearchParams {
            query,
            // Every value is inside `MIN_TIMEOUT..=MAX_TIMEOUT` here.
            timeout: u64::try_from(timeout).unwrap_or(DEFAULT_TIMEOUT as u64),
            fullmatch,
        })
    }
}

/// The validated endpoint parameters.
#[derive(Debug)]
struct SearchParams {
    query: String,
    timeout: u64,
    fullmatch: bool,
}

/// `{"type": "missing", "loc": ["query", <field>], "msg": "Field required",
/// "input": null}`.
fn missing_error(field: &'static str) -> serde_json::Value {
    serde_json::json!({
        "type": "missing",
        "loc": ["query", field],
        "msg": "Field required",
        "input": serde_json::Value::Null,
    })
}

/// The pydantic `int` query parse plus the `ge`/`le` constraint errors.
fn parse_timeout(raw: &str) -> Result<i64, serde_json::Value> {
    match parse_python_int(raw) {
        Some(value) if value < MIN_TIMEOUT => Err(range_error(
            "timeout",
            "greater_than_equal",
            MIN_TIMEOUT,
            value,
        )),
        Some(value) if value > MAX_TIMEOUT => Err(range_error(
            "timeout",
            "less_than_equal",
            MAX_TIMEOUT,
            value,
        )),
        Some(value) => Ok(value),
        None => Err(serde_json::json!({
            "type": "int_parsing",
            "loc": ["query", "timeout"],
            "msg": "Input should be a valid integer, unable to parse string as an integer",
            "input": raw,
        })),
    }
}

/// A pydantic `int` value from its query string (`int(value)` semantics).
fn parse_python_int(raw: &str) -> Option<i64> {
    let text = raw.trim();
    let digits = text
        .strip_prefix('+')
        .or_else(|| text.strip_prefix('-'))
        .unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<i64>().ok()
}

/// One pydantic constraint failure (`ge`/`le`) for `timeout`.
fn range_error(
    field: &'static str,
    kind: &'static str,
    bound: i64,
    value: i64,
) -> serde_json::Value {
    let msg = if kind == "greater_than_equal" {
        format!("Input should be greater than or equal to {bound}")
    } else {
        format!("Input should be less than or equal to {bound}")
    };
    serde_json::json!({
        "type": kind,
        "loc": ["query", field],
        "msg": msg,
        "input": value,
    })
}

/// `fullmatch: bool = Query(False)` with pydantic's accepted boolean literals.
fn parse_fullmatch(raw: &str) -> Result<bool, serde_json::Value> {
    match raw.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" | "y" | "t" => Ok(true),
        "false" | "0" | "no" | "off" | "n" | "f" => Ok(false),
        _ => Err(serde_json::json!({
            "type": "bool_parsing",
            "loc": ["query", "fullmatch"],
            "msg": "Input should be a valid boolean, unable to interpret input",
            "input": raw,
        })),
    }
}

/// The handlers' `422` body
/// (`app.core.exceptions.validation_exception_handler`):
/// `{"error_code":422,"detail":"Request parameter validation failed",
/// "errors":[...]}`.
#[derive(Debug, Serialize)]
struct ValidationBody<'a> {
    error_code: u16,
    detail: &'a str,
    errors: Vec<serde_json::Value>,
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

    fn search_query(raw: &str) -> Result<SearchParams, FastApiError> {
        brz_http_server::__private::query_object::<SearchQuery>(Some(raw))
            .unwrap()
            .0
            .validated()
    }

    /// The recorded request shape: a `owner%2Frepo` `q`, `timeout=30` and
    /// `fullmatch=1`.
    #[test]
    fn the_recorded_search_parameters_are_accepted() {
        let params = search_query("q=group%2Fexample-repo&timeout=30&fullmatch=1").unwrap();
        assert_eq!(params.query, "group/example-repo");
        assert_eq!(params.timeout, 30);
        assert!(params.fullmatch);
    }

    #[test]
    fn search_defaults_are_timeout_30_and_partial_match() {
        let params = search_query("q=example").unwrap();
        assert_eq!(params.query, "example");
        assert_eq!(params.timeout, 30);
        assert!(!params.fullmatch);
    }

    /// FastAPI collects every parameter failure in one `422` body, in
    /// declaration order, under the application's validation handler.
    #[test]
    fn search_reports_every_invalid_parameter_at_once() {
        let error = search_query("timeout=4&fullmatch=maybe").unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let rendered = crate::json_contract_tests::serialized(&ValidationBody {
            error_code: 422,
            detail: VALIDATION_FAILED,
            errors: vec![
                missing_error("q"),
                parse_timeout("4").unwrap_err(),
                parse_fullmatch("maybe").unwrap_err(),
            ],
        })
        .unwrap();
        assert_eq!(rendered["error_code"], 422);
        assert_eq!(rendered["detail"], VALIDATION_FAILED);
        let errors = rendered["errors"].as_array().unwrap();
        assert_eq!(errors.len(), 3);
        assert_eq!(errors[0]["type"], "missing");
        assert_eq!(errors[0]["loc"], serde_json::json!(["query", "q"]));
        assert!(errors[0]["input"].is_null());
        assert_eq!(errors[1]["type"], "greater_than_equal");
        assert_eq!(
            errors[1]["msg"],
            "Input should be greater than or equal to 5"
        );
        assert_eq!(errors[2]["type"], "bool_parsing");
    }

    #[test]
    fn search_rejects_non_integer_and_out_of_range_timeouts() {
        assert_eq!(
            parse_timeout("x").unwrap_err()["type"],
            serde_json::json!("int_parsing")
        );
        assert_eq!(
            parse_timeout("61").unwrap_err()["type"],
            serde_json::json!("less_than_equal")
        );
        for accepted in ["5", "60", " 30 "] {
            assert!(parse_timeout(accepted).is_ok(), "{accepted}");
        }
    }

    #[test]
    fn search_repeated_keys_resolve_to_the_last_value() {
        let params = search_query("q=a&q=b&fullmatch=true&fullmatch=false").unwrap();
        assert_eq!(params.query, "b");
        assert!(!params.fullmatch);
    }

    #[test]
    fn validation_body_renders_the_application_error_shape() {
        let rendered = crate::json_contract_tests::serialized(&ValidationBody {
            error_code: 422,
            detail: VALIDATION_FAILED,
            errors: vec![missing_error("q")],
        })
        .unwrap();
        assert_eq!(
            rendered,
            serde_json::json!({
                "error_code": 422,
                "detail": "Request parameter validation failed",
                "errors": [{
                    "type": "missing",
                    "loc": ["query", "q"],
                    "msg": "Field required",
                    "input": null,
                }],
            })
        );
    }
}
