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
use brz_http_server::{Response, StatusCode};
use brz_json::RawJson;
use brz_json::{JsonProjection, OpaqueJson};
use brz_mysql::MysqlTransaction;
#[cfg(test)]
use serde_json::{Value, json};

use crate::auth::{SessionUser, UserRow};
use crate::filters::source_cors;
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
/// `Kind` model). The source renders the integer `user_id` inline through
/// pymysql, so building the literal selects the text protocol and reproduces
/// the recorded line layout, including the ` \n` separators and the leading
/// space of ` LIMIT 1`.
fn pet_kind_query(user_id: i32) -> String {
    format!(
        "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.user_id = {user_id} AND kinds.kind = 'Pet' AND kinds.name = 'my-pet' AND kinds.namespace = 'default' AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `PetService.create_pet`: `db.add(pet); db.commit()` for a user without a
/// pet. SQLAlchemy renders the request-supplied columns together with the
/// model defaults and both audit timestamps through the database clock
/// (`func.now()`), so the inserted timestamps match the source session's.
const INSERT_PET_QUERY: &str = "INSERT INTO kinds (user_id, kind, name, namespace, json, \
     is_active, created_at, updated_at) \
     VALUES (?, 'Pet', 'my-pet', 'default', ?, true, now(), now())";

/// `db.refresh(pet)`: after the commit the ORM re-selects the stored row by
/// primary key with unaliased columns.
const REFRESH_PET_QUERY: &str = "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, \
     kinds.namespace, kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at \
     \nFROM kinds \nWHERE kinds.id = ?";

/// The refreshed pet row; only the response-relevant columns are consumed.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct RefreshedPetKindRow {
    id: i64,
    user_id: i64,
    json: brz_mysql::Json<JsonProjection<PetInput>>,
    created_at: chrono::NaiveDateTime,
    updated_at: chrono::NaiveDateTime,
}

impl From<RefreshedPetKindRow> for PetKindRow {
    fn from(row: RefreshedPetKindRow) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            json: row.json,
            created_at: row.created_at,
            updated_at: row.updated_at,
            kind: "Pet".to_string(),
            name: "my-pet".to_string(),
            namespace: "default".to_string(),
            is_active: 1,
        }
    }
}

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
    pet_name: RawJson,
    is_visible: RawJson,
    id: i64,
    user_id: i64,
    stage: i64,
    experience: i64,
    total_chats: RawJson,
    current_streak: i64,
    longest_streak: RawJson,
    last_active_date: Option<String>,
    appearance_traits: RawJson,
    svg_seed: RawJson,
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
    #[header("origin")] origin: Option<&str>,
    #[auth] user: SessionUser,
) -> Result<Response, FastApiError> {
    let body = pet(state, user.0).await?;
    render_pet_response(&body, origin)
}

/// Serialize the `PetResponse` model as `application/json`.
///
/// The source's FastAPI `CORSMiddleware` only runs for a request carrying an
/// `Origin` header; without one it emits neither CORS permissions nor
/// `Vary: Origin`. The gateway boundary varies by origin unconditionally, so a
/// headerless response is rendered outside it.
fn render_pet_response(body: &PetResponse, origin: Option<&str>) -> Result<Response, FastApiError> {
    let bytes = serde_json::to_vec(body).map_err(|error| {
        tracing::error!(%error, "pet response serialization failure");
        internal_error()
    })?;
    Ok(source_cors(
        Response::owned_bytes(StatusCode::OK, bytes).content_type("application/json"),
        origin,
    ))
}

/// Handler for `GET /api/users/me/pet`.
async fn pet(state: &AppState, user: UserRow) -> Result<PetResponse, FastApiError> {
    // `pet_service.get_or_create_pet`: read the active pet Kind row and create
    // the default pet when the caller has none.
    let pet: Option<PetKindRow> = state
        .mysql
        .fetch_optional(pet_kind_query(user.id), ())
        .await
        .map_err(dependency_error)?;
    let row = match pet {
        Some(row) => row,
        None => create_pet(state, user.id).await?,
    };

    Ok(pet_response(&row))
}

/// `PetService.create_pet`: insert the default `Wegi` pet and re-read the
/// committed row (`db.add`/`commit`/`refresh`) for the response.
async fn create_pet(state: &AppState, user_id: i32) -> Result<PetKindRow, FastApiError> {
    let resource = pet_resource(default_pet_spec());
    let refreshed: Option<RefreshedPetKindRow> = state
        .mysql
        .with_transaction(async |tx| {
            let inserted = tx
                .execute(INSERT_PET_QUERY, (user_id, brz_mysql::Json(resource)))
                .await?;
            tx.fetch_optional(REFRESH_PET_QUERY, (inserted.last_insert_id as i64,))
                .await
        })
        .await
        .map_err(dependency_error)?;
    refreshed.map(PetKindRow::from).ok_or_else(|| {
        tracing::error!("pet Kind row missing after create for user {user_id}");
        internal_error()
    })
}

/// `PetService._build_pet_spec()` defaults: a stage-1 `Wegi` with zeroed
/// stats, the `general` appearance, no last-active date and a fresh seed.
fn default_pet_spec() -> serde_json::Value {
    serde_json::json!({
        "petName": "Wegi",
        "stage": 1,
        "experience": 0,
        "totalChats": 0,
        "currentStreak": 0,
        "longestStreak": 0,
        "lastActiveDate": serde_json::Value::Null,
        "appearanceTraits": {
            "primary_domain": "general",
            "secondary_domain": serde_json::Value::Null,
            "color_tone": "gray",
            "accessories": [],
        },
        "svgSeed": generate_svg_seed(),
        "isVisible": true,
    })
}

