// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Provider-page HTTP request and URL encoding for the loop-item-pages
//! read path.
//!
//! `_request_issue_page` -> `_request` (`app.services.loop_items.
//! external_provider`): fetch one page of issues from the provider API,
//! mirroring the source URL construction, query serialization, and header
//! setup.
use crate::board_snapshot::external_provider;
use crate::board_snapshot::repository::ProjectRow;

use super::page_cache;
use super::{PARENT_MARKER, PageIssue, STATUS_PREFIX};

/// `_request_issue_page` -> `_request`: fetch one page of issues from the
/// provider API, through the source's 30-second issue-page cache
/// (`_list_issue_page`). Mirrors the source URL construction and header
/// setup. A transport failure returns [`ProviderError::Failed`] carrying the
/// rendered httpx/OpenSSL error text, and a `404` response returns
/// [`ProviderError::NotFound`]; the caller turns those into the source's
/// `502 "Provider request failed: {e}"` and `404 "TODO not found"`.
pub(super) async fn request_issue_page(
    client: &brz_http::Client,
    zinfo_key: &str,
    project: &ProjectRow,
    item_status: &str,
    parent_id: Option<&str>,
    page: u32,
    limit: i64,
) -> Result<Vec<PageIssue>, ProviderError> {
    // The cache stores the raw issue JSON values (the source caches the raw
    // dicts); each read re-projects them into `PageIssue` rows.
    if let Some(values) = page_cache::cached_page(
        &project.id,
        project.version,
        item_status,
        parent_id,
        page,
        limit,
    ) {
        return project_page(values);
    }
    let values = fetch_issue_page(
        client,
        zinfo_key,
        project,
        item_status,
        parent_id,
        page,
        limit,
    )
    .await?;
    page_cache::store_page(
        &project.id,
        project.version,
        item_status,
        parent_id,
        page,
        limit,
        values.clone(),
    );
    project_page(values)
}

/// Project the raw provider issue JSON into typed `PageIssue` rows.
fn project_page(values: Vec<serde_json::Value>) -> Result<Vec<PageIssue>, ProviderError> {
    values
        .into_iter()
        .map(|value| serde_json::from_value(value).map_err(|error| error.to_string()))
        .collect::<Result<Vec<PageIssue>, String>>()
        .map_err(ProviderError::Failed)
}

/// `_request_issue_page` -> `_request`: the uncached provider HTTP fetch.
async fn fetch_issue_page(
    client: &brz_http::Client,
    zinfo_key: &str,
    project: &ProjectRow,
    item_status: &str,
    parent_id: Option<&str>,
    page: u32,
    limit: i64,
) -> Result<Vec<serde_json::Value>, ProviderError> {
    let task_provider = project.task_provider();
    let (config, token) = external_provider::resolve_provider_config(zinfo_key, project)
        .map_err(ProviderError::Failed)?;
    let repository =
        external_provider::provider_repository(&config).map_err(ProviderError::Failed)?;

    let default_domain = if task_provider == "github" {
        "github.com"
    } else {
        "gitlab.com"
    };
    let domain = config.domain.as_deref().unwrap_or(default_domain).trim();
    let default_api_base = if task_provider == "github" {
        "https://api.github.com".to_string()
    } else {
        format!("https://{domain}/api/v4")
    };
    let api_base = config
        .api_base
        .as_deref()
        .unwrap_or(&default_api_base)
        .trim_end_matches('/')
        .to_string();

    // `_request_issue_page` path construction.
    let path = if task_provider == "github" {
        format!("/repos/{repository}/issues")
    } else {
        format!("/projects/{}/issues", url_encode_path(&repository))
    };

    // Build query parameters. The source uses `params` dict which httpx
    // serializes as URL query string.
    let state = if task_provider == "github" {
        "open"
    } else {
        "opened"
    };

    let mut query_parts: Vec<(String, String)> = Vec::new();
    query_parts.push(("state".to_string(), state.to_string()));
    query_parts.push(("per_page".to_string(), limit.to_string()));
    query_parts.push(("page".to_string(), page.to_string()));

    // `labels = [f"{STATUS_PREFIX}{item_status}"]`; github pending has no
    // labels filter.
    let has_labels = !(task_provider == "github" && item_status == "pending");
    if has_labels {
        query_parts.push((
            "labels".to_string(),
            format!("{STATUS_PREFIX}{item_status}"),
        ));
    }

    // Gitlab-specific search params.
    if task_provider == "gitlab" {
        if parent_id.is_none() {
            query_parts.push(("not[search]".to_string(), PARENT_MARKER.to_string()));
            query_parts.push(("not[in]".to_string(), "description".to_string()));
        } else {
            query_parts.push((
                "search".to_string(),
                format!("{PARENT_MARKER} {}", parent_id.unwrap_or("")),
            ));
            query_parts.push(("in".to_string(), "description".to_string()));
        }
    }

    let query_string = query_parts
        .iter()
        .map(|(k, v)| format!("{}={}", url_encode_query(k), url_encode_query(v)))
        .collect::<Vec<_>>()
        .join("&");

    let url = format!("{api_base}{path}?{query_string}");

    let mut request = client.get(&url).map_err(|error| {
        ProviderError::Failed(external_provider::python_httpx_error_text(&error))
    })?;
    if task_provider == "github" {
        request = request
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json");
    } else {
        request = request.header("PRIVATE-TOKEN", token.as_str());
    }
    let response = request.send().await.map_err(|error| {
        ProviderError::Failed(external_provider::python_httpx_error_text(&error))
    })?;
    let status = response.status();
    let body = response.bytes().await.map_err(|error| {
        ProviderError::Failed(external_provider::python_httpx_error_text(&error))
    })?;
    if !status.is_success() {
        // `_request` maps a provider `404` to `404 "TODO not found"` and every
        // other `HTTPStatusError` to `502 "Provider request failed: {exc}"`,
        // where `{exc}` is httpx's rendering of the failed response.
        if status.as_u16() == 404 {
            return Err(ProviderError::NotFound);
        }
        return Err(ProviderError::Failed(python_httpx_status_error_text(
            status, &url,
        )));
    }
    let batch: Vec<serde_json::Value> =
        serde_json::from_slice(&body).map_err(|error| ProviderError::Failed(error.to_string()))?;
    Ok(batch)
}

