// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/templates` — the administrator template listing.
//!
//! Port of `app.api.endpoints.admin.templates.list_templates`
//! (`app/api/endpoints/admin/templates.py`) with
//! `app.services.template_service.TemplateService.list_templates` and its
//! `_to_response` helper. The admin router is mounted under `/admin`
//! (`app/api/api.py`), so the public path is `/api/admin/templates`.
//!
//! Flow: the session user must be an admin (`app.core.security.get_admin_user`,
//! `403 {"detail": ...}` for a non-admin role); the optional `category` query
//! parameter is a plain string. The service loads every `kinds` row with
//! `kind = 'Template' AND is_active = true` ordered by `created_at` descending,
//! filters by the stored `spec.category` in Python when a category is given,
//! and renders each row as a `TemplateResponse` wrapped in a
//! `TemplateListResponse` (`app/schemas/template.py`).
//!
//! Recorded source evidence (`api-admin-templates/0eae8f65`): the authenticated
//! `users` lookup by user name, the `kinds` template scan, then two `ROLLBACK`
//! session cleanups at request end.
//!
//! `_to_response` reads `kind.json.spec` and re-serializes it through the
//! `TemplateResources` pydantic models, which apply their field defaults
//! (`queue` is always emitted) and drop unknown members, so the response is
//! projected through typed structs rather than echoing the stored document.

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::json_compat::{JsonField, OpaqueJson};
use crate::state::AppState;

/// `template_service.TEMPLATE_KIND`.
const TEMPLATE_KIND: &str = "Template";
/// `get_admin_user`'s `403` detail for a non-admin session user.
const ADMIN_REQUIRED: &str = "Permission denied. Admin access required.";
/// `TemplateResponse.category` default `_to_response` applies when the stored
/// `spec.category` is absent.
const DEFAULT_CATEGORY: &str = "inbox";
/// `TemplateResourceSubscriptionConfig` bounds (`app/schemas/subscription.py`).
const RETRY_COUNT_MAX: i64 = 3;
const TIMEOUT_SECONDS_MIN: i64 = 60;
const TIMEOUT_SECONDS_MAX: i64 = 24 * 60 * 60;

/// `kinds` columns as rendered by `db.query(Kind)` (SQLAlchemy labels every
/// column `kinds_<name>`).
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS \
     kinds_created_at, kinds.updated_at AS kinds_updated_at";

/// One `kinds` row of the template scan. Only the members the response reads
/// are declared; the remaining selected columns stay in the statement so the
/// rendered SQL matches the recorded exchange.
#[derive(Debug, FromMysqlRow)]
struct KindRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_json")]
    json: Json<OpaqueJson>,
    #[mysql(rename = "kinds_created_at")]
    created_at: NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    updated_at: NaiveDateTime,
}

/// `TemplateListResponse`.
#[derive(Debug, Serialize)]
struct TemplateListResponse {
    total: usize,
    items: Vec<TemplateItem>,
}

/// `TemplateResponse` (`app/schemas/template.py`). Pydantic keeps every member
/// present, so nullable members serialize as JSON null.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TemplateItem {
    id: i64,
    name: String,
    display_name: String,
    description: Option<String>,
    category: String,
    tags: Vec<String>,
    icon: Option<String>,
    resources: TemplateResources,
    created_at: String,
    updated_at: String,
}

/// `TemplateResources`. Field order matches the pydantic model, so the
/// serialized member order is `ghost, bot, team, subscription, queue` and the
/// always-present `queue` keeps its default value.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct TemplateResources {
    ghost: Option<GhostConfig>,
    bot: Option<BotConfig>,
    team: Option<TeamConfig>,
    subscription: Option<SubscriptionConfig>,
    queue: QueueConfig,
}

/// `TemplateResourceGhostConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct GhostConfig {
    #[serde(rename = "systemPrompt")]
    system_prompt: String,
    #[serde(default, rename = "mcpServers")]
    mcp_servers: Option<OpaqueJson>,
    #[serde(default, rename = "skillRefs")]
    skill_refs: Option<Vec<SkillRef>>,
    #[serde(default, rename = "preloadSkillRefs")]
    preload_skill_refs: Option<Vec<SkillRef>>,
}

/// `TemplateResourceSkillRef`. `user_id` keeps its snake_case JSON name.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SkillRef {
    name: String,
    #[serde(default = "default_namespace")]
    namespace: String,
    #[serde(rename = "user_id")]
    user_id: i64,
}

