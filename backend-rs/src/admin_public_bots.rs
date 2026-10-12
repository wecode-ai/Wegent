// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/public-bots`.
//!
//! Source: `app/api/endpoints/admin/public_bots.py::list_public_bots` (router
//! prefix `/admin`, mounted under the API prefix, so the external path is
//! `/api/admin/public-bots`).
//!
//! The endpoint authenticates the bearer session and requires an admin user
//! (`app/core/security.py::get_admin_user`, `role == "admin"`, otherwise
//! `403 {"detail": "Permission denied. Admin access required."}`), then:
//!
//! 1. `db.query(Kind).filter(user_id == 0, kind == "Bot").count()` — the
//!    public `kinds` total.
//! 2. `... .order_by(updated_at.desc()).offset((page - 1) * limit).limit(limit)`
//!    — the requested page, selected with SQLAlchemy's labeled projection.
//! 3. For each Bot, `_bot_to_response(bot, db)` looks up the referenced public
//!    `Ghost` (expanded into the Ghost spec fields) and the referenced `Model`
//!    (rendered as `agent_config`). Lookups preserve the bot order and run one
//!    statement per bot without caching.
//!
//! Response body: `PublicBotListResponse { total, items }` where each item is
//! the pydantic `PublicBotResponse` field order. The persisted `kinds.json`
//! values are consumed through the shared [`crate::json_compat`] types rather
//! than the JSON crate directly.

use std::collections::BTreeMap;

use brz_mysql::{FromMysqlRow, Json, MysqlError};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::json_compat::{JsonField, OpaqueJson};
use crate::state::AppState;

/// `app/core/security.py::get_admin_user` rejection detail.
const ADMIN_DETAIL: &str = "Permission denied. Admin access required.";

/// SQLAlchemy's labeled `db.query(Kind)` projection
/// (`kinds.<column> AS kinds_<column>`), shared by every statement below so
/// the rendered SQL matches the recorded exchange.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// One public `Bot`/`Ghost`/`Model` `kinds` row. Only the fields this read
/// surface consumes are decoded; the extra selected columns are ignored.
#[derive(Debug, FromMysqlRow)]
struct KindRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[mysql(rename = "kinds_json")]
    json: Json<OpaqueJson>,
    #[mysql(rename = "kinds_is_active")]
    is_active: i8,
    #[mysql(rename = "kinds_created_at")]
    created_at: NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    updated_at: NaiveDateTime,
}

/// `count(*) AS count_1` row (`query.count()`).
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    #[mysql(rename = "count_1")]
    count: i64,
}

/// `query.count()` for the public Bots.
fn count_sql() -> String {
    format!(
        "SELECT count(*) AS count_1 \n\
         FROM (SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = 0 AND kinds.kind = 'Bot') AS anon_1"
    )
}

/// The ordered page query (`offset = (page - 1) * limit`).
fn list_sql(offset: i64, limit: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = 0 AND kinds.kind = 'Bot' ORDER BY kinds.updated_at DESC \n\
         LIMIT {offset}, {limit}"
    )
}

/// `_bot_to_response`'s public Ghost lookup (`get_by name+namespace`, no
/// `is_active` filter).
fn ghost_sql() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = 0 AND kinds.kind = 'Ghost' \
         AND kinds.name = ? AND kinds.namespace = ? \n LIMIT 1"
    )
}

/// `_bot_to_response`'s public Model lookup (`get_by name+namespace`, no
/// `is_active` filter).
fn model_sql() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = 0 AND kinds.kind = 'Model' \
         AND kinds.name = ? AND kinds.namespace = ? \n LIMIT 1"
    )
}

/// Query parameters for `GET /api/admin/public-bots` (`page = Query(1, ge=1)`,
/// `limit = Query(20, ge=1, le=1000)`).
#[derive(Debug, serde::Deserialize)]
struct PublicBotsQuery {
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

/// One FastAPI 422 validation entry (`{type, loc, msg, input}`).
#[derive(Debug, Serialize)]
struct QueryValidationError<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: &'a str,
}

