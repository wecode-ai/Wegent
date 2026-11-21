// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `LoopItemAttachmentProviderRouter.list`'s external branch:
//! `external_loop_item_provider.list_attachments`
//! (`app.services.loop_items.external_provider`).
//!
//! For an external (`KEY-number`) item the source resolves the provider
//! project, rejects non-gitlab providers with a 409, re-checks access through
//! `self.get`, then projects the gitlab issue's inline attachments:
//!
//! ```text
//! project, number = self._resolve_project(db, item_id)
//! if project.task_provider != "gitlab": raise 409 "Attachments are not
//!     supported by this Issue provider"
//! self.get(db, item_id, user_id)                 # access + view gate
//! return self._gitlab_attachments(project, item_id, self._get_issue(...))
//! ```
//!
//! The `wegent-attachment` markers are carried in the issue description (the
//! `WEGENT_ATTACHMENT_PATTERN` / `LEGACY_WEGENT_ATTACHMENT_PATTERN` shapes);
//! the id is the urlsafe-base64 of `"{item_id}\n{url}"`.

use base64::Engine as _;
use brz_http_server::StatusCode;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::board_snapshot::external_provider::{
    PROVIDER_REQUEST_FAILED_PREFIX, ProviderConfig, provider_repository, python_httpx_error_text,
    resolve_provider_config,
};
use crate::board_snapshot::repository::{BoardSnapshotRepository, ProjectRow};
use crate::loop_tasks::http_error::HttpError;
use crate::loop_tasks::loop_repository::{LoopItemRepository, has_permission};
use crate::state::AppState;

use super::response::AttachmentResponse;

/// `SECURITY_PREFIX` (`app.services.loop_items.external_provider`).
const SECURITY_PREFIX: &str = "wegent:security:";
/// `CREATOR_PREFIX` (`app.services.loop_items.external_provider`).
const CREATOR_PREFIX: &str = "wegent:creator:";
/// `ASSIGNEE_PREFIX` (`app.services.loop_items.external_provider`).
const ASSIGNEE_PREFIX: &str = "wegent:assignee:";

/// `list_attachments` for an external (`KEY-number`) item.
pub(super) async fn list_external_attachments(
    state: &AppState,
    item_id: &str,
    project: &ProjectRow,
    user_id: i32,
) -> Result<Vec<AttachmentResponse>, HttpError> {
    // `_resolve_project` re-derives the item number from the project key.
    let number = item_number(project, item_id).ok_or_else(HttpError::todo_not_found)?;

    // `if project.task_provider != "gitlab": 409`.
    if project.task_provider() != "gitlab" {
        return Err(HttpError::new(
            StatusCode::CONFLICT,
            "Attachments are not supported by this Issue provider",
        ));
    }

    // `self.get(db, item_id, user_id)`.
    let access_project = require_external_access(state, item_id, project, user_id).await?;

    // `_gitlab_attachments(project, item_id, self._get_issue(project, number))`.
    let issue = get_issue(state, &access_project, number).await?;
    gitlab_attachments(item_id, &issue)
}

/// `ExternalLoopItemProvider.get(db, item_id, user_id)`: the Viewer role
/// check, the provider issue fetch, and the `can_view_item` gate. Returns the
/// access-checked project row for the caller's own provider reply.
async fn require_external_access(
    state: &AppState,
    item_id: &str,
    project: &ProjectRow,
    user_id: i32,
) -> Result<ProjectRow, HttpError> {
    // `require_cloud_project_role(db, project.id, user_id, Viewer)`.
    let project_id: i64 = project
        .id
        .parse()
        .map_err(|_| HttpError::cloud_project_not_found())?;
    let access = BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(project_id, user_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;

    // `_get_issue(project, number)` plus the `can_view_detail` view gate.
    let number = item_number(project, item_id).ok_or_else(HttpError::todo_not_found)?;
    let issue = get_issue(state, &access.project, number).await?;
    if !can_view_item(
        state,
        &access.project,
        &access.role,
        &issue,
        item_id,
        user_id,
    )
    .await?
    {
        return Err(HttpError::todo_not_found());
    }
    Ok(access.project)
}

/// `LoopItemAttachmentProviderRouter.content`'s external branch:
/// `external_loop_item_provider.attachment_content`.
///
/// `_decode_attachment_id` -> `_resolve_project` -> `self.get` ->
/// `delivery_storage.get_bytes(self._external_attachment_key(attachment_id))`.
/// The source reports every storage failure as the 404 `Provider attachment
/// is not available in unified storage`; the filename is the resolved URL's
/// last path segment (`url.rstrip("/").rsplit("/", 1)[-1] or "attachment"`).
pub(super) async fn attachment_content(
    state: &AppState,
    attachment_id: &str,
    user_id: i32,
) -> Result<(Vec<u8>, String, String), HttpError> {
    let (item_id, url) = decode_attachment_id(attachment_id)?;
    let project = LoopItemRepository::new(&state.mysql)
        .find_external_project(&item_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::todo_not_found)?;
    require_external_access(state, &item_id, &project, user_id).await?;

    let content = crate::delivery_storage::read_object(
        &state.attachment_http,
        &external_attachment_key(attachment_id),
    )
    .await
    .map_err(|_| {
        HttpError::new(
            StatusCode::NOT_FOUND,
            "Provider attachment is not available in unified storage",
        )
    })?;
    Ok((
        content,
        "application/octet-stream".to_string(),
        filename_from_url(&url),
    ))
}

/// `_external_attachment_key`: `loop-items/external-attachments/{sha256(id)}`.
fn external_attachment_key(attachment_id: &str) -> String {
    format!(
        "loop-items/external-attachments/{}",
        hex_sha256(attachment_id)
    )
}

/// `url.rstrip("/").rsplit("/", 1)[-1] or "attachment"`.
fn filename_from_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    match trimmed.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => "attachment".to_string(),
    }
}