/// `TemplateResourceBotConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BotConfig {
    #[serde(default = "default_shell_name", rename = "shellName")]
    shell_name: String,
    #[serde(default, rename = "agentConfig")]
    agent_config: Option<OpaqueJson>,
}

/// `TemplateResourceTeamConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TeamConfig {
    #[serde(default = "default_collaboration_model", rename = "collaborationModel")]
    collaboration_model: String,
    #[serde(default, rename = "bindMode")]
    bind_mode: Option<Vec<String>>,
    #[serde(default)]
    description: Option<String>,
}

/// `TemplateResourceSubscriptionConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SubscriptionConfig {
    #[serde(rename = "promptTemplate")]
    prompt_template: String,
    #[serde(default = "default_retry_count", rename = "retryCount")]
    retry_count: i64,
    #[serde(default = "default_timeout_seconds", rename = "timeoutSeconds")]
    timeout_seconds: i64,
}

/// `TemplateResourceQueueConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct QueueConfig {
    visibility: String,
    #[serde(rename = "triggerMode")]
    trigger_mode: String,
    #[serde(rename = "teamRef")]
    team_ref: Option<TeamRef>,
}

impl Default for QueueConfig {
    fn default() -> Self {
        Self {
            visibility: "private".to_owned(),
            trigger_mode: "immediate".to_owned(),
            team_ref: None,
        }
    }
}

/// `TemplateResourceTeamRef`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TeamRef {
    name: String,
    #[serde(default = "default_namespace")]
    namespace: String,
}

/// The stored `kinds.json` document. `_to_response` reads only `spec`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct KindDocument {
    spec: JsonField<KindSpec>,
}

/// The `spec` members `_to_response` reads. `JsonField` keeps the distinction
/// between an absent member (which takes the response default) and a present
/// member, so a present value of the wrong shape is reported the way pydantic
/// rejects it.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct KindSpec {
    #[serde(rename = "displayName")]
    display_name: JsonField<String>,
    description: Option<String>,
    category: JsonField<String>,
    tags: JsonField<Vec<String>>,
    icon: Option<String>,
    resources: JsonField<TemplateResources>,
}

/// GET /api/admin/templates: the template list as a free function injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/admin/templates")]
async fn list_templates(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
    category: Option<String>,
) -> Result<TemplateListResponse, FastApiError> {
    // `get_admin_user` runs as a dependency before the endpoint body.
    if current_user.role != "admin" {
        return Err(FastApiError::forbidden(ADMIN_REQUIRED));
    }
    let rows = fetch_templates(&state.mysql).await.map_err(internal)?;
    // `if category:` — an empty string is falsy and skips the filter.
    let filter = category.as_deref().filter(|value| !value.is_empty());

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let prepared = prepare(row)?;
        if let Some(category) = filter
            && prepared.spec.category.value.as_deref() != Some(category)
        {
            continue;
        }
        items.push(to_response(&prepared.row, &prepared.spec)?);
    }
    Ok(TemplateListResponse {
        total: items.len(),
        items,
    })
}

/// `db.query(Kind).filter(kind == "Template", is_active == True)
/// .order_by(Kind.created_at.desc()).all()`.
async fn fetch_templates<M: Mysql>(mysql: &M) -> MysqlResult<Vec<KindRow>> {
    mysql.fetch_all(templates_sql(), ()).await
}

/// The template-scan statement the source session renders.
fn templates_sql() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = '{TEMPLATE_KIND}' \
         AND kinds.is_active = true ORDER BY kinds.created_at DESC"
    )
}

/// A row paired with its parsed `kinds.json` document.
#[derive(Debug)]
struct Prepared {
    row: KindRow,
    spec: KindSpec,
}

/// Parse `kind.json` and its `spec` member. A non-object document, a present
/// `spec` that is not a mapping, or a `spec` member of an unexpected shape is
/// the source's unhandled error (`_to_response` would raise).
fn prepare(row: KindRow) -> Result<Prepared, FastApiError> {
    let document: Option<KindDocument> = row.json.0.project();
    let document = document.ok_or_else(unhandled)?;
    let spec = match (document.spec.present, document.spec.value) {
        (false, _) => KindSpec::default(),
        (true, None) => return Err(unhandled()),
        (true, Some(spec)) => spec,
    };
    Ok(Prepared { row, spec })
}

