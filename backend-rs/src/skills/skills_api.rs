// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/kinds/skills/{skill_id}/download` handler.
//!
//! Mirrors `app.api.endpoints.kind.skills.download_skill`: the five-step
//! Skill search order, the sha256 content `ETag` with `If-None-Match`
//! handling (304), and the ZIP response with the RFC 5987
//! `Content-Disposition` filename.
use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_http_server::{Binary, HttpResponse};
use serde::Deserialize;

use super::auth::{self, AuthError, UserRow};
use super::skill_download::{KindRow, SkillDownloadRepository};
use crate::state::AppState;

/// Query parameters (`namespace` default "default"; optional `task_id`).
#[derive(Debug, Deserialize)]
pub struct DownloadParams {
    #[serde(default = "default_namespace")]
    pub namespace: String,
    pub task_id: Option<i64>,
}

fn default_namespace() -> String {
    "default".to_string()
}

/// One of the endpoint's failure shapes: the plain FastAPI error, the 401
/// with its `WWW-Authenticate` challenge, the 304 with `ETag`, or a
/// binary response with download headers.
enum SkillDownloadError {
    Error(crate::http_compat::FastApiError),
    Unauthorized(AuthError),
    NotModified { etag: String },
}

impl From<AuthError> for SkillDownloadError {
    fn from(error: AuthError) -> Self {
        Self::Unauthorized(error)
    }
}

impl From<crate::http_compat::FastApiError> for SkillDownloadError {
    fn from(error: crate::http_compat::FastApiError) -> Self {
        Self::Error(error)
    }
}

impl brz_http_server::IntoHttpError for SkillDownloadError {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        match self {
            Self::Error(error) => error.into_http_error(arena),
            Self::Unauthorized(error) => {
                let mut response = crate::http_compat::FastApiError::detail(
                    StatusCode::UNAUTHORIZED,
                    error.detail,
                )
                .into_http_error(arena);
                let mut block = arena.alloc("www-authenticate: Bearer\r\n".len());
                block.extend_from_slice(b"www-authenticate: Bearer\r\n");
                if let Ok(header) = brz_http_server::HeaderBlock::new(block.freeze()) {
                    response = response.headers(header);
                }
                response
            }
            Self::NotModified { etag } => {
                let empty = crate::http_compat::FastApiError::detail(
                    StatusCode::NOT_MODIFIED,
                    String::new(),
                )
                .into_http_error(arena);
                let mut block = arena.alloc(format!("etag: {etag}\r\n").len());
                block.extend_from_slice(format!("etag: {etag}\r\n").as_bytes());
                match brz_http_server::HeaderBlock::new(block.freeze()) {
                    Ok(header) => empty.headers(header),
                    Err(_) => empty,
                }
            }
        }
    }
}

/// 404 `{"detail": ...}` body used by the source `HTTPException`s.
fn not_found(detail: &str) -> crate::http_compat::FastApiError {
    error_response(StatusCode::NOT_FOUND, detail)
}

fn error_response(status: StatusCode, detail: &str) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(status, detail)
}

fn dependency_error(error: brz_mysql::MysqlError) -> crate::http_compat::FastApiError {
    tracing::error!(%error, "skills download database dependency failure");
    error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// `_skill_content_etag`.
fn skill_content_etag(binary_data: &[u8]) -> String {
    format!("\"sha256:{}\"", auth::hex_sha256(binary_data))
}

/// `_etag_matches`: `*` or an exact match among the comma-separated values.
fn etag_matches(if_none_match: Option<&str>, etag: &str) -> bool {
    let Some(header_value) = if_none_match else {
        return false;
    };
    header_value
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == "*" || candidate == etag)
}

/// GET /api/v1/kinds/skills/{skill_id}/download: the skills-download free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/kinds/skills/:skill_id/download")]
async fn download_skill(
    #[inject(state)] state: &Arc<AppState>,
    skill_id: i32,
    namespace: Option<String>,
    task_id: Option<i64>,
    #[header] authorization: Option<&str>,
    #[header("x-api-key")] x_api_key: Option<&str>,
    #[header("if-none-match")] if_none_match: Option<&str>,
) -> Result<HttpResponse<Binary>, SkillDownloadError> {
    download(
        state,
        skill_id,
        namespace,
        task_id,
        authorization,
        x_api_key,
        if_none_match,
    )
    .await
}