/// `_item_number`: the numeric suffix of `"{project_key}-{number}"`.
fn item_number(project: &ProjectRow, item_id: &str) -> Option<i64> {
    let prefix = format!("{}-", project.project_key.as_deref().unwrap_or_default());
    let raw = item_id.strip_prefix(&prefix)?;
    if raw.bytes().all(|byte| byte.is_ascii_digit()) {
        raw.parse().ok()
    } else {
        None
    }
}

/// `_get_issue` -> `_request`: fetch one provider issue. A provider `404`
/// maps to the source's `404 "TODO not found"`; any other failure maps to
/// `502 "Provider request failed: {e}"`; provider configuration failures map
/// to the source's `409`.
async fn get_issue(
    state: &AppState,
    project: &ProjectRow,
    number: i64,
) -> Result<Value, HttpError> {
    let task_provider = project.task_provider();
    let (config, token) = resolve_provider_config(&state.auth.jwt_key, project)
        .map_err(|detail| HttpError::new(StatusCode::CONFLICT, detail))?;
    let repository = provider_repository(&config)
        .map_err(|detail| HttpError::new(StatusCode::CONFLICT, detail))?;

    let api_base = provider_api_base(&task_provider, &config);
    let path = if task_provider == "github" {
        format!("/repos/{repository}/issues/{number}")
    } else {
        format!("/projects/{}/issues/{number}", url_encode_path(&repository))
    };
    let url = format!("{api_base}{path}");

    let mut request = state
        .attachment_http
        .get(&url)
        .map_err(|error| provider_failed(&python_httpx_error_text(&error)))?;
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
        .map_err(|error| provider_failed(&python_httpx_error_text(&error)))?;
    let status = response.status();
    if status.as_u16() == 404 {
        return Err(HttpError::todo_not_found());
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| provider_failed(&python_httpx_error_text(&error)))?;
    if !status.is_success() {
        return Err(provider_failed(&format!("HTTP status {status}")));
    }
    if body.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_slice(&body).map_err(|error| provider_failed(&error.to_string()))
}

/// The 502 detail wrapped with the source's `Provider request failed: `
/// prefix.
fn provider_failed(message: &str) -> HttpError {
    HttpError::new(
        StatusCode::BAD_GATEWAY,
        format!("{PROVIDER_REQUEST_FAILED_PREFIX}{message}"),
    )
}

