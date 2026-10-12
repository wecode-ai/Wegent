// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/me/git-accounts/sync-summary`.
//!
//! Mirrors `app.api.endpoints.users.get_git_account_sync_summary` and
//! `app.services.device.git_credentials.build_git_account_sync_summary`: it
//! renders the current user's stored Git accounts as ordered, credential-free
//! metadata. The only input is the authenticated `users` row, so the handler
//! reads no external service.
use std::collections::HashMap;

use brz_http_server::StatusCode;
use serde_json::Value;

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;

/// `SUPPORTED_PROVIDERS`.
const SUPPORTED_PROVIDERS: [&str; 5] = ["github", "gitlab", "gitee", "gitea", "gerrit"];

/// GET /api/users/me/git-accounts/sync-summary.
///
/// The source declares `response_model=GitAccountSyncSummary`, so FastAPI
/// renders the model as `application/json`; returning the serializable view
/// keeps that content type instead of the raw-bytes
/// `application/octet-stream` default.
#[brz_http_server::get("/api/users/me/git-accounts/sync-summary")]
async fn get_git_account_sync_summary(
    #[auth] user: SessionUser,
) -> Result<GitAccountSyncSummary, FastApiError> {
    build_git_account_sync_summary(&user.0)
}

/// `build_git_account_sync_summary`: ordered per-domain account metadata.
///
/// `DeviceGitCredentialResolutionError` (a failed domain normalization, an
/// unsupported provider) becomes the source's `422 {"detail": ...}`.
fn build_git_account_sync_summary(user: &UserRow) -> Result<GitAccountSyncSummary, FastApiError> {
    let accounts = git_accounts(&user.git_info.0);
    let mut summaries = Vec::with_capacity(accounts.len());
    let mut first_by_domain: HashMap<String, String> = HashMap::new();
    for (index, account) in accounts.iter().enumerate() {
        let domain = normalize_domain(account.get("git_domain")).map_err(resolution_error)?;
        let provider = text_field(account.get("type")).trim().to_lowercase();
        if !SUPPORTED_PROVIDERS.contains(&provider.as_str()) {
            return Err(resolution_error(format!(
                "Unsupported Git provider for domain {domain}"
            )));
        }
        let account_id = account_id(account);
        // `_account_key`: the account's own id, else a positional fallback.
        let key = if account_id.is_empty() {
            format!("{domain}:{index}")
        } else {
            account_id.clone()
        };
        let duplicate_of = first_by_domain.get(&domain).cloned();
        let effective = duplicate_of.is_none();
        if effective {
            first_by_domain.insert(domain.clone(), key);
        }
        let login = text_field(account.get("git_login"));
        let login = if login.is_empty() {
            text_field(account.get("user_name"))
        } else {
            login
        };
        summaries.push(GitAccountSyncSummaryItem {
            id: optional_text(account_id),
            domain,
            provider,
            login: optional_text(login.trim().to_string()),
            email: optional_text(text_field(account.get("git_email")).trim().to_string()),
            effective,
            duplicate_of,
        });
    }
    let duplicate_count = summaries.iter().filter(|item| !item.effective).count();
    Ok(GitAccountSyncSummary {
        effective_count: summaries.len() - duplicate_count,
        duplicate_count,
        accounts: summaries,
    })
}

