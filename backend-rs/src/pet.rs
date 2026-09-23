// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Current user's pet for `GET /api/users/me/pet`.
//!
//! Mirrors `app.api.endpoints.pet.get_current_user_pet`: authenticate the
//! bearer token, load the active pet `Kind` row
//! (`pet_service.get_or_create_pet` — the recorded case found an existing
//! pet, so no INSERT/UPDATE was issued), and render `PetResponse` from the
//! `spec` object inside the `kinds.json` column
//! (`pet_service.to_response`).
//!
//! Field order matches the pydantic model declaration order, and dates and
//! datetimes render pydantic-style (`2026-03-17`, `2026-03-17T19:16:00`).
use crate::json_compat::OptionalOpaqueJsonExt;
use crate::json_compat::{JsonProjection, OpaqueJson};
use serde_json::value::RawValue;
#[cfg(test)]
use serde_json::{Value, json};

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// A pet `Kind` row, selected with the full labeled source column list;
/// only `id`, `user_id`, `json`, `created_at`, and `updated_at` are
/// consumed. The result columns carry the `kinds_<column>` aliases, so
/// every field is renamed.
#[derive(Debug, brz_mysql::FromMysqlRow)]
pub struct PetKindRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_user_id")]
    pub user_id: i64,
    #[mysql(rename = "kinds_json")]
    pub json: brz_mysql::Json<JsonProjection<PetInput>>,
    #[mysql(rename = "kinds_created_at")]
    pub created_at: chrono::NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    pub updated_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_kind")]
    pub kind: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_namespace")]
    pub namespace: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_is_active")]
    pub is_active: i8,
}