/// Handler body for `GET /api/v1/kinds/skills/{skill_id}/download`.
#[allow(clippy::too_many_arguments)]
async fn download(
    state: &Arc<AppState>,
    skill_id: i32,
    namespace: Option<String>,
    task_id: Option<i64>,
    authorization: Option<&str>,
    x_api_key: Option<&str>,
    if_none_match: Option<&str>,
) -> Result<HttpResponse<Binary>, SkillDownloadError> {
    let mysql = &state.mysql;
    let headers = crate::headers::OwnedHeaders::from_pairs([
        ("authorization", authorization),
        ("x-api-key", x_api_key),
    ]);
    let headers = headers.view();
    let current_user = auth::get_current_user(&state.auth, mysql, &headers).await?;
    let repository = SkillDownloadRepository::new(mysql, state.task_policy);
    let params = DownloadParams {
        namespace: namespace.unwrap_or_else(default_namespace),
        task_id,
    };

    let resolved = match resolve_skill(
        &repository,
        &current_user,
        skill_id,
        &params,
        state,
        &headers,
    )
    .await
    {
        Ok(resolved) => resolved,
        Err(ResolveError::Denied) => {
            return Err(SkillDownloadError::Error(forbidden(
                "System skills cannot be downloaded by individual users",
            )));
        }
        Err(ResolveError::Db(error)) => {
            return Err(SkillDownloadError::Error(dependency_error(error)));
        }
    };

    let Some(resolved) = resolved else {
        return Err(SkillDownloadError::Error(not_found("Skill not found")));
    };

    let Some(binary_data) = resolved.binary_data else {
        return Err(SkillDownloadError::Error(not_found(
            "Skill binary not found",
        )));
    };

    let etag = skill_content_etag(&binary_data);
    if etag_matches(if_none_match, etag.as_str()) {
        return Err(SkillDownloadError::NotModified { etag: etag.clone() });
    }

    // RFC 5987 encoding for non-ASCII filenames.
    let filename = format!("{}.zip", resolved.skill.skill_metadata_name());
    let encoded_filename = percent_encode(&filename);
    let content_disposition = format!("attachment; filename*=UTF-8''{encoded_filename}");

    let mut response = HttpResponse::new(Binary::new(binary_data));
    response = response
        .header("content-type", "application/zip")
        .map_err(attachment_header_error)?;
    response = response
        .header("content-disposition", &content_disposition)
        .map_err(attachment_header_error)?;
    response = response
        .header("etag", &etag)
        .map_err(attachment_header_error)?;
    Ok(response)
}

/// Maps a response-header construction failure to a 500.
fn attachment_header_error(
    error: brz_http_server::HeaderBlockError,
) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

/// 403 body for system-skill download denial.
fn forbidden(detail: &str) -> crate::http_compat::FastApiError {
    error_response(StatusCode::FORBIDDEN, detail)
}

/// Resolution failure: dependency error or system-skill denial.
enum ResolveError {
    Db(brz_mysql::MysqlError),
    Denied,
}

impl From<brz_mysql::MysqlError> for ResolveError {
    fn from(error: brz_mysql::MysqlError) -> Self {
        Self::Db(error)
    }
}