/// `_git_accounts`: the stored `git_info` column as its member objects. A list
/// keeps only its object members (`isinstance(item, dict)`); a bare object is a
/// single account; any other shape (including `null`) yields no accounts.
fn git_accounts(json: &OpaqueJson) -> Vec<serde_json::Map<String, Value>> {
    match json.project::<Value>() {
        Some(Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| match item {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .collect(),
        Some(Value::Object(map)) => vec![map],
        _ => Vec::new(),
    }
}

/// `str(account.get("id") or "")` without the surrounding schema validation.
fn account_id(account: &serde_json::Map<String, Value>) -> String {
    text_field(account.get("id")).trim().to_string()
}

/// `str(value or "")`: a falsy JSON value (`null`, `false`, `0`, `""`, `[]`,
/// `{}`) renders as the empty string; everything else as its Python `str`
/// form. The stored `GitInfo` fields are strings, so the number and container
/// branches only keep malformed documents from panicking: arrays and objects
/// render as JSON text rather than Python's `repr`.
fn text_field(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::Bool(true)) => "True".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => {
            if number.as_f64() == Some(0.0) {
                String::new()
            } else {
                number.to_string()
            }
        }
        Some(value @ (Value::Array(_) | Value::Object(_))) => {
            if is_empty_container(value) {
                String::new()
            } else {
                value.to_string()
            }
        }
    }
}

fn is_empty_container(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.is_empty(),
        Value::Object(object) => object.is_empty(),
        _ => false,
    }
}

/// `str(...).strip() or None`.
fn optional_text(text: String) -> Option<String> {
    (!text.is_empty()).then_some(text)
}

fn resolution_error(message: String) -> FastApiError {
    FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, message)
}