/// `_request`'s `{api_base}` resolution: the configured `api_base`, else the
/// provider default.
fn provider_api_base(task_provider: &str, config: &ProviderConfig) -> String {
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
    config
        .api_base
        .as_deref()
        .unwrap_or(&default_api_base)
        .trim_end_matches('/')
        .to_string()
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

/// `_base_response`'s `can_view` gate (the subset that governs
/// `self.get`'s 404): maintainers always pass; otherwise the issue is visible
/// when its effective security is `open`, or when the caller is its creator,
/// the assigned user, or otherwise related.
async fn can_view_item(
    state: &AppState,
    project: &ProjectRow,
    role: &str,
    issue: &Value,
    item_id: &str,
    user_id: i32,
) -> Result<bool, HttpError> {
    if has_permission(role, "Maintainer") {
        return Ok(true);
    }
    let labels = labels(issue);
    let security = security_level(&labels, project);
    if security == "open" {
        return Ok(true);
    }
    if creator_id(&labels) == user_id {
        return Ok(true);
    }
    if let Some(assignee) = assignee_from_labels(&labels)
        && assignee.kind == "user"
        && assignee.id.parse::<i32>().ok() == Some(user_id)
    {
        return Ok(true);
    }
    LoopItemRepository::new(&state.mysql)
        .is_related_item(item_id, user_id)
        .await
        .map_err(HttpError::internal)
}

/// `_labels(issue)`: the provider label names.
fn labels(issue: &Value) -> Vec<String> {
    issue
        .get("labels")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| match item {
                    Value::Object(map) => map
                        .get("name")
                        .and_then(Value::as_str)
                        .or_else(|| map.get("title").and_then(Value::as_str))
                        .unwrap_or("")
                        .to_string(),
                    Value::String(value) => value.clone(),
                    Value::Number(value) => value.to_string(),
                    _ => String::new(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `_security_level(labels, project)`: the `wegent:security:` label value when
/// it is a known level, otherwise the project default.
fn security_level(labels: &[String], project: &ProjectRow) -> String {
    let value = labels
        .iter()
        .find_map(|label| label.strip_prefix(SECURITY_PREFIX));
    match value {
        Some("open") => "open".to_string(),
        Some("related") => "related".to_string(),
        _ => project.default_issue_security().to_string(),
    }
}

/// `_creator_id(labels)`: the `wegent:creator:` label's numeric id, else `0`.
fn creator_id(labels: &[String]) -> i32 {
    labels
        .iter()
        .find_map(|label| label.strip_prefix(CREATOR_PREFIX))
        .and_then(|rest| rest.split(':').next())
        .and_then(|raw| raw.parse::<i32>().ok())
        .unwrap_or(0)
}

/// One `wegent:assignee:` label.
struct Assignee {
    kind: String,
    id: String,
}

/// `_assignee_from_labels(labels)`.
fn assignee_from_labels(labels: &[String]) -> Option<Assignee> {
    let rest = labels
        .iter()
        .find_map(|label| label.strip_prefix(ASSIGNEE_PREFIX))?;
    let parts: Vec<&str> = rest.splitn(3, ':').collect();
    if parts.len() < 2
        || !matches!(parts[0], "user" | "agent" | "team" | "group")
        || parts[1].is_empty()
    {
        return None;
    }
    Some(Assignee {
        kind: parts[0].to_string(),
        id: parts[1].to_string(),
    })
}

/// `_gitlab_attachments`: project every attachment marker in the issue
/// description, in the source's pattern order (all `WEGENT_ATTACHMENT_PATTERN`
/// matches, then all `LEGACY_WEGENT_ATTACHMENT_PATTERN` matches).
fn gitlab_attachments(item_id: &str, issue: &Value) -> Result<Vec<AttachmentResponse>, HttpError> {
    let description = issue
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    let labels = labels(issue);
    let created_at = issue
        .get("updated_at")
        .and_then(Value::as_str)
        .or_else(|| issue.get("created_at").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(python_iso_now);
    let creator = creator_id(&labels);

    let mut matches = find_matches(description, match_wegent_at);
    matches.extend(find_matches(description, match_legacy_at));

    let mut attachments = Vec::new();
    for found in matches {
        let (encoded_item_id, url) = decode_attachment_id(&found.id)?;
        if encoded_item_id != item_id {
            continue;
        }
        let raw_id = base64_url_no_pad(&format!("{item_id}\n{url}"));
        attachments.push(AttachmentResponse::build(
            format!("gitlab-{raw_id}"),
            item_id.to_string(),
            found.name,
            found.image.then(|| "image/*".to_string()),
            0,
            hex_sha256(&url),
            creator,
            Some(created_at.clone()),
            Some(found.text),
        ));
    }
    Ok(attachments)
}

/// One matched attachment marker.
struct RawMatch {
    name: String,
    id: String,
    image: bool,
    text: String,
}

/// Collect the non-overlapping matches of one marker pattern, in text order.
fn find_matches(
    text: &str,
    matcher: fn(&str, usize) -> Option<(usize, RawMatch)>,
) -> Vec<RawMatch> {
    let bytes = text.as_bytes();
    let mut matches = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        // Both markers start with an optional `!` then `[`, so a match can
        // only begin on those ASCII bytes (a safe char boundary).
        if (bytes[index] == b'!' || bytes[index] == b'[')
            && let Some((end, found)) = matcher(text, index)
        {
            matches.push(found);
            index = end.max(index + 1);
        } else {
            index += 1;
        }
    }
    matches
}

/// `WEGENT_ATTACHMENT_PATTERN` at one position:
/// `!?[name](url)\s*<!--\s*wegent-attachment:gitlab-ID\s*-->`.
fn match_wegent_at(text: &str, index: usize) -> Option<(usize, RawMatch)> {
    let bytes = text.as_bytes();
    let image = bytes.get(index) == Some(&b'!');
    let mut cursor = if image { index + 1 } else { index };
    if bytes.get(cursor) != Some(&b'[') {
        return None;
    }
    cursor += 1;
    let name_start = cursor;
    while cursor < bytes.len() && bytes[cursor] != b']' {
        cursor += 1;
    }
    if cursor == name_start || bytes.get(cursor) != Some(&b']') {
        return None;
    }
    let name = text[name_start..cursor].to_string();
    cursor += 1;
    if bytes.get(cursor) != Some(&b'(') {
        return None;
    }
    cursor += 1;
    let url_start = cursor;
    while cursor < bytes.len() && bytes[cursor] != b')' {
        cursor += 1;
    }
    if cursor == url_start || bytes.get(cursor) != Some(&b')') {
        return None;
    }
    cursor += 1;
    cursor = skip_whitespace(bytes, cursor);
    if !text[cursor..].starts_with("<!--") {
        return None;
    }
    cursor += 4;
    cursor = skip_whitespace(bytes, cursor);
    if !text[cursor..].starts_with("wegent-attachment:") {
        return None;
    }
    cursor += "wegent-attachment:".len();
    let id_start = cursor;
    if !text[cursor..].starts_with("gitlab-") {
        return None;
    }
    cursor += "gitlab-".len();
    let id_body = cursor;
    while cursor < bytes.len()
        && (bytes[cursor].is_ascii_alphanumeric() || matches!(bytes[cursor], b'_' | b'-'))
    {
        cursor += 1;
    }
    if cursor == id_body {
        return None;
    }
    let id = text[id_start..cursor].to_string();
    cursor = skip_whitespace(bytes, cursor);
    if !text[cursor..].starts_with("-->") {
        return None;
    }
    cursor += 3;
    Some((
        cursor,
        RawMatch {
            name,
            id,
            image,
            text: text[index..cursor].to_string(),
        },
    ))
}

/// `LEGACY_WEGENT_ATTACHMENT_PATTERN` at one position:
/// `!?[name](wegent://attachments/gitlab-ID)`.
fn match_legacy_at(text: &str, index: usize) -> Option<(usize, RawMatch)> {
    let bytes = text.as_bytes();
    let image = bytes.get(index) == Some(&b'!');
    let mut cursor = if image { index + 1 } else { index };
    if bytes.get(cursor) != Some(&b'[') {
        return None;
    }
    cursor += 1;
    let name_start = cursor;
    while cursor < bytes.len() && bytes[cursor] != b']' {
        cursor += 1;
    }
    if cursor == name_start || bytes.get(cursor) != Some(&b']') {
        return None;
    }
    let name = text[name_start..cursor].to_string();
    cursor += 1;
    if bytes.get(cursor) != Some(&b'(') {
        return None;
    }
    cursor += 1;
    if !text[cursor..].starts_with("wegent://attachments/") {
        return None;
    }
    cursor += "wegent://attachments/".len();
    let id_start = cursor;
    if !text[cursor..].starts_with("gitlab-") {
        return None;
    }
    cursor += "gitlab-".len();
    let id_body = cursor;
    while cursor < bytes.len() && bytes[cursor] != b')' {
        cursor += 1;
    }
    if cursor == id_body || bytes.get(cursor) != Some(&b')') {
        return None;
    }
    let id = text[id_start..cursor].to_string();
    cursor += 1;
    Some((
        cursor,
        RawMatch {
            name,
            id,
            image,
            text: text[index..cursor].to_string(),
        },
    ))
}

/// Python `\s`: ASCII whitespace.
fn skip_whitespace(bytes: &[u8], mut cursor: usize) -> usize {
    while cursor < bytes.len()
        && matches!(
            bytes[cursor],
            b' ' | b'\t' | b'\n' | b'\r' | b'\x0b' | b'\x0c'
        )
    {
        cursor += 1;
    }
    cursor
}

/// `_decode_attachment_id`: the urlsafe-base64 `"{item_id}\n{url}"` payload.
/// A non-`gitlab-` id or an undecodable payload maps to the source's
/// `404 "TODO attachment not found"`.
pub(super) fn decode_attachment_id(attachment_id: &str) -> Result<(String, String), HttpError> {
    let not_found = HttpError::new(StatusCode::NOT_FOUND, "TODO attachment not found");
    let encoded = attachment_id.strip_prefix("gitlab-").ok_or(not_found)?;
    let padding = (4 - encoded.len() % 4) % 4;
    let padded = format!("{encoded}{}", "=".repeat(padding));
    let decoded = base64::engine::general_purpose::URL_SAFE
        .decode(padded.as_bytes())
        .map_err(|_| HttpError::new(StatusCode::NOT_FOUND, "TODO attachment not found"))?;
    let value = String::from_utf8(decoded)
        .map_err(|_| HttpError::new(StatusCode::NOT_FOUND, "TODO attachment not found"))?;
    let (item_id, url) = value
        .split_once('\n')
        .ok_or_else(|| HttpError::new(StatusCode::NOT_FOUND, "TODO attachment not found"))?;
    Ok((item_id.to_string(), url.to_string()))
}

/// `base64.urlsafe_b64encode(...).decode().rstrip("=")`.
fn base64_url_no_pad(value: &str) -> String {
    base64::engine::general_purpose::URL_SAFE
        .encode(value.as_bytes())
        .trim_end_matches('=')
        .to_string()
}

/// `hashlib.sha256(url.encode()).hexdigest()`.
fn hex_sha256(value: &str) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `datetime.now(timezone.utc).isoformat()`.
fn python_iso_now() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.6f+00:00")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board_snapshot::repository::ProjectMetadata;
    use brz_mysql::Json;

    fn project(default_security: Option<&str>) -> ProjectRow {
        let value = serde_json::json!({
            "default_issue_security": default_security,
        });
        let metadata: ProjectMetadata = serde_json::from_value(value).expect("project metadata");
        ProjectRow {
            id: "6202125112230396586".to_string(),
            public_id: None,
            project_key: Some("WEWORKPROJ".to_string()),
            name: None,
            description: None,
            created_by_user_id: 6177,
            status: "active".to_string(),
            version: 1,
            created_at: None,
            updated_at: None,
            metadata: Some(Json(metadata)),
        }
    }

    #[test]
    fn decodes_a_gitlab_attachment_id() {
        let id = format!(
            "gitlab-{}",
            base64_url_no_pad("WEWORKPROJ-7\n/uploads/a.png")
        );
        assert_eq!(
            decode_attachment_id(&id).unwrap(),
            ("WEWORKPROJ-7".to_string(), "/uploads/a.png".to_string())
        );
    }

    #[test]
    fn rejects_a_non_gitlab_attachment_id() {
        assert!(decode_attachment_id("abc").is_err());
    }

    #[test]
    fn matches_the_wegent_marker_and_captures_the_source_text() {
        let text = "![shot](/uploads/a.png)\n<!-- wegent-attachment:gitlab-QUJD -->";
        let found = find_matches(text, match_wegent_at);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "gitlab-QUJD");
        assert_eq!(found[0].name, "shot");
        assert_eq!(found[0].text, text);
        assert!(found[0].image);
    }

    #[test]
    fn matches_the_legacy_marker() {
        let text = "[file](wegent://attachments/gitlab-QUJD)";
        let found = find_matches(text, match_legacy_at);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "gitlab-QUJD");
        assert_eq!(found[0].name, "file");
        assert!(!found[0].image);
    }

    #[test]
    fn the_two_patterns_are_disjoint() {
        let text = "![shot](/uploads/a.png)<!-- wegent-attachment:gitlab-QUJD -->";
        assert!(find_matches(text, match_legacy_at).is_empty());
    }

    #[test]
    fn reads_project_default_issue_security() {
        assert_eq!(project(Some("related")).default_issue_security(), "related");
        assert_eq!(project(None).default_issue_security(), "open");
    }

    #[test]
    fn security_level_prefers_known_label_value() {
        let labels = vec!["wegent:security:open".to_string()];
        assert_eq!(security_level(&labels, &project(Some("related"))), "open");
        let unknown = vec!["wegent:security:other".to_string()];
        assert_eq!(
            security_level(&unknown, &project(Some("related"))),
            "related"
        );
    }

    #[test]
    fn parses_creator_and_assignee_labels() {
        let labels = vec![
            "wegent:creator:52:jiaqi".to_string(),
            "wegent:assignee:user:6177".to_string(),
        ];
        assert_eq!(creator_id(&labels), 52);
        let assignee = assignee_from_labels(&labels).expect("assignee");
        assert_eq!(assignee.kind, "user");
        assert_eq!(assignee.id, "6177");
    }
}