/// A provider-page failure classified the way the source's `_request` does.
pub(super) enum ProviderError {
    /// `httpx.HTTPStatusError` with a `404` status.
    NotFound,
    /// Any other `httpx.HTTPError`; carries httpx's rendered error text.
    Failed(String),
}

/// `httpx.HTTPStatusError.__str__`: `raise_for_status` renders the failed
/// response as `"{error_type} '{status} {reason}' for url '{url}'"` followed
/// by the MDN status reference line.
fn python_httpx_status_error_text(status: brz_http::StatusCode, url: &str) -> String {
    let code = status.as_u16();
    let reason = status.canonical_reason().unwrap_or_default();
    let error_type = match code / 100 {
        1 => "Informational response",
        3 => "Redirect response",
        4 => "Client error",
        5 => "Server error",
        _ => "Invalid status code",
    };
    format!(
        "{error_type} '{code} {reason}' for url '{url}'\n\
         For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/{code}"
    )
}

/// `urllib.parse.quote(repository, safe='')`: percent-encode every byte
/// except unreserved characters.
fn url_encode_path(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        let un_reserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
        if un_reserved {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xF) as usize] as char);
        }
    }
    out
}

/// URL-encode a query parameter value (httpx uses `quote_via=quote_plus` by
/// default, which encodes spaces as `+`).
fn url_encode_query(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else if byte == b' ' {
            out.push('+');
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xF) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_encode_path_percent_encodes_slash() {
        assert_eq!(
            url_encode_path("example_org/common/example/wegent"),
            "example_org%2Fcommon%2Fexample%2Fwegent"
        );
    }

    #[test]
    fn url_encode_query_encodes_space_as_plus() {
        assert_eq!(
            url_encode_query("Wegent-Parent: 507"),
            "Wegent-Parent%3A+507"
        );
    }

    /// `python_httpx_status_error_text` reproduces httpx's
    /// `HTTPStatusError.__str__` for a failed response.
    #[test]
    fn failed_status_renders_httpx_raise_for_status_text() {
        let text = python_httpx_status_error_text(
            brz_http::StatusCode::UNAUTHORIZED,
            "https://gitlab.example/api/v4/projects/Web%2FV7%2FApp/issues",
        );
        assert_eq!(
            text,
            "Client error '401 Unauthorized' for url \
             'https://gitlab.example/api/v4/projects/Web%2FV7%2FApp/issues'\n\
             For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/401"
        );
    }

    /// `_request` maps a provider `404` to the source's `TODO not found`
    /// branch, distinct from the generic provider failure.
    #[test]
    fn failed_status_classifies_not_found() {
        assert_eq!(
            python_httpx_status_error_text(brz_http::StatusCode::NOT_FOUND, "https://x/y"),
            "Client error '404 Not Found' for url 'https://x/y'\n\
             For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404"
        );
    }
}