/// `_normalize_domain`: the normalized `host[:port]`.
///
/// Reproduces Python `urllib.parse.urlsplit` field extraction: the scheme is
/// the prefix before `://`, the netloc ends at the first `/`, `?` or `#`, the
/// last `@` separates userinfo from the host, and an invalid port raises
/// `ValueError` before any domain check.
fn normalize_domain(value: Option<&Value>) -> Result<String, String> {
    let raw = text_field(value);
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Git account domain is required".to_string());
    }
    let (scheme, after) = match raw.find("://") {
        Some(index) => (&raw[..index], &raw[index + 3..]),
        None => ("", raw),
    };
    let netloc_end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let netloc = &after[..netloc_end];
    let rest = &after[netloc_end..];

    let (userinfo, host_port) = match netloc.rfind('@') {
        Some(index) => (Some(&netloc[..index]), &netloc[index + 1..]),
        None => (None, netloc),
    };

    // `urlsplit` parses the port before any domain check; an invalid port
    // raises `ValueError` ahead of every message below.
    let (host, port) = host_and_port(host_port)?;

    if !scheme.is_empty() && !scheme.eq_ignore_ascii_case("https") {
        return Err("Only HTTPS Git account domains can be synchronized".to_string());
    }

    if let Some(userinfo) = userinfo {
        let username = userinfo.split(':').next().unwrap_or("");
        let password = userinfo.split_once(':').map(|(_, password)| password);
        if !username.is_empty() || password.is_some_and(|password| !password.is_empty()) {
            return Err("Git account domain is unsafe".to_string());
        }
    }

    let (before_fragment, fragment) = split_once(rest, '#');
    let (path, query) = split_once(before_fragment, '?');
    if !query.is_empty() || !fragment.is_empty() {
        return Err("Git account domain is unsafe".to_string());
    }
    if !path.is_empty() && path != "/" {
        return Err("Git account domain must not contain a path".to_string());
    }

    let host = host.trim().trim_end_matches('.').to_lowercase();
    if host.is_empty() {
        return Err("Git account domain is invalid".to_string());
    }
    let host = idna_ascii(&host)?;
    Ok(match port {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// The host and optional port of a netloc's authority. A bracketed IPv6
/// literal keeps the address between the brackets; otherwise the last `:`
/// separates the port. A non-numeric or out-of-range port is invalid.
fn host_and_port(host_port: &str) -> Result<(&str, Option<u32>), String> {
    let invalid = || "Git account domain is invalid".to_string();
    let (host, port) = if let Some(inner) = host_port.strip_prefix('[') {
        let close = inner.find(']').ok_or_else(invalid)?;
        let after_bracket = &inner[close + 1..];
        let port = match after_bracket.strip_prefix(':') {
            Some(port) => Some(port),
            None if after_bracket.is_empty() => None,
            None => return Err(invalid()),
        };
        (&inner[..close], port)
    } else {
        match host_port.rfind(':') {
            Some(index) => (&host_port[..index], Some(&host_port[index + 1..])),
            None => (host_port, None),
        }
    };
    match port {
        None => Ok((host, None)),
        Some(port) => {
            let port = port.trim();
            if port.is_empty() {
                return Ok((host, None));
            }
            let digits = port.strip_prefix('+').unwrap_or(port);
            let value: u32 = digits.parse().map_err(|_| invalid())?;
            if value > 65535 {
                return Err(invalid());
            }
            Ok((host, Some(value)))
        }
    }
}

/// `host.encode("idna").decode("ascii")`.
///
/// The Python `idna` codec accepts every ASCII label except an empty one or one
/// longer than 63 bytes; a non-ASCII host is converted to its ASCII (punycode)
/// form through the `url` crate's IDNA-aware host parser.
fn idna_ascii(host: &str) -> Result<String, String> {
    if host.is_ascii() {
        if host
            .split('.')
            .any(|label| label.is_empty() || label.len() > 63)
        {
            return Err("Git account domain is invalid".to_string());
        }
        return Ok(host.to_string());
    }
    match url::Host::parse(host) {
        Ok(url::Host::Domain(domain)) => Ok(domain),
        _ => Err("Git account domain is invalid".to_string()),
    }
}

/// `text.split_once(separator)` with an empty remainder when absent.
fn split_once(text: &str, separator: char) -> (&str, &str) {
    text.split_once(separator).unwrap_or((text, ""))
}

/// The serializable `GitAccountSyncSummary` model in its declaration order.
#[derive(Debug, serde::Serialize)]
struct GitAccountSyncSummary {
    accounts: Vec<GitAccountSyncSummaryItem>,
    effective_count: usize,
    duplicate_count: usize,
}

/// The serializable `GitAccountSyncSummaryItem` model in its declaration order.
#[derive(Debug, serde::Serialize)]
struct GitAccountSyncSummaryItem {
    id: Option<String>,
    domain: String,
    provider: String,
    login: Option<String>,
    email: Option<String>,
    effective: bool,
    duplicate_of: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use serde_json::json;

    /// A `users` row whose only meaningful field is the stored `git_info`.
    fn user_row(git_info: Value) -> UserRow {
        UserRow {
            id: 157,
            user_name: "example-user".to_string(),
            users_password_hash: "hash".to_string(),
            email: Some("example-user@example.invalid".to_string()),
            git_info: brz_mysql::Json(OpaqueJson::from(git_info)),
            is_active: 1,
            role: "admin".to_string(),
            auth_source: "oidc".to_string(),
            preferences: "{}".to_string(),
            created_at: NaiveDate::from_ymd_opt(2025, 12, 24)
                .unwrap()
                .and_hms_opt(17, 42, 56)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 9, 8)
                .unwrap()
                .and_hms_opt(19, 18, 0)
                .unwrap(),
        }
    }

    fn build(git_info: Value) -> Result<GitAccountSyncSummary, FastApiError> {
        build_git_account_sync_summary(&user_row(git_info))
    }

    fn summary(git_info: Value) -> Value {
        crate::json_contract_tests::serialized(build(git_info).unwrap()).unwrap()
    }

    /// A single account renders the model's field order, types and values. The
    /// bytes are asserted through the model so the source declaration order is
    /// preserved (`accounts`, `effective_count`, `duplicate_count`).
    #[test]
    fn renders_account_metadata_in_source_order() {
        let git_info = json!([{
            "id": "11111111-2222-3333-4444-555555555555",
            "type": "gitlab",
            "git_id": "25",
            "auth_type": null,
            "git_email": "alice@example.invalid",
            "git_login": "alice",
            "git_token": "***",
            "user_name": "alice",
            "git_domain": "gitlab.example.invalid"
        }]);
        let body = build(git_info).unwrap();
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            "{\"accounts\":[{\"id\":\"11111111-2222-3333-4444-555555555555\",\"domain\":\"gitlab.example.invalid\",\"provider\":\"gitlab\",\"login\":\"alice\",\"email\":\"alice@example.invalid\",\"effective\":true,\"duplicate_of\":null}],\"effective_count\":1,\"duplicate_count\":0}"
        );
    }

    #[test]
    fn later_accounts_on_the_same_domain_are_ineffective() {
        let body = summary(json!([
            {"id": "a", "type": "github", "git_domain": "github.com", "git_login": "one"},
            {"id": "b", "type": "gitlab", "git_domain": "github.com", "git_login": "two"},
            {"type": "gitee", "git_domain": "gitee.com"}
        ]));
        assert_eq!(body["effective_count"], json!(2));
        assert_eq!(body["duplicate_count"], json!(1));
        assert_eq!(body["accounts"][1]["effective"], json!(false));
        assert_eq!(body["accounts"][1]["duplicate_of"], json!("a"));
        // A missing id falls back to the positional key and renders `null`.
        assert_eq!(body["accounts"][2]["id"], json!(null));
        assert_eq!(body["accounts"][2]["login"], json!(null));
    }

    #[test]
    fn an_unparseable_or_unsupported_account_is_unprocessable() {
        for (git_info, detail) in [
            (
                json!([{"type": "gitlab"}]),
                "Git account domain is required",
            ),
            (
                json!([{"type": "gitlab", "git_domain": "http://git.example.com"}]),
                "Only HTTPS Git account domains can be synchronized",
            ),
            (
                json!([{"type": "gitlab", "git_domain": "git.example.com/path"}]),
                "Git account domain must not contain a path",
            ),
            (
                json!([{"type": "gitlab", "git_domain": "user@git.example.com"}]),
                "Git account domain is unsafe",
            ),
            (
                json!([{"type": "svn", "git_domain": "git.example.com"}]),
                "Unsupported Git provider for domain git.example.com",
            ),
        ] {
            let error = build(git_info).unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert!(
                error.validation_detail().contains(detail),
                "{}",
                error.validation_detail()
            );
        }
    }

    #[test]
    fn domains_are_normalized_like_urlsplit() {
        assert_eq!(
            normalize_domain(Some(&json!("git.example.com"))).unwrap(),
            "git.example.com"
        );
        assert_eq!(
            normalize_domain(Some(&json!("  GIT.Example.COM.  "))).unwrap(),
            "git.example.com"
        );
        assert_eq!(
            normalize_domain(Some(&json!("https://git.example.com:8443"))).unwrap(),
            "git.example.com:8443"
        );
        assert_eq!(
            normalize_domain(Some(&json!("git.example.com/"))).unwrap(),
            "git.example.com"
        );
        assert!(normalize_domain(Some(&json!("git.example.com:99999"))).is_err());
        assert!(normalize_domain(Some(&json!("git.example.com:abc"))).is_err());
        assert!(normalize_domain(Some(&json!("a..b"))).is_err());
        // An invalid port is reported before the userinfo or scheme checks.
        assert_eq!(
            normalize_domain(Some(&json!("user@git.example.com:abc"))).unwrap_err(),
            "Git account domain is invalid"
        );
        assert_eq!(
            normalize_domain(Some(&json!("http://git.example.com:abc"))).unwrap_err(),
            "Git account domain is invalid"
        );
    }

    #[test]
    fn a_null_or_scalar_git_info_has_no_accounts() {
        for git_info in [json!(null), json!("x"), json!(7)] {
            let body = summary(git_info);
            assert_eq!(body["accounts"], json!([]));
            assert_eq!(body["effective_count"], json!(0));
            assert_eq!(body["duplicate_count"], json!(0));
        }
    }
}