/// FastAPI-style 422 validation body for one query parameter.
fn validation_error(field: &str, kind: &str, message: &str, input: &str) -> FastApiError {
    FastApiError::validation([QueryValidationError {
        kind,
        loc: ["query", field],
        msg: message,
        input,
    }])
}

impl PublicBotsQuery {
    /// Validate the FastAPI query contract and return `(page, limit)`.
    fn validated(self) -> Result<(i64, i64), FastApiError> {
        let page = match &self.page {
            None => 1,
            Some(raw) => {
                let parsed: i64 = raw.parse().map_err(|_| {
                    validation_error(
                        "page",
                        "int_parsing",
                        "Input should be a valid integer, unable to parse string as an integer",
                        raw,
                    )
                })?;
                if parsed < 1 {
                    return Err(validation_error(
                        "page",
                        "greater_than_equal",
                        "Input should be greater than or equal to 1",
                        raw,
                    ));
                }
                parsed
            }
        };
        let limit = match &self.limit {
            None => 20,
            Some(raw) => {
                let parsed: i64 = raw.parse().map_err(|_| {
                    validation_error(
                        "limit",
                        "int_parsing",
                        "Input should be a valid integer, unable to parse string as an integer",
                        raw,
                    )
                })?;
                if parsed < 1 {
                    return Err(validation_error(
                        "limit",
                        "greater_than_equal",
                        "Input should be greater than or equal to 1",
                        raw,
                    ));
                }
                if parsed > 1000 {
                    return Err(validation_error(
                        "limit",
                        "less_than_equal",
                        "Input should be less than or equal to 1000",
                        raw,
                    ));
                }
                parsed
            }
        };
        Ok((page, limit))
    }
}

/// `PublicBotListResponse` — the top-level JSON body.
#[derive(Debug, Serialize)]
struct PublicBotListResponse {
    total: i64,
    items: Vec<PublicBotItem>,
}

/// One `PublicBotResponse` item in the pydantic field declaration order.
#[derive(Debug, Serialize)]
struct PublicBotItem {
    id: i64,
    name: String,
    namespace: String,
    display_name: Option<String>,
    #[serde(rename = "json")]
    bot_json: OpaqueJson,
    is_active: bool,
    created_at: String,
    updated_at: String,
    ghost_name: Option<String>,
    shell_name: Option<String>,
    model_name: Option<String>,
    secondary_model_name: Option<String>,
    secondary_model_namespace: Option<String>,
    system_prompt: Option<String>,
    mcp_servers: Option<OpaqueJson>,
    skills: Option<OpaqueJson>,
    skill_refs: Option<BTreeMap<String, SkillRefMeta>>,
    preload_skills: Option<OpaqueJson>,
    preload_skill_refs: Option<BTreeMap<String, SkillRefMeta>>,
    default_knowledge_base_refs: Option<OpaqueJson>,
    agent_config: Option<OpaqueJson>,
}

/// `SkillRefMeta` (`app/schemas/kind.py`): `skill_id` required, the remaining
/// fields defaulted; unknown keys are dropped by the projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SkillRefMeta {
    skill_id: i64,
    #[serde(default = "default_namespace")]
    namespace: String,
    #[serde(default)]
    is_public: bool,
    #[serde(default)]
    content_hash: Option<String>,
}

fn default_namespace() -> String {
    "default".to_string()
}