/// The five-step search order. Returns `None` when the Skill is not found.
async fn resolve_skill<M>(
    repository: &SkillDownloadRepository<'_, M>,
    current_user: &UserRow,
    skill_id: i32,
    params: &DownloadParams,
    state: &Arc<AppState>,
    headers: &impl crate::headers::Headers,
) -> Result<Option<Resolved>, ResolveError>
where
    M: brz_mysql::Mysql,
{
    // 1. The user's personal Skill.
    if let Some(skill) = repository
        .get_skill_by_id(skill_id, current_user.id)
        .await?
    {
        let binary_data = repository
            .get_skill_binary(skill_id, current_user.id)
            .await?;
        return Ok(Some(Resolved { skill, binary_data }));
    }

    // 2. A personal-default SkillBinding grants archive access.
    let resolution = super::entity_resolution::EntityResolution {
        state,
        user_id: current_user.id,
    };
    let default_ids = repository.list_user_default_skill_ids(&resolution).await?;
    if default_ids.contains(&skill_id)
        && let Some((skill, binary_data)) = repository.get_skill_archive_by_id(skill_id).await?
    {
        return Ok(Some(Resolved { skill, binary_data }));
    }

    // 3. Group Skills and group bindings require Reporter access.
    if params.namespace != "default" {
        let role = repository
            .effective_role_in_group(&resolution, &params.namespace)
            .await?;
        if role.as_deref().is_some_and(reporter_or_above) {
            if let Some(skill) = repository
                .get_skill_by_id_in_namespace(skill_id, &params.namespace)
                .await?
            {
                let binary_data = repository
                    .get_skill_binary_in_namespace(skill_id, &params.namespace)
                    .await?;
                return Ok(Some(Resolved { skill, binary_data }));
            }
            if repository
                .is_skill_available_to_group(&resolution, &params.namespace, skill_id)
                .await?
                && let Some((skill, binary_data)) =
                    repository.get_skill_archive_by_id(skill_id).await?
            {
                return Ok(Some(Resolved { skill, binary_data }));
            }
        }
    }

    // 4. Task-authorized lookups when `task_id` is provided.
    if let Some(task_id) = params.task_id
        && repository.is_task_member(task_id, current_user.id).await?
        && let Some(task) = repository.get_task_by_states_routed(task_id).await?
    {
        let team_namespace = task.team_namespace();
        if team_namespace != "default"
            && repository
                .is_skill_available_to_group(&resolution, &team_namespace, skill_id)
                .await?
            && let Some((skill, binary_data)) = repository.get_skill_archive_by_id(skill_id).await?
        {
            return Ok(Some(Resolved { skill, binary_data }));
        }
        let team_owner_user_id = task.team_owner_user_id();
        if let Some(owner) = team_owner_user_id.filter(|owner| *owner != current_user.id)
            && let Some(skill) = repository.get_skill_by_id(skill_id, owner).await?
        {
            let binary_data = repository.get_skill_binary(skill_id, owner).await?;
            return Ok(Some(Resolved { skill, binary_data }));
        }
    }

    // 5. System skill (user_id=0), restricted to admins and executor
    // credentials.
    if let Some(skill) = repository.get_skill_by_id(skill_id, 0).await? {
        if !current_user.is_admin() && !auth::is_runtime_skill_download(&state.auth, headers) {
            return Err(ResolveError::Denied);
        }
        let binary_data = repository.get_skill_binary(skill_id, 0).await?;
        return Ok(Some(Resolved { skill, binary_data }));
    }

    Ok(None)
}

fn reporter_or_above(role: &str) -> bool {
    matches!(role, "Owner" | "Maintainer" | "Developer" | "Reporter")
}

/// RFC 3986 unreserved percent-encoding for the filename
/// (`quote(filename, safe="")`).
fn percent_encode(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xF) as usize] as char);
        }
    }
    out
}

/// A resolved Skill with its optional binary payload.
struct Resolved {
    skill: KindRow,
    binary_data: Option<Vec<u8>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_filenames_with_rfc5987() {
        assert_eq!(percent_encode("dingtalk-docs.zip"), "dingtalk-docs.zip");
        assert_eq!(percent_encode("a b.zip"), "a%20b.zip");
        assert_eq!(percent_encode("技能.zip"), "%E6%8A%80%E8%83%BD.zip");
    }

    #[test]
    fn etag_is_quoted_sha256() {
        let etag = skill_content_etag(b"abc");
        assert_eq!(
            etag,
            "\"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\""
        );
    }

    #[test]
    fn etag_matches_wildcard_and_exact_values() {
        let etag = "\"sha256:abc\"";
        assert!(etag_matches(Some("*"), etag));
        assert!(etag_matches(Some("\"sha256:abc\""), etag));
        assert!(etag_matches(Some("W/\"other\", \"sha256:abc\""), etag));
        assert!(!etag_matches(Some("\"sha256:other\""), etag));
        assert!(!etag_matches(None, etag));
        assert!(!etag_matches(Some(""), etag));
    }

    #[test]
    fn reporter_gate_admits_reporter_and_above() {
        for role in ["Owner", "Maintainer", "Developer", "Reporter"] {
            assert!(reporter_or_above(role));
        }
        assert!(!reporter_or_above("RestrictedAnalyst"));
    }
}
