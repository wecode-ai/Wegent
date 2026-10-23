// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/kinds/skills/bindings/me` handler.
//!
//! Mirrors `app.api.endpoints.kind.skills.list_my_default_skill_bindings`
//! together with `skill_binding_service.list_user_default_bindings` and
//! `to_response`: the caller's active `SkillBinding` rows whose target is the
//! user themselves, each filtered through the per-Skill access rule, projected
//! to the `SkillBindingResponse` list.
//!
//! The binding lookup, the `_get_active_skill` lookup, the `kinds.json`
//! projection (`KindPayload`) and the access rule are shared with the
//! capability-center listing, which ports the same `skill_binding_service`
//! methods, so this module reuses them rather than maintaining a second copy.
use brz_http_server::StatusCode;
use brz_mysql::MysqlResult;
use chrono::NaiveDateTime;
use serde::Serialize;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::resource_library_listings::models::{JsonScalar, KindPayload, format_datetime};
use crate::resource_library_listings::repository::{
    KindPayloadRow, fetch_active_skill, fetch_user_default_bindings,
};
use crate::resource_library_listings::skill_bindings::{
    can_user_access_skill, extract_skill_id, is_user_default_binding,
};
use crate::state::AppState;
use crate::teams::group_membership::ErpContext;

/// `SkillBindingResponse`.
#[derive(Debug, Serialize)]
struct BindingResponse {
    id: i64,
    target_type: String,
    target_id: String,
    skill_ref: SkillRefResponse,
    exceptions: Vec<ExceptionResponse>,
    force_preload: bool,
    created_at: String,
    updated_at: String,
}

/// `SkillBindingSkillRef`.
#[derive(Debug, Serialize)]
struct SkillRefResponse {
    skill_id: i64,
    name: String,
    namespace: String,
    is_public: bool,
}

/// `SkillBindingException`.
#[derive(Debug, Serialize)]
struct ExceptionResponse {
    #[serde(rename = "type")]
    kind: String,
    value: String,
}

/// GET /api/v1/kinds/skills/bindings/me.
#[brz_http_server::get("/api/v1/kinds/skills/bindings/me")]
async fn list_my_default_skill_bindings(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<Vec<BindingResponse>, FastApiError> {
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    list_bindings(&state.mysql, &erp, i64::from(current_user.id))
        .await
        .map_err(dependency_error)
}

/// `list_user_default_bindings` + `to_response`.
async fn list_bindings<M, R>(
    mysql: &M,
    erp: &ErpContext<'_, R>,
    user_id: i64,
) -> MysqlResult<Vec<BindingResponse>>
where
    M: brz_mysql::Mysql,
    R: brz_redis::Redis,
{
    let target_id = format!("user:{user_id}");
    let mut responses = Vec::new();
    for binding in fetch_user_default_bindings(mysql, user_id).await? {
        let Some(payload) = binding.payload() else {
            continue;
        };
        if !is_user_default_binding(payload, &target_id) {
            continue;
        }
        let Some(skill_id) = extract_skill_id(payload) else {
            continue;
        };
        // `_get_active_skill` plus `can_user_access_skill`.
        let Some(skill) = fetch_active_skill(mysql, skill_id).await? else {
            continue;
        };
        if !can_user_access_skill(mysql, erp, user_id, &skill).await? {
            continue;
        }
        responses.push(to_response(
            binding.kinds_id,
            binding.kinds_created_at,
            binding.kinds_updated_at,
            payload,
            skill_id,
        ));
    }
    Ok(responses)
}

/// `to_response`: project one accepted SkillBinding row.
fn to_response(
    id: i64,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
    payload: &KindPayload,
    skill_id: i64,
) -> BindingResponse {
    let spec = &payload.spec;
    let skill_ref = spec.skill_ref.as_ref();
    let is_public = truthy(skill_ref.and_then(|reference| reference.is_public.as_ref()))
        || truthy(skill_ref.and_then(|reference| reference.is_public_snake.as_ref()));
    BindingResponse {
        id,
        target_type: "user".to_string(),
        target_id: text_or(spec.target_id.as_ref(), ""),
        skill_ref: SkillRefResponse {
            skill_id,
            name: text_or(skill_ref.and_then(|reference| reference.name.as_ref()), ""),
            namespace: text_or(
                skill_ref.and_then(|reference| reference.namespace.as_ref()),
                "default",
            ),
            is_public,
        },
        exceptions: extract_exceptions(payload),
        force_preload: truthy(spec.force_preload.as_ref())
            || truthy(spec.legacy_force_preload.as_ref()),
        created_at: format_datetime(created_at),
        updated_at: format_datetime(updated_at),
    }
}

/// Python `str(value or default)`: falsy scalars fall back to `default`.
fn text_or(value: Option<&JsonScalar>, default: &str) -> String {
    match value {
        Some(scalar) if !scalar.is_falsy() => scalar.text(),
        _ => default.to_string(),
    }
}

/// Python truthiness for a scalar field (`bool(value or ...)`).
fn truthy(value: Option<&JsonScalar>) -> bool {
    value.is_some_and(|scalar| !scalar.is_falsy())
}

/// `_extract_exceptions` + `_normalize_exceptions`: validated, trimmed and
/// de-duplicated while preserving the stored order.
fn extract_exceptions(payload: &KindPayload) -> Vec<ExceptionResponse> {
    let Some(entries) = payload.spec.exceptions.as_ref() else {
        return Vec::new();
    };
    let mut normalized: Vec<ExceptionResponse> = Vec::new();
    for entry in entries.iter().flatten() {
        let Some(kind) = exception_type(entry.kind.as_ref()) else {
            continue;
        };
        let Some(raw_value) = exception_value(entry.value.as_ref()) else {
            continue;
        };
        let value = raw_value.trim().to_string();
        if value.is_empty()
            || normalized
                .iter()
                .any(|existing| existing.kind == kind && existing.value == value)
        {
            continue;
        }
        normalized.push(ExceptionResponse {
            kind: kind.to_string(),
            value,
        });
    }
    normalized
}

/// `SkillBindingExceptionType`: only the three stored enum values validate.
fn exception_type(value: Option<&JsonScalar>) -> Option<&'static str> {
    match value {
        Some(JsonScalar::Text(text)) => match text.as_str() {
            "mode" => Some("mode"),
            "agent" => Some("agent"),
            "project" => Some("project"),
            _ => None,
        },
        _ => None,
    }
}