/// `_to_response`: project one row and its parsed spec into the response item.
fn to_response(row: &KindRow, spec: &KindSpec) -> Result<TemplateItem, FastApiError> {
    // `spec.get("displayName", kind.name)` — absent an explicit value the
    // response falls back to the stored template name.
    let display_name = if spec.display_name.present {
        spec.display_name.value.clone().ok_or_else(unhandled)?
    } else {
        row.name.clone()
    };
    let category = if spec.category.present {
        spec.category.value.clone().ok_or_else(unhandled)?
    } else {
        DEFAULT_CATEGORY.to_owned()
    };
    let tags = if spec.tags.present {
        spec.tags.value.clone().ok_or_else(unhandled)?
    } else {
        Vec::new()
    };
    let resources = if spec.resources.present {
        spec.resources.value.clone().ok_or_else(unhandled)?
    } else {
        TemplateResources::default()
    };
    validate_subscription(&resources)?;

    Ok(TemplateItem {
        id: row.id,
        name: row.name.clone(),
        display_name,
        description: spec.description.clone(),
        category,
        tags,
        icon: spec.icon.clone(),
        resources,
        created_at: pydantic_datetime(row.created_at),
        updated_at: pydantic_datetime(row.updated_at),
    })
}

/// The pydantic `Field(ge=..., le=...)` bounds on the subscription config.
fn validate_subscription(resources: &TemplateResources) -> Result<(), FastApiError> {
    let Some(subscription) = &resources.subscription else {
        return Ok(());
    };
    if !(0..=RETRY_COUNT_MAX).contains(&subscription.retry_count)
        || !(TIMEOUT_SECONDS_MIN..=TIMEOUT_SECONDS_MAX).contains(&subscription.timeout_seconds)
    {
        return Err(unhandled());
    }
    Ok(())
}

fn default_namespace() -> String {
    "default".to_owned()
}

fn default_shell_name() -> String {
    "Chat".to_owned()
}

fn default_collaboration_model() -> String {
    "pipeline".to_owned()
}

fn default_retry_count() -> i64 {
    1
}

fn default_timeout_seconds() -> i64 {
    600
}

/// Pydantic v2 naive `datetime` serialization: `YYYY-MM-DDTHH:MM:SS`
/// (six-digit microseconds appended only when non-zero).
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        format!(
            "{}.{:06}",
            value.format("%Y-%m-%dT%H:%M:%S"),
            value.and_utc().timestamp_subsec_micros()
        )
    }
}

/// Dependent-query failure mapped to the source `python_exception_handler`
/// body (`{"error_code": 500, "detail": "Internal server error"}`).
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "admin template list database dependency failure");
    unhandled()
}