/// `PetService._build_pet_resource`: the Pet CRD document stored in
/// `kinds.json`.
fn pet_resource(spec: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Pet",
        "metadata": {"name": "my-pet", "namespace": "default"},
        "spec": spec,
        "status": {"state": "Available"},
    })
}

/// `_generate_svg_seed`: `secrets.token_hex(32)` as 64 lowercase hex
/// characters from the operating system's random source.
fn generate_svg_seed() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    let mut seed = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(seed, "{byte:02x}");
    }
    seed
}

/// A failed `kinds` dependency: the source surfaces the unhandled exception
/// as `500 {"error_code": 500, "detail": "Internal server error"}`.
fn dependency_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "pet kinds database dependency failure");
    internal_error()
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

    /// The pet endpoint is registered exactly once by the router that
    /// `Application` builds; the route table selects the same method and path.
    #[test]
    fn the_pet_route_is_registered_once() {
        // `method_bit`: GET.
        const GET: u16 = 1 << 1;
        let methods: Vec<u16> =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .filter(|route| route.path == "/api/users/me/pet")
                .map(|route| route.methods)
                .collect();
        assert_eq!(methods, [GET], "the pet endpoint is registered once");
    }

    #[test]
    fn response_matches_recorded_body() {
        let body = pet_response(&pet_row());
        let expected = r#"{"pet_name":"Wegi","is_visible":true,"id":163080,"user_id":3835,"stage":2,"experience":4088,"total_chats":2068,"current_streak":1,"longest_streak":161,"last_active_date":"2026-09-06","appearance_traits":{"color_tone":"gray","accessories":[],"primary_domain":"general","secondary_domain":null},"svg_seed":"66595db99647b3115b6281082407a1cc32b5c7baff8f03a7e44c69d76dddecbd","experience_to_next_stage":912,"streak_multiplier":1.0,"created_at":"2026-03-17T19:16:00","updated_at":"2026-09-06T10:29:16"}"#;
        assert_eq!(body.to_string(), expected);
    }

    fn body_bytes(response: &Response) -> &[u8] {
        match response.body() {
            brz_http_server::ResponseBody::Owned(bytes) => bytes,
            other => panic!("unexpected response body: {other:?}"),
        }
    }

    /// The source `CORSMiddleware` bypasses a request without an `Origin`
    /// header, so the target must not gain the gateway's unconditional
    /// `Vary: Origin`; a cross-origin request keeps the configured policy.
    #[test]
    fn headerless_responses_skip_gateway_cors() {
        let body = super::pet_response(&pet_row());
        let headerless = render_pet_response(&body, None).unwrap();
        assert_eq!(
            headerless.cors_policy(),
            brz_http_server::ResponseCors::Skip
        );
        let cross_origin = render_pet_response(&body, Some("https://app.example")).unwrap();
        assert_eq!(
            cross_origin.cors_policy(),
            brz_http_server::ResponseCors::Apply
        );
    }

    /// The rendered response carries the same bytes the typed handler
    /// previously emitted, so moving to `Response` preserves the body.
    #[test]
    fn rendered_response_keeps_the_model_bytes() {
        let body = super::pet_response(&pet_row());
        let rendered = render_pet_response(&body, None).unwrap();
        assert_eq!(
            String::from_utf8_lossy(body_bytes(&rendered)),
            crate::json_contract_tests::serialized(super::pet_response(&pet_row()))
                .unwrap()
                .to_string()
        );
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
    fn default_pet_spec_matches_source_defaults() {
        let spec = default_pet_spec();
        assert_eq!(spec["petName"], json!("Wegi"));
        assert_eq!(spec["stage"], json!(1));
        assert_eq!(spec["experience"], json!(0));
        assert_eq!(spec["totalChats"], json!(0));
        assert_eq!(spec["currentStreak"], json!(0));
        assert_eq!(spec["longestStreak"], json!(0));
        assert_eq!(spec["lastActiveDate"], Value::Null);
        assert_eq!(
            spec["appearanceTraits"],
            json!({
                "primary_domain": "general",
                "secondary_domain": null,
                "color_tone": "gray",
                "accessories": [],
            })
        );
        assert_eq!(spec["isVisible"], json!(true));
        let seed = spec["svgSeed"].as_str().unwrap();
        assert_eq!(seed.len(), 64);
        assert!(seed.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn created_pet_resource_matches_source_crd() {
        let resource = pet_resource(default_pet_spec());
        assert_eq!(resource["apiVersion"], json!("agent.wecode.io/v1"));
        assert_eq!(resource["kind"], json!("Pet"));
        assert_eq!(
            resource["metadata"],
            json!({"name": "my-pet", "namespace": "default"})
        );
        assert_eq!(resource["status"], json!({"state": "Available"}));
        assert!(resource["spec"].is_object());
    }

    #[test]
    fn generated_svg_seeds_are_unique() {
        assert_ne!(generate_svg_seed(), generate_svg_seed());
    }

    #[test]
    fn pet_lookup_matches_the_recorded_text_protocol_statement() {
        assert_eq!(
            pet_kind_query(2524),
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.user_id = 2524 AND kinds.kind = 'Pet' AND kinds.name = 'my-pet' AND kinds.namespace = 'default' AND kinds.is_active = true \n LIMIT 1"
        );
    }

    #[test]
    fn create_statements_mirror_the_source_orm_rendering() {
        assert!(INSERT_PET_QUERY.starts_with(
            "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, \
             created_at, updated_at) VALUES (?, 'Pet', 'my-pet', 'default', ?, true, \
             now(), now())"
        ));
        assert!(REFRESH_PET_QUERY.contains("FROM kinds \nWHERE kinds.id = ?"));
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
