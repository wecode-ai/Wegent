// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/internal/skills/{skill_id}/binary` handler.
//!
//! Mirrors `app.api.endpoints.internal.skills.get_skill_binary`: the
//! internal-service-token bearer check
//! (`verify_internal_service_token`, no database access), the public-Skill
//! lookup (`user_id=0`, `kind='Skill'`, active), the `skill_binaries` row
//! fetch, and the ZIP response with the plain
//! `Content-Disposition: attachment; filename=<name>.zip` header.
use brz_http_server::{Binary, HttpResponse, IntoHttpError, Response, StatusCode};
use brz_mysql::{Mysql, MysqlResult};

use super::skill_download::{KindRow, SkillBinaryRow};
use crate::state::AppState;

/// Failure shapes: the bearer-token 401 with its `WWW-Authenticate`
/// challenge, or a plain FastAPI-style error body.
enum InternalSkillBinaryError {
    Error(crate::http_compat::FastApiError),
}

impl From<brz_mysql::MysqlError> for InternalSkillBinaryError {
    fn from(error: brz_mysql::MysqlError) -> Self {
        tracing::error!(%error, "internal skills binary database dependency failure");
        Self::Error(crate::http_compat::FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ))
    }
}

impl From<crate::http_compat::FastApiError> for InternalSkillBinaryError {
    fn from(error: crate::http_compat::FastApiError) -> Self {
        Self::Error(error)
    }
}

impl IntoHttpError for InternalSkillBinaryError {
    fn into_http_error(self, arena: &brz_http_server::EphemeralBytesArena) -> Response {
        match self {
            Self::Error(error) => error.into_http_error(arena),
        }
    }
}

/// 404 `{"detail": ...}` body used by the source `HTTPException`s.
fn not_found(detail: &str) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(StatusCode::NOT_FOUND, detail)
}

/// Maps a response-header construction failure to a 500.
fn header_error(error: brz_http_server::HeaderBlockError) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

/// GET /api/internal/skills/{skill_id}/binary: the internal skills binary
/// free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/internal/skills/:skill_id/binary")]
async fn get_skill_binary(
    #[inject(state)] state: &AppState,
    skill_id: i32,
    #[auth] _service: crate::internal_auth::InternalService,
) -> Result<HttpResponse<Binary>, InternalSkillBinaryError> {
    serve_skill_binary(state, skill_id).await
}

/// Handler body for `GET /api/internal/skills/{skill_id}/binary`.
async fn serve_skill_binary(
    state: &AppState,
    skill_id: i32,
) -> Result<HttpResponse<Binary>, InternalSkillBinaryError> {
    let mysql = &state.mysql;
    let skill = public_skill(mysql, skill_id).await?;
    let Some(skill) = skill else {
        return Err(InternalSkillBinaryError::Error(not_found(
            "Skill not found",
        )));
    };

    let binary = skill_binary_data(mysql, skill_id).await?;
    // `not skill_binary or not skill_binary.binary_data`: an empty payload is
    // also "not found" (falsy bytes in the source check).
    let Some(binary) = binary.filter(|data| !data.is_empty()) else {
        return Err(InternalSkillBinaryError::Error(not_found(
            "Skill binary not found",
        )));
    };

    tracing::info!(
        skill_id,
        name = %skill.name,
        size = binary.len(),
        "[internal_skills] serving skill binary"
    );

    let response = HttpResponse::new(Binary::new(binary))
        .header("content-type", "application/zip")
        .map_err(header_error)?
        .header("content-disposition", &content_disposition(&skill.name))
        .map_err(header_error)?;
    Ok(response)
}

/// The public-Skill existence lookup (`user_id=0` only).
async fn public_skill<M: Mysql>(mysql: &M, skill_id: i32) -> MysqlResult<Option<KindRow>> {
    mysql
        .fetch_optional(
            "SELECT id, user_id, kind, name, namespace, json FROM kinds \
             WHERE id = ? AND user_id = ? AND kind = 'Skill' AND is_active = 1 LIMIT 1",
            (skill_id, 0),
        )
        .await
}

/// The `skill_binaries.binary_data` payload for the Skill.
async fn skill_binary_data<M: Mysql>(mysql: &M, skill_id: i32) -> MysqlResult<Option<Vec<u8>>> {
    let row: Option<SkillBinaryRow> = mysql
        .fetch_optional(
            "SELECT binary_data FROM skill_binaries WHERE kind_id = ? LIMIT 1",
            (skill_id,),
        )
        .await?;
    Ok(row.map(|row| row.binary_data))
}

/// `f"attachment; filename={skill.name}.zip"` — the source sends the raw
/// name without quoting or RFC 5987 encoding.
fn content_disposition(name: &str) -> String {
    format!("attachment; filename={name}.zip")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_disposition_uses_the_raw_name() {
        assert_eq!(
            content_disposition("material-to-video-unified-async"),
            "attachment; filename=material-to-video-unified-async.zip"
        );
        // The source does not percent-encode or quote non-ASCII names.
        assert_eq!(content_disposition("技能"), "attachment; filename=技能.zip");
    }

    #[test]
    fn empty_binary_payload_is_treated_as_not_found() {
        // `not skill_binary.binary_data` is a falsy check in the source, so
        // an empty payload must fall into the 404 branch rather than be
        // served as a zero-byte ZIP.
        let binary: Option<Vec<u8>> = Some(Vec::new());
        assert!(binary.filter(|data| !data.is_empty()).is_none());
        let missing: Option<Vec<u8>> = None;
        assert!(missing.filter(|data| !data.is_empty()).is_none());
        let present: Option<Vec<u8>> = Some(vec![0x50, 0x4b]);
        assert_eq!(
            present.filter(|data| !data.is_empty()),
            Some(vec![0x50, 0x4b])
        );
    }
}