/// Read projection of one Bot `kinds.json` document.
#[derive(Debug, Default, Deserialize)]
struct BotDocument {
    #[serde(default)]
    spec: BotSpec,
    #[serde(default)]
    metadata: BotMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct BotSpec {
    #[serde(default, rename = "ghostRef")]
    ghost_ref: JsonField<Reference>,
    #[serde(default, rename = "shellRef")]
    shell_ref: JsonField<Reference>,
    #[serde(default, rename = "modelRef")]
    model_ref: JsonField<Reference>,
    #[serde(default, rename = "secondaryModelRef")]
    secondary_model_ref: JsonField<Reference>,
}

#[derive(Debug, Default, Deserialize)]
struct Reference {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    namespace: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct BotMetadata {
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
}

/// Read projection of one Ghost `kinds.json` document.
#[derive(Debug, Default, Deserialize)]
struct GhostDocument {
    #[serde(default)]
    spec: GhostSpec,
}

#[derive(Debug, Default, Deserialize)]
struct GhostSpec {
    #[serde(default, rename = "systemPrompt")]
    system_prompt: JsonField<String>,
    #[serde(default, rename = "mcpServers")]
    mcp_servers: JsonField<OpaqueJson>,
    #[serde(default)]
    skills: JsonField<OpaqueJson>,
    #[serde(default, rename = "skill_refs")]
    skill_refs: JsonField<BTreeMap<String, SkillRefMeta>>,
    #[serde(default, rename = "preload_skills")]
    preload_skills: JsonField<OpaqueJson>,
    #[serde(default, rename = "preload_skill_refs")]
    preload_skill_refs: JsonField<BTreeMap<String, SkillRefMeta>>,
    #[serde(default, rename = "defaultKnowledgeBaseRefs")]
    default_knowledge_base_refs: JsonField<OpaqueJson>,
}

/// Read projection of one Model `kinds.json` document.
#[derive(Debug, Default, Deserialize)]
struct ModelDocument {
    #[serde(default)]
    spec: ModelSpec,
}

#[derive(Debug, Default, Deserialize)]
struct ModelSpec {
    #[serde(default, rename = "isCustomConfig")]
    is_custom_config: JsonField<bool>,
    #[serde(default, rename = "modelConfig")]
    model_config: JsonField<BTreeMap<String, OpaqueJson>>,
    #[serde(default)]
    protocol: JsonField<String>,
}

/// The `bind_model` reference rendered for a predefined model.
#[derive(Debug, Serialize)]
struct BindModel<'a> {
    bind_model: &'a str,
    bind_model_namespace: &'a str,
}

/// An empty JSON object, used for the source's `{}` ghost defaults.
#[derive(Debug, Serialize)]
struct EmptyObject;

/// GET /api/admin/public-bots: the admin public-bots free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/admin/public-bots")]
async fn list_public_bots(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
    query: brz_http_server::Query<PublicBotsQuery>,
) -> Result<PublicBotListResponse, FastApiError> {
    // `get_admin_user` runs after `get_current_user`; the checked session
    // principal already carries the `users` row `role`.
    if current_user.role != "admin" {
        return Err(FastApiError::forbidden(ADMIN_DETAIL));
    }
    public_bots(state, &query).await
}

/// Handler body for `GET /api/admin/public-bots`.
async fn public_bots(
    state: &AppState,
    query: &PublicBotsQuery,
) -> Result<PublicBotListResponse, FastApiError> {
    let (page, limit) = PublicBotsQuery {
        page: query.page.clone(),
        limit: query.limit.clone(),
    }
    .validated()?;

    let mysql = &state.mysql;
    let total: CountRow = mysql
        .fetch_one(count_sql(), ())
        .await
        .map_err(database_error)?;
    let offset = (page - 1).saturating_mul(limit);
    let bots: Vec<KindRow> = mysql
        .fetch_all(list_sql(offset, limit), ())
        .await
        .map_err(database_error)?;

    let mut items = Vec::with_capacity(bots.len());
    for bot in &bots {
        let document = bot.json.0.project::<BotDocument>().unwrap_or_default();

        let ghost_name = reference_name(&document.spec.ghost_ref);
        let shell_name = reference_name(&document.spec.shell_ref);
        let model_name = reference_name(&document.spec.model_ref);
        let secondary = document.spec.secondary_model_ref.value.as_ref();
        let secondary_model_name = secondary.and_then(|reference| reference.name.clone());
        let secondary_model_namespace = secondary.map(|reference| {
            reference
                .namespace
                .clone()
                .unwrap_or_else(default_namespace)
        });

        let ghost = match ghost_name.as_deref().filter(|name| !name.is_empty()) {
            Some(name) => {
                let namespace = reference_namespace(&document.spec.ghost_ref);
                mysql
                    .fetch_optional(ghost_sql(), (name, namespace.as_str()))
                    .await
                    .map_err(database_error)?
            }
            None => None,
        };
        let model = match model_name.as_deref().filter(|name| !name.is_empty()) {
            Some(name) => {
                let namespace = reference_namespace(&document.spec.model_ref);
                mysql
                    .fetch_optional(model_sql(), (name, namespace.as_str()))
                    .await
                    .map_err(database_error)?
            }
            None => None,
        };

        items.push(build_item(
            bot,
            ghost.as_ref(),
            model.as_ref(),
            BotRefs {
                ghost_name,
                shell_name,
                model_name,
                secondary_model_name,
                secondary_model_namespace,
            },
        ));
    }

    Ok(PublicBotListResponse {
        total: total.count,
        items,
    })
}

/// The reference names expanded in the response.
struct BotRefs {
    ghost_name: Option<String>,
    shell_name: Option<String>,
    model_name: Option<String>,
    secondary_model_name: Option<String>,
    secondary_model_namespace: Option<String>,
}

/// `_bot_to_response`: expand the referenced public Ghost/Model fields.
fn build_item(
    bot: &KindRow,
    ghost: Option<&KindRow>,
    model: Option<&KindRow>,
    refs: BotRefs,
) -> PublicBotItem {
    let expanded = ghost
        .and_then(|ghost| spec_projection::<GhostDocument>(&ghost.json.0))
        .map(|document| GhostExpansion::from_spec(&document.spec))
        .unwrap_or_default();

    let agent_config = model.and_then(|model| {
        spec_projection::<ModelDocument>(&model.json.0)
            .map(|document| model_agent_config(model, &document.spec))
    });

    PublicBotItem {
        id: bot.id,
        name: bot.name.clone(),
        namespace: bot.namespace.clone(),
        display_name: display_name(bot, &bot.json.0),
        bot_json: bot.json.0.clone(),
        is_active: bot.is_active != 0,
        created_at: pydantic_datetime(bot.created_at),
        updated_at: pydantic_datetime(bot.updated_at),
        ghost_name: refs.ghost_name,
        shell_name: refs.shell_name,
        model_name: refs.model_name,
        secondary_model_name: refs.secondary_model_name,
        secondary_model_namespace: refs.secondary_model_namespace,
        system_prompt: expanded.system_prompt,
        mcp_servers: expanded.mcp_servers,
        skills: expanded.skills,
        skill_refs: expanded.skill_refs,
        preload_skills: expanded.preload_skills,
        preload_skill_refs: expanded.preload_skill_refs,
        default_knowledge_base_refs: expanded.default_knowledge_base_refs,
        agent_config,
    }
}

/// The Ghost spec fields expanded into a `PublicBotResponse` item.
#[derive(Debug, Default)]
struct GhostExpansion {
    system_prompt: Option<String>,
    mcp_servers: Option<OpaqueJson>,
    skills: Option<OpaqueJson>,
    skill_refs: Option<BTreeMap<String, SkillRefMeta>>,
    preload_skills: Option<OpaqueJson>,
    preload_skill_refs: Option<BTreeMap<String, SkillRefMeta>>,
    default_knowledge_base_refs: Option<OpaqueJson>,
}

impl GhostExpansion {
    /// Read the expanded fields from a resolved Ghost `spec`.
    ///
    /// Absent keys fall back to the source defaults (`""`, `{}`, `[]`); an
    /// explicit JSON `null` stays `null`.
    fn from_spec(spec: &GhostSpec) -> Self {
        Self {
            system_prompt: string_field(&spec.system_prompt),
            mcp_servers: opaque_field(&spec.mcp_servers, empty_object()),
            skills: opaque_field(&spec.skills, empty_list()),
            skill_refs: map_field(&spec.skill_refs),
            preload_skills: opaque_field(&spec.preload_skills, empty_list()),
            preload_skill_refs: map_field(&spec.preload_skill_refs),
            default_knowledge_base_refs: opaque_field(
                &spec.default_knowledge_base_refs,
                empty_list(),
            ),
        }
    }
}

/// `spec.get(key, "")` for a `Optional[str]` field.
fn string_field(field: &JsonField<String>) -> Option<String> {
    if field.present {
        field.value.clone()
    } else {
        Some(String::new())
    }
}

/// `spec.get(key, default)` for an opaque field: absent becomes the default,
/// a present JSON `null` stays `None` (rendered as `null`).
fn opaque_field(field: &JsonField<OpaqueJson>, default: OpaqueJson) -> Option<OpaqueJson> {
    if !field.present {
        return Some(default);
    }
    match &field.value {
        Some(value) if !value.is_null() => Some(value.clone()),
        _ => None,
    }
}

/// `spec.get(key, {})` validated into `Dict[str, SkillRefMeta]`.
fn map_field(
    field: &JsonField<BTreeMap<String, SkillRefMeta>>,
) -> Option<BTreeMap<String, SkillRefMeta>> {
    if field.present {
        field.value.clone()
    } else {
        Some(BTreeMap::new())
    }
}

/// `_bot_to_response`'s Model branch: a predefined model renders the
/// `bind_model` reference, a custom model renders its `modelConfig` (plus the
/// `protocol` when present).
fn model_agent_config(model: &KindRow, spec: &ModelSpec) -> OpaqueJson {
    if spec.is_custom_config.value != Some(true) {
        return OpaqueJson::from_serializable(BindModel {
            bind_model: &model.name,
            bind_model_namespace: &model.namespace,
        });
    }

    let mut config = spec.model_config.value.clone().unwrap_or_default();
    if let Some(protocol) = spec
        .protocol
        .value
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        config.insert(
            "protocol".to_string(),
            OpaqueJson::from_serializable(protocol),
        );
    }
    OpaqueJson::from_serializable(config)
}