/// The application's `python_exception_handler` body for an unmapped failure.
fn unhandled() -> FastApiError {
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_compat::OpaqueJson;
    use chrono::NaiveDate;

    fn row(json: &str) -> KindRow {
        KindRow {
            id: 1,
            name: "template-name".to_owned(),
            json: Json(OpaqueJson::from_json_text(json).unwrap()),
            created_at: NaiveDate::from_ymd_opt(2026, 4, 22)
                .unwrap()
                .and_hms_opt(22, 19, 21)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 4, 21)
                .unwrap()
                .and_hms_opt(17, 20, 33)
                .unwrap(),
        }
    }

    fn item(json: &str) -> TemplateItem {
        let row = row(json);
        let prepared = prepare(row).unwrap();
        to_response(&prepared.row, &prepared.spec).unwrap()
    }

    #[test]
    fn response_matches_the_recorded_projection() {
        let document = r#"{
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Template",
            "metadata": {"name": "wiki-inbox", "namespace": "system"},
            "spec": {
                "displayName": "我的个人知识库",
                "description": "将收到的内容通过AI自动整理和维护到我的个人知识库",
                "category": "inbox",
                "tags": ["wiki", "knowledge"],
                "icon": "📚",
                "resources": {
                    "ghost": {
                        "systemPrompt": "prompt",
                        "mcpServers": null,
                        "skillRefs": [
                            {"name": "wegent-knowledge", "user_id": 0, "namespace": "default"}
                        ],
                        "preloadSkillRefs": [{"name": "wegent-knowledge", "user_id": 0}]
                    },
                    "bot": {
                        "shellName": "Chat",
                        "agentConfig": {"bind_model": "m", "bind_model_type": "public"}
                    },
                    "team": {"collaborationModel": "solo", "bindMode": null, "description": "d"},
                    "subscription": {"promptTemplate": "p", "retryCount": 1, "timeoutSeconds": 600},
                    "queue": {"teamRef": null, "visibility": "private", "triggerMode": "immediate"}
                }
            },
            "status": {"state": "Available"}
        }"#;
        let value = serde_json::to_value(item(document)).unwrap();
        assert_eq!(value["displayName"], "我的个人知识库");
        assert_eq!(value["category"], "inbox");
        assert_eq!(value["tags"], serde_json::json!(["wiki", "knowledge"]));
        assert_eq!(value["icon"], "📚");
        assert_eq!(value["createdAt"], "2026-04-22T22:19:21");
        assert_eq!(value["updatedAt"], "2026-04-21T17:20:33");
        let resources = &value["resources"];
        assert_eq!(resources["ghost"]["mcpServers"], serde_json::Value::Null);
        assert_eq!(
            resources["ghost"]["skillRefs"][0],
            serde_json::json!({"name": "wegent-knowledge", "namespace": "default", "user_id": 0})
        );
        assert_eq!(resources["bot"]["shellName"], "Chat");
        assert_eq!(resources["team"]["collaborationModel"], "solo");
        assert_eq!(resources["subscription"]["retryCount"], 1);
        assert_eq!(resources["queue"]["visibility"], "private");
        assert_eq!(resources["queue"]["triggerMode"], "immediate");
        assert_eq!(resources["queue"]["teamRef"], serde_json::Value::Null);
        // `queue` is always emitted through the pydantic default factory.
        assert!(resources.get("queue").is_some());
    }

    #[test]
    fn missing_resources_defaults_the_queue_only() {
        let document = r#"{"spec": {"displayName": "d", "category": "inbox"}}"#;
        let value = serde_json::to_value(item(document)).unwrap();
        let resources = &value["resources"];
        assert_eq!(resources["ghost"], serde_json::Value::Null);
        assert_eq!(resources["bot"], serde_json::Value::Null);
        assert_eq!(resources["team"], serde_json::Value::Null);
        assert_eq!(resources["subscription"], serde_json::Value::Null);
        assert_eq!(
            resources["queue"],
            serde_json::json!({
                "visibility": "private",
                "triggerMode": "immediate",
                "teamRef": serde_json::Value::Null
            })
        );
    }

    #[test]
    fn absent_category_and_tags_use_their_defaults() {
        let document = r#"{"spec": {"displayName": "d"}}"#;
        let value = serde_json::to_value(item(document)).unwrap();
        assert_eq!(value["category"], "inbox");
        assert_eq!(value["tags"], serde_json::json!([]));
        assert_eq!(value["displayName"], "d");
    }

    #[test]
    fn absent_display_name_falls_back_to_the_record_name() {
        let document = r#"{"spec": {}}"#;
        let value = serde_json::to_value(item(document)).unwrap();
        assert_eq!(value["displayName"], "template-name");
    }

    #[test]
    fn unknown_members_are_dropped_like_pydantic() {
        let document = r#"{"spec": {
            "displayName": "d",
            "unknownTop": 1,
            "resources": {"queue": {"extra": true}, "ghost": {"systemPrompt": "p", "extra": 2}}
        }}"#;
        let value = serde_json::to_value(item(document)).unwrap();
        assert!(value["resources"]["queue"].get("extra").is_none());
        assert!(value["resources"]["ghost"].get("extra").is_none());
        assert_eq!(value["resources"]["ghost"]["systemPrompt"], "p");
        assert!(value["spec"].is_null());
    }

    #[test]
    fn a_present_spec_of_the_wrong_shape_is_an_unhandled_error() {
        let row = row(r#"{"spec": "not-a-mapping"}"#);
        let error = prepare(row).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn out_of_range_subscription_bounds_are_unhandled() {
        let document = r#"{"spec": {"resources": {"subscription": {
            "promptTemplate": "p", "retryCount": 9
        }}}}"#;
        let row = row(document);
        let prepared = prepare(row).unwrap();
        let error = to_response(&prepared.row, &prepared.spec).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn recorded_template_scan_matches_the_source_statement() {
        assert_eq!(
            templates_sql(),
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, kinds.kind AS \
             kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
             kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS \
             kinds_created_at, kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE \
             kinds.kind = 'Template' AND kinds.is_active = true ORDER BY kinds.created_at DESC"
        );
    }
}
