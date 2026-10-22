// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/git/repositories/branches`.
//!
//! Mirrors `app.api/endpoints/repository.py::get_branches`: three required
//! string query parameters, session authentication, then
//! `app.services.repository.RepositoryService.get_branches`, rendered as the
//! `app.schemas.github.Branch` list.

use serde::{Deserialize, Serialize};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// The serializable `app.schemas.github.Branch` model in its declaration
/// order (`response_model=List[Branch]` renders as `application/json`).
#[derive(Debug, Serialize)]
pub struct Branch {
    name: String,
    protected: bool,
    #[serde(rename = "default")]
    is_default: bool,
}

impl Branch {
    /// `Branch(name=..., protected=..., default=...).model_dump()` fields.
    pub(super) fn new(name: String, protected: bool, is_default: bool) -> Self {
        Self {
            name,
            protected,
            is_default,
        }
    }
}

/// `GET /api/git/repositories/branches`.
#[brz_http_server::get("/api/git/repositories/branches")]
async fn get_branches(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<BranchesQuery>,
) -> Result<Vec<Branch>, FastApiError> {
    let params = query.0.validated()?;
    state
        .git_repositories
        .get_branches(
            state.repository_tokens.as_ref(),
            &user.0,
            &params.git_repo,
            &params.kind,
            &params.git_domain,
        )
        .await
}

/// The endpoint's three required string query parameters.
///
/// `Vec<String>` collects repeated keys: FastAPI's `Query(...)` resolves a
/// repeated parameter to its last value. `#[serde(default)]` makes an absent
/// key an empty vector, which `validated` reports as the missing field;
/// unknown parameters are ignored like FastAPI ignores them.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct BranchesQuery {
    git_repo: Vec<String>,
    #[serde(rename = "type")]
    kind: Vec<String>,
    git_domain: Vec<String>,
}

impl BranchesQuery {
    /// `git_repo/type/git_domain: str = Query(...)`: required strings, in the
    /// endpoint's declaration order for the validation report.
    fn validated(self) -> Result<BranchParams, FastApiError> {
        let missing: Vec<&str> = [
            ("git_repo", self.git_repo.is_empty()),
            ("type", self.kind.is_empty()),
            ("git_domain", self.git_domain.is_empty()),
        ]
        .into_iter()
        .filter(|(_, absent)| *absent)
        .map(|(field, _)| field)
        .collect();
        if !missing.is_empty() {
            return Err(missing_error(&missing));
        }
        Ok(BranchParams {
            git_repo: last(self.git_repo),
            kind: last(self.kind),
            git_domain: last(self.git_domain),
        })
    }
}

/// FastAPI resolves a repeated query parameter to its last value.
fn last(mut values: Vec<String>) -> String {
    values.pop().unwrap_or_default()
}

/// The validated endpoint parameters.
#[derive(Debug)]
struct BranchParams {
    git_repo: String,
    kind: String,
    git_domain: String,
}

/// `app.core.exceptions.validation_exception_handler`'s `422` body
/// (`{"error_code":422,"detail":"Request parameter validation failed",
/// "errors":[...]}`), one entry per missing field in declaration order.
fn missing_error(fields: &[&str]) -> FastApiError {
    FastApiError::json_body(
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
        missing_body(fields),
    )
}

/// The handler's `422` response body for the missing required fields.
fn missing_body<'a>(fields: &[&'a str]) -> ValidationBody<'a> {
    ValidationBody {
        error_code: 422,
        detail: VALIDATION_FAILED,
        errors: fields
            .iter()
            .map(|field| ValidationItem {
                kind: "missing",
                loc: ["query", field],
                msg: "Field required",
                input: serde_json::Value::Null,
            })
            .collect(),
    }
}

/// `validation_exception_handler`'s fixed `detail` marker.
const VALIDATION_FAILED: &str = "Request parameter validation failed";

/// The handler's `422` response body.
#[derive(Debug, Serialize)]
struct ValidationBody<'a> {
    error_code: u16,
    detail: &'a str,
    errors: Vec<ValidationItem<'a>>,
}

/// One entry of the `422` `errors` array.
#[derive(Debug, Serialize)]
struct ValidationItem<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;

    fn query(raw: &str) -> Result<BranchParams, FastApiError> {
        brz_http_server::__private::query_object::<BranchesQuery>(Some(raw))
            .unwrap()
            .0
            .validated()
    }

    #[test]
    fn missing_fields_render_the_app_validation_body_in_order() {
        let error = query("").unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = missing_body(&["git_repo", "type", "git_domain"]);
        assert_eq!(body.error_code, 422);
        assert_eq!(body.detail, VALIDATION_FAILED);
        let errors = &body.errors;
        let fields: Vec<&str> = errors.iter().map(|entry| entry.loc[1]).collect();
        assert_eq!(fields, ["git_repo", "type", "git_domain"]);
        for entry in errors {
            assert_eq!(entry.kind, "missing");
            assert_eq!(entry.msg, "Field required");
            assert!(entry.input.is_null());
        }
        // The body the handler renders is the same value FastAPI's handler
        // produces for the recorded missing-field requests.
        let rendered = crate::json_contract_tests::serialized(&body).unwrap();
        assert_eq!(rendered["detail"], VALIDATION_FAILED);
        assert_eq!(rendered["errors"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn one_missing_field_is_reported_alone() {
        let error = query("git_repo=a&type=gitlab").unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = missing_body(&["git_domain"]);
        assert_eq!(body.errors.len(), 1);
        assert_eq!(body.errors[0].loc, ["query", "git_domain"]);
    }

    #[test]
    fn repeated_keys_resolve_to_the_last_value() {
        let params =
            query("git_repo=a&git_repo=b&type=gitlab&git_domain=git.example.invalid").unwrap();
        assert_eq!(params.git_repo, "b");
        assert_eq!(params.kind, "gitlab");
        assert_eq!(params.git_domain, "git.example.invalid");
    }

    #[test]
    fn empty_values_are_accepted() {
        let params = query("git_repo=&type=&git_domain=").unwrap();
        assert_eq!(params.git_repo, "");
        assert_eq!(params.kind, "");
        assert_eq!(params.git_domain, "");
    }

    #[test]
    fn unknown_parameters_are_ignored() {
        let params = query("git_repo=a&type=gitlab&git_domain=g&extra=1").unwrap();
        assert_eq!(params.git_repo, "a");
    }
}