fn empty_object() -> OpaqueJson {
    OpaqueJson::from_serializable(EmptyObject)
}

fn empty_list() -> OpaqueJson {
    OpaqueJson::from_serializable(Vec::<EmptyObject>::new())
}

/// `_get_bot_display_name`: `metadata.displayName` when truthy and different
/// from the bot name.
fn display_name(bot: &KindRow, json: &OpaqueJson) -> Option<String> {
    let metadata = json.project::<BotDocument>()?.metadata;
    let name = metadata.display_name?;
    (!name.is_empty() && name != bot.name).then_some(name)
}

/// `_get_bot_ref_info`: the referenced name when the ref is an object.
fn reference_name(field: &JsonField<Reference>) -> Option<String> {
    field
        .value
        .as_ref()
        .and_then(|reference| reference.name.clone())
}

/// `spec.<key>.namespace` with the source's `"default"` fallback.
fn reference_namespace(field: &JsonField<Reference>) -> String {
    field
        .value
        .as_ref()
        .and_then(|reference| reference.namespace.clone())
        .unwrap_or_else(default_namespace)
}

/// `if value and isinstance(value, dict): spec = value.get("spec", {})` plus
/// `isinstance(spec, dict)`.
///
/// `None` when the row JSON is not a non-empty object (the source's truthiness
/// guard); otherwise the parsed document, whose `spec` defaults to an empty
/// spec so the field defaults apply.
fn spec_projection<T>(json: &OpaqueJson) -> Option<T>
where
    T: serde::de::DeserializeOwned,
{
    if !json.is_nonempty_object() {
        return None;
    }
    json.project::<T>()
}

/// Pydantic renders a naive `datetime` via `isoformat()`: seconds precision,
/// microseconds only when non-zero.
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_micros() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

/// The application's `python_exception_handler` 500 body for an unexpected
/// dependency failure.
fn database_error(error: MysqlError) -> FastApiError {
    tracing::error!(%error, "admin public-bots database dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
#[path = "admin_public_bots_tests.rs"]
mod tests;