/// The source `kinds` query (`PetService._get_pet_kind` filter on the
/// `Kind` model). The projection mirrors the source SQLAlchemy labeled
/// rendering (`kinds.<column> AS kinds_<column>`) so the prepared statement
/// matches the recorded exchange byte-for-byte.
const PET_KIND_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Pet' \
     AND kinds.name = 'my-pet' AND kinds.namespace = 'default' \
     AND kinds.is_active = true \n LIMIT 1";

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct PetInput {
    spec: Option<PetSpec>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct PetSpec {
    #[serde(rename = "lastActiveDate")]
    last_active_date: Option<String>,
    experience: Option<i64>,
    stage: Option<i64>,
    #[serde(rename = "currentStreak")]
    current_streak: Option<i64>,
    #[serde(rename = "petName")]
    pet_name: Option<OpaqueJson>,
    #[serde(rename = "isVisible")]
    is_visible: Option<OpaqueJson>,
    #[serde(rename = "totalChats")]
    total_chats: Option<OpaqueJson>,
    #[serde(rename = "longestStreak")]
    longest_streak: Option<OpaqueJson>,
    #[serde(rename = "appearanceTraits")]
    appearance_traits: Option<OpaqueJson>,
    #[serde(rename = "svgSeed")]
    svg_seed: Option<OpaqueJson>,
}

/// `_get_experience_to_next_stage`: `None` at max stage, otherwise
/// `max(0, next_threshold - experience)`.
fn experience_to_next_stage(experience: i64, stage: i64) -> Option<i64> {
    if stage >= 3 {
        return None;
    }
    let next_threshold = match stage + 1 {
        1 => Some(0),
        2 => Some(1000),
        3 => Some(5000),
        _ => None,
    };
    next_threshold.map(|threshold| std::cmp::max(0, threshold - experience))
}

/// `_get_streak_multiplier` tiered multiplier.
fn streak_multiplier(current_streak: i64) -> f64 {
    if current_streak >= 30 {
        1.5
    } else if current_streak >= 7 {
        1.2
    } else if current_streak >= 3 {
        1.1
    } else {
        1.0
    }
}

/// pydantic datetime serialization for the `Kind` row timestamps:
/// `YYYY-MM-DDTHH:MM:SS` (no space, no sub-second digits).
fn pydantic_datetime(value: chrono::NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Build the `PetResponse` JSON (`pet_service.to_response` + pydantic
/// serialization). Field order follows the model declaration order:
/// pet_name, is_visible (PetBase), then the PetResponse fields.
#[derive(serde::Serialize)]
struct PetResponse {
    pet_name: Box<RawValue>,
    is_visible: Box<RawValue>,
    id: i64,
    user_id: i64,
    stage: i64,
    experience: i64,
    total_chats: Box<RawValue>,
    current_streak: i64,
    longest_streak: Box<RawValue>,
    last_active_date: Option<String>,
    appearance_traits: Box<RawValue>,
    svg_seed: Box<RawValue>,
    experience_to_next_stage: Option<i64>,
    streak_multiplier: f64,
    created_at: String,
    updated_at: String,
}

fn pet_response(row: &PetKindRow) -> PetResponse {
    let empty = PetSpec::default();
    let spec = row
        .json
        .0
        .value
        .as_ref()
        .and_then(|input| input.spec.as_ref())
        .unwrap_or(&empty);
    let last_active_date = spec.last_active_date.clone();
    let experience = spec.experience.unwrap_or(0);
    let stage = spec.stage.unwrap_or(1);
    let current_streak = spec.current_streak.unwrap_or(0);
    PetResponse {
        pet_name: spec.pet_name.raw_or("Wegi"),
        is_visible: spec.is_visible.raw_or(true),
        id: row.id,
        user_id: row.user_id,
        stage,
        experience,
        total_chats: spec.total_chats.raw_or(0),
        current_streak,
        longest_streak: spec.longest_streak.raw_or(0),
        last_active_date,
        appearance_traits: spec
            .appearance_traits
            .raw_or(std::collections::BTreeMap::<String, ()>::new()),
        svg_seed: spec.svg_seed.raw_or(""),
        experience_to_next_stage: experience_to_next_stage(experience, stage),
        streak_multiplier: streak_multiplier(current_streak),
        created_at: pydantic_datetime(row.created_at),
        updated_at: pydantic_datetime(row.updated_at),
    }
}

/// GET /api/users/me/pet: the pet API free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/users/me/pet")]
async fn get_current_user_pet(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<PetResponse, FastApiError> {
    pet(state, user.0).await
}

/// Handler for `GET /api/users/me/pet`.
async fn pet(state: &AppState, user: UserRow) -> Result<PetResponse, FastApiError> {
    // `pet_service.get_or_create_pet`: read the active pet Kind row.
    let pet: Option<PetKindRow> = state
        .mysql
        .fetch_optional(PET_KIND_QUERY, (user.id,))
        .await
        .unwrap_or_else(|error| {
            tracing::error!(%error, "pet kinds database dependency failure");
            None
        });
    let body = match pet.as_ref() {
        Some(row) => pet_response(row),
        // No recorded case covers pet creation; the source would insert a
        // fresh `Wegi` pet here. Emitting the create path would diverge from
        // replay, so treat a missing row as an internal failure for now.
        None => {
            tracing::error!("pet Kind row missing for user {}", user.id);
            return Err(internal_error());
        }
    };

    Ok(body)
}

/// Source `python_exception_handler` 500 response shape.
fn internal_error() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        serde_json::json!({"error_code": 500, "detail": "Internal server error"}).to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn pet_response(row: &PetKindRow) -> Value {
        crate::json_contract_tests::serialized(super::pet_response(row)).unwrap()
    }
    fn experience_to_next_stage(experience: i64, stage: i64) -> Value {
        crate::json_contract_tests::serialized(super::experience_to_next_stage(experience, stage))
            .unwrap()
    }
    fn pet_row() -> PetKindRow {
        PetKindRow {
            id: 163080,
            user_id: 3835,
            json: brz_mysql::Json(json!({
                "kind": "Pet",
                "spec": {
                    "stage": 2, "petName": "Wegi",
                    "svgSeed": "66595db99647b3115b6281082407a1cc32b5c7baff8f03a7e44c69d76dddecbd",
                    "isVisible": true, "experience": 4088, "totalChats": 2068,
                    "currentStreak": 1, "longestStreak": 161,
                    "lastActiveDate": "2026-09-06",
                    "appearanceTraits": {
                        "color_tone": "gray", "accessories": [],
                        "primary_domain": "general", "secondary_domain": null,
                    },
                },
            })
            .into()),
            created_at: NaiveDate::from_ymd_opt(2026, 3, 17)
                .unwrap()
                .and_hms_opt(19, 16, 0)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 9, 6)
                .unwrap()
                .and_hms_opt(10, 29, 16)
                .unwrap(),
            kind: "Pet".to_string(),
            name: "my-pet".to_string(),
            namespace: "default".to_string(),
            is_active: 1,
        }
    }

    #[test]
    fn response_matches_recorded_body() {
        let body = pet_response(&pet_row());
        let expected = r#"{"pet_name":"Wegi","is_visible":true,"id":163080,"user_id":3835,"stage":2,"experience":4088,"total_chats":2068,"current_streak":1,"longest_streak":161,"last_active_date":"2026-09-06","appearance_traits":{"color_tone":"gray","accessories":[],"primary_domain":"general","secondary_domain":null},"svg_seed":"66595db99647b3115b6281082407a1cc32b5c7baff8f03a7e44c69d76dddecbd","experience_to_next_stage":912,"streak_multiplier":1.0,"created_at":"2026-03-17T19:16:00","updated_at":"2026-09-06T10:29:16"}"#;
        assert_eq!(body.to_string(), expected);
    }

    #[test]
    fn experience_to_next_stage_tiers() {
        assert_eq!(experience_to_next_stage(5000, 3), Value::Null);
        assert_eq!(experience_to_next_stage(4088, 2), json!(912));
        assert_eq!(experience_to_next_stage(0, 1), json!(1000));
        assert_eq!(experience_to_next_stage(1200, 1), json!(0));
    }

    #[test]
    fn streak_multiplier_tiers() {
        assert_eq!(streak_multiplier(0), 1.0);
        assert_eq!(streak_multiplier(3), 1.1);
        assert_eq!(streak_multiplier(7), 1.2);
        assert_eq!(streak_multiplier(30), 1.5);
    }

    #[test]
    fn pydantic_datetime_has_no_fraction() {
        let dt = NaiveDate::from_ymd_opt(2026, 1, 2)
            .unwrap()
            .and_hms_micro_opt(3, 4, 5, 678901)
            .unwrap();
        assert_eq!(pydantic_datetime(dt), "2026-01-02T03:04:05");
    }
}