/// `SkillBindingException.value`: a non-empty `str` of at most 128 characters
/// (pydantic validates the raw, unstripped value).
fn exception_value(value: Option<&JsonScalar>) -> Option<String> {
    match value {
        Some(JsonScalar::Text(text)) if (1..=128).contains(&text.chars().count()) => {
            Some(text.clone())
        }
        _ => None,
    }
}

fn dependency_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "my skill bindings database dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(json: serde_json::Value) -> KindPayload {
        serde_json::from_value(json).expect("test payload projects")
    }

    fn at(text: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    #[test]
    fn projects_binding_fields() {
        let value = payload(serde_json::json!({
            "spec": {
                "targetType": "user",
                "targetId": "user:2594",
                "skillRef": {
                    "skillId": 494125,
                    "name": "sentinel-report_dev",
                    "namespace": "default",
                    "isPublic": false
                },
                "exceptions": [],
                "forcePreload": false
            }
        }));
        let rendered = serde_json::to_value(to_response(
            494126,
            at("2026-09-17 02:50:09"),
            at("2026-09-17 02:50:09"),
            &value,
            494125,
        ))
        .unwrap();
        assert_eq!(
            rendered,
            serde_json::json!({
                "id": 494126,
                "target_type": "user",
                "target_id": "user:2594",
                "skill_ref": {
                    "skill_id": 494125,
                    "name": "sentinel-report_dev",
                    "namespace": "default",
                    "is_public": false
                },
                "exceptions": [],
                "force_preload": false,
                "created_at": "2026-09-17T02:50:09",
                "updated_at": "2026-09-17T02:50:09"
            })
        );
    }

    #[test]
    fn normalizes_exceptions_and_force_preload() {
        let value = payload(serde_json::json!({
            "spec": {
                "skillRef": {"skillId": 7},
                "exceptions": [
                    {"type": "mode", "value": "  chat  "},
                    {"type": "mode", "value": "chat"},
                    {"type": "agent", "value": ""},
                    {"type": "bogus", "value": "x"},
                    {"type": "project", "value": "p-1"}
                ],
                "force_preload": true
            }
        }));
        let rendered = serde_json::to_value(to_response(
            1,
            at("2026-01-02 03:04:05"),
            at("2026-01-02 03:04:05"),
            &value,
            7,
        ))
        .unwrap();
        assert_eq!(
            rendered["exceptions"],
            serde_json::json!([
                {"type": "mode", "value": "chat"},
                {"type": "project", "value": "p-1"}
            ])
        );
        assert_eq!(rendered["force_preload"], serde_json::json!(true));
    }

    #[test]
    fn defaults_missing_skill_ref_members() {
        let value = payload(serde_json::json!({
            "spec": {"targetId": "user:5", "skillRef": {"skillId": 9, "isPublic": true}}
        }));
        let rendered = serde_json::to_value(to_response(
            2,
            at("2026-01-02 03:04:05"),
            at("2026-01-02 03:04:05"),
            &value,
            9,
        ))
        .unwrap();
        assert_eq!(
            rendered["skill_ref"],
            serde_json::json!({
                "skill_id": 9,
                "name": "",
                "namespace": "default",
                "is_public": true
            })
        );
        assert_eq!(rendered["force_preload"], serde_json::json!(false));
    }

    /// Deferred APIs retain Python ownership and registered Rust implementations.
    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/v1/kinds/skills/bindings/me";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must remain on Python"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::GET, PATH));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must have a registered handler");
    }
}
