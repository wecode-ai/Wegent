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

use super::{PARENT_MARKER, PageIssue, STATUS_PREFIX};

/// `_request_issue_page` -> `_request`: fetch one page of issues from the
/// provider API. Mirrors the source URL construction and header setup. On
/// transport failure, returns `Err(error_text)` where `error_text` is the
/// rendered httpx/OpenSSL error string (used by the caller to build the 502
/// `detail`). On non-2xx status, returns `Err("HTTP status {status}")`.
pub(super) async fn request_issue_page(
    client: &brz_http::Client,
    zinfo_key: &str,
    project: &ProjectRow,
    item_status: &str,
    parent_id: Option<&str>,
    page: u32,
    limit: i64,
) -> Result<Vec<PageIssue>, String> {
    let task_provider = project.task_provider();
    let (config, token) = external_provider::resolve_provider_config(zinfo_key, project)?;
    let repository = external_provider::provider_repository(&config)?;

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

    let mut request = client
        .get(&url)
        .map_err(|error| external_provider::python_httpx_error_text(&error))?;
    if task_provider == "github" {
        request = request
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json");
    } else {
        request = request.header("PRIVATE-TOKEN", token.as_str());
    }
    let response = request
        .send()
        .await
        .map_err(|error| external_provider::python_httpx_error_text(&error))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|error| external_provider::python_httpx_error_text(&error))?;
    if !status.is_success() {
        return Err(format!("HTTP status {status}"));
    }
    let batch: Vec<PageIssue> = serde_json::from_slice(&body).map_err(|error| error.to_string())?;
    Ok(batch)
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
}
