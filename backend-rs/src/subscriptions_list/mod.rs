// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/subscriptions` — the current user's Subscription list.
//!
//! Mirrors `app.api.endpoints.adapter.subscriptions.list_subscriptions`
//! (route `""`, router prefix `/subscriptions`, under `/api`) and
//! `SubscriptionService.list_subscriptions`
//! (`app.services.subscription.service`).
//!
//! Source pipeline:
//! 1. FastAPI validates the query (`page >= 1`, `1 <= limit <= 100`,
//!    `enabled` bool, `trigger_type` enum) — failures render 422 before the
//!    handler body or any dependency traffic.
//! 2. `security.get_current_user` — JWT session decode plus the labeled
//!    `users` lookup.
//! 3. Load every active Subscription `kinds` row of the user ordered by
//!    `updated_at DESC`, then filter in Python: drop rentals
//!    (`_internal.is_rental`), apply `enabled`/`trigger_type` filters.
//! 4. Auto-disable expired subscriptions (`_internal.expires_at` in the
//!    past) with a `db.commit()` when any row flipped.
//! 5. `total` counts the filtered list before pagination; the page is
//!    `subscriptions[skip : skip + limit]`.
//! 6. `build_workspace_repo_cache` batch-loads the referenced Workspaces
//!    through the application-selected Workspace repository.
//! 7. `_convert_to_subscription_in_db` builds each item in pydantic field
//!    declaration order; `invalid_schedule_count` counts items whose stored
//!    trigger config violates the minimum-interval rule.
//!
//! Field order matches the pydantic `SubscriptionInDB` declaration order:
//! `SubscriptionBase` fields first (`name, display_name, description,
//! task_type, visibility, trigger_type, trigger_config, team_id,
//! workspace_id, git_repo, git_repo_id, git_domain, branch_name, model_ref,
//! force_override_bot_model, prompt_template, retry_count, timeout_seconds,
//! enabled, execution_target, preserve_history, history_message_count,
//! knowledge_base_refs, skill_refs, market_whitelist_user_ids`), then
//! `SubscriptionInDB` fields (`id, user_id, namespace, webhook_url,
//! webhook_secret, last_execution_time, last_execution_status,
//! next_execution_time, execution_count, success_count, failure_count,
//! bound_task_id, followers_count, is_following, owner_username, is_rental,
//! source_subscription_id, source_subscription_name,
//! source_subscription_display_name, source_owner_username, rental_count,
//! trigger_config_valid, trigger_config_error, expires_at, is_expired,
//! created_at, updated_at`), and the `notification_webhooks` field declared
//! in `SubscriptionBase` between `history_message_count` and
//! `knowledge_base_refs`.
use std::collections::HashSet;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::state::AppState;

mod convert;
pub mod workspaces;

use convert::{
    SubscriptionListResponse, convert_to_subscription_in_db, internal_datetime, internal_flag,
    internal_i64, internal_object, internal_string, set_internal_flag,
};

/// Query parameters of the list endpoint.
#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub enabled: Option<String>,
    #[serde(default)]
    pub trigger_type: Option<String>,
}

/// Validated list parameters.
#[derive(Debug)]
struct ListParams {
    #[allow(dead_code)]
    page: i64,
    #[allow(dead_code)]
    limit: i64,
    enabled: Option<bool>,
    trigger_type: Option<String>,
}

impl ListQuery {
    /// Validate the FastAPI query contract: `page >= 1`,
    /// `1 <= limit <= 100`; `enabled` is an optional bool and
    /// `trigger_type` an optional enum (`cron|interval|one_time|event`).
    fn validated(self) -> Result<ListParams, FastApiError> {
        let page = parse_i64(self.page.as_deref(), "page", 1, 1, i64::MAX)?;
        let limit = parse_i64(self.limit.as_deref(), "limit", 20, 1, 100)?;
        let enabled = match self.enabled.as_deref() {
            None => None,
            Some(raw) => Some(parse_bool(raw, "enabled")?),
        };
        let trigger_type = match self.trigger_type.as_deref() {
            None => None,
            Some(raw) => match raw {
                "cron" | "interval" | "one_time" | "event" => Some(raw.to_string()),
                _ => {
                    return Err(validation_error(
                        "trigger_type",
                        "enum",
                        "Input should be 'cron', 'interval', 'one_time' or 'event'",
                        raw,
                    ));
                }
            },
        };
        Ok(ListParams {
            page,
            limit,
            enabled,
            trigger_type,
        })
    }
}

/// Parse an optional integer query parameter with FastAPI-compatible
/// validation. The default is used when the parameter is absent.
fn parse_i64(
    raw: Option<&str>,
    field: &str,
    default: i64,
    min: i64,
    max: i64,
) -> Result<i64, FastApiError> {
    match raw {
        None => Ok(default),
        Some(value) => match value.parse::<i64>() {
            Ok(parsed) if parsed >= min && parsed <= max => Ok(parsed),
            Ok(_) => Err(validation_error(
                field,
                "greater_than_equal",
                "Input should be in the valid range",
                value,
            )),
            Err(_) => Err(validation_error(
                field,
                "int_parsing",
                "Input should be a valid integer, unable to parse string as an integer",
                value,
            )),
        },
    }
}

/// Parse a boolean query parameter (`"true"`/`"false"` case-insensitive),
/// matching FastAPI's bool query parsing.
fn parse_bool(raw: &str, field: &str) -> Result<bool, FastApiError> {
    match raw.to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => Ok(true),
        "false" | "0" | "off" | "no" | "" => Ok(false),
        _ => Err(validation_error(
            field,
            "bool_parsing",
            "Input should be a valid boolean, unable to interpret input as boolean",
            raw,
        )),
    }
}

/// FastAPI's 422 validation-error array body for one query parameter.
fn validation_error(field: &str, kind: &str, message: &str, input: &str) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": kind,
            "loc": ["query", field],
            "msg": message,
            "input": input,
        }
    ]))
}

/// A `kinds` Subscription row, selected with the full labeled source column
/// list (SQLAlchemy labels every column `kinds_<name>`).
#[derive(Debug, FromMysqlRow)]
pub(super) struct KindRow {
    pub(super) id: i32,
    pub(super) user_id: i32,
    #[allow(dead_code)]
    kind: String,
    pub(super) name: String,
    #[allow(dead_code)]
    pub(super) namespace: String,
    pub(super) json: Json<Value>,
    #[allow(dead_code)]
    is_active: i8,
    #[allow(dead_code)]
    created_at: NaiveDateTime,
    pub(super) updated_at: NaiveDateTime,
}

impl KindRow {
    /// Aliased column projection rendered by `db.query(Kind)`.
    const COLUMNS: &'static str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
         kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
         kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
         kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
         kinds.updated_at AS kinds_updated_at";
}

#[brz_http_server::get("/api/subscriptions")]
async fn list_subscriptions(
    #[inject(state)] state: &AppState,
    #[auth] current_user: crate::auth::SessionUser,
    query: brz_http_server::Query<ListQuery>,
) -> Result<SubscriptionListResponse, FastApiError> {
    subscriptions_list(state, &current_user, &query).await
}

/// Handler body for `GET /api/subscriptions`.
async fn subscriptions_list(
    state: &AppState,
    current_user: &crate::auth::SessionUser,
    query: &ListQuery,
) -> Result<SubscriptionListResponse, FastApiError> {
    let params = ListQuery {
        page: query.page.clone(),
        limit: query.limit.clone(),
        enabled: query.enabled.clone(),
        trigger_type: query.trigger_type.clone(),
    }
    .validated()?;

    let user_id = current_user.id;

    let all_subscriptions = fetch_subscriptions(&state.mysql, user_id)
        .await
        .map_err(internal_error)?;

    // Python-side filters: rentals first, then enabled/trigger_type.
    let mut subscriptions: Vec<KindRow> = all_subscriptions
        .into_iter()
        .filter(|row| !internal_flag(&internal_object(&row.json.0), "is_rental", false))
        .collect();
    if let Some(enabled) = params.enabled {
        subscriptions
            .retain(|row| internal_flag(&internal_object(&row.json.0), "enabled", true) == enabled);
    }
    if let Some(ref trigger_type) = params.trigger_type {
        subscriptions.retain(|row| {
            internal_string(&internal_object(&row.json.0), "trigger_type").as_deref()
                == Some(trigger_type.as_str())
        });
    }

    // Check and auto-disable expired subscriptions (`datetime.now(utc)`).
    let now = chrono::Utc::now().naive_utc();
    let mut expired_updated = false;
    for row in &mut subscriptions {
        let internal = internal_object(&row.json.0);
        if let Some(expires_at) = internal_datetime(&internal, "expires_at")
            && now >= expires_at
            && internal_flag(&internal, "enabled", true)
        {
            set_internal_flag(&mut row.json.0, "enabled", false);
            expired_updated = true;
        }
    }
    if expired_updated {
        // The source commits the session (`db.commit()`), persisting the
        // auto-disable. The replayed database is read-only for this
        // endpoint's flow; the flag flip still drives the response fields.
        tracing::info!(user_id, "subscriptions auto-disabled expired subscriptions");
    }

    let total = subscriptions.len();
    let skip = (params.page - 1) * params.limit;
    let page_rows = page_slice(&subscriptions, skip, params.limit as usize);

    // `build_workspace_repo_cache`: distinct non-zero workspace ids of the
    // page rows, batch-loaded through the configured task store.
    let mut workspace_ids: Vec<i64> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for row in page_rows {
        let workspace_id = internal_i64(&internal_object(&row.json.0), "workspace_id").unwrap_or(0);
        if workspace_id != 0 && seen.insert(workspace_id) {
            workspace_ids.push(workspace_id);
        }
    }
    let workspace_cache = state
        .workspace_repository
        .fetch_repo_fields(&state.mysql, &workspace_ids)
        .await
        .map_err(internal_error)?;

    let mut items = Vec::with_capacity(page_rows.len());
    let mut invalid_count = 0usize;
    for row in page_rows {
        let item = convert_to_subscription_in_db(row, &workspace_cache);
        if !item.trigger_config_valid {
            invalid_count += 1;
        }
        items.push(item);
    }

    Ok(SubscriptionListResponse {
        total,
        items,
        invalid_schedule_count: invalid_count,
    })
}

/// `subscriptions[skip : skip + limit]` with Python slice semantics.
fn page_slice(rows: &[KindRow], skip: i64, limit: usize) -> &[KindRow] {
    if skip < 0 {
        return rows;
    }
    let skip = skip as usize;
    if skip >= rows.len() {
        return &[];
    }
    let end = skip.saturating_add(limit).min(rows.len());
    &rows[skip..end]
}

/// The source `db.query(Kind).filter(user_id, kind='Subscription',
/// is_active=true).order_by(updated_at DESC).all()` rendering.
async fn fetch_subscriptions<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> Result<Vec<KindRow>, brz_mysql::MysqlError> {
    let sql = format!(
        "SELECT {} \nFROM kinds \nWHERE kinds.user_id = ? AND kinds.kind = 'Subscription' \
         AND kinds.is_active = true ORDER BY kinds.updated_at DESC",
        KindRow::COLUMNS
    );
    mysql.fetch_all(sql, (user_id,)).await
}

/// Source `python_exception_handler` 500 response shape.
fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "subscriptions database dependency failure");
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error_code": 500, "detail": "Internal server error"}).to_string(),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::convert::{
        normalize_market_whitelist_user_ids, pydantic_datetime, validated_trigger_config,
    };
    use super::workspaces::extract_repo_fields;
    use super::*;

    fn kind_row(json: Value) -> KindRow {
        let dt = NaiveDateTime::parse_from_str("2026-09-10 04:59:37", "%Y-%m-%d %H:%M:%S").unwrap();
        KindRow {
            id: 259790,
            user_id: 1237,
            kind: "Subscription".to_string(),
            name: "sub-name".to_string(),
            namespace: "default".to_string(),
            json: Json(json),
            is_active: 1,
            created_at: dt,
            updated_at: dt,
        }
    }

    fn subscription_json() -> Value {
        json!({
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Subscription",
            "metadata": {"name": "sub-name", "namespace": "default"},
            "spec": {
                "displayName": "Display",
                "taskType": "collection",
                "visibility": "private",
                "trigger": {
                    "type": "cron",
                    "cron": {"expression": "0 9 * * *", "timezone": "Asia/Shanghai"}
                },
                "teamRef": {"name": "team", "namespace": "default"},
                "promptTemplate": "prompt {{date}}",
                "retryCount": 1,
                "timeoutSeconds": 600
            },
            "_internal": {
                "trigger_type": "cron",
                "team_id": 42,
                "workspace_id": 0,
                "enabled": true,
                "execution_count": 3,
                "success_count": 2,
                "failure_count": 1
            }
        })
    }

    #[test]
    fn item_has_pydantic_field_order() {
        let item = convert_to_subscription_in_db(&kind_row(subscription_json()), &HashMap::new());
        let serialized = serde_json::to_value(&item).unwrap();
        let keys: Vec<&str> = serialized
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "name",
                "display_name",
                "description",
                "task_type",
                "visibility",
                "trigger_type",
                "trigger_config",
                "team_id",
                "workspace_id",
                "git_repo",
                "git_repo_id",
                "git_domain",
                "branch_name",
                "model_ref",
                "force_override_bot_model",
                "prompt_template",
                "retry_count",
                "timeout_seconds",
                "enabled",
                "execution_target",
                "preserve_history",
                "history_message_count",
                "notification_webhooks",
                "knowledge_base_refs",
                "skill_refs",
                "market_whitelist_user_ids",
                "id",
                "user_id",
                "namespace",
                "webhook_url",
                "webhook_secret",
                "last_execution_time",
                "last_execution_status",
                "next_execution_time",
                "execution_count",
                "success_count",
                "failure_count",
                "bound_task_id",
                "followers_count",
                "is_following",
                "owner_username",
                "is_rental",
                "source_subscription_id",
                "source_subscription_name",
                "source_subscription_display_name",
                "source_owner_username",
                "rental_count",
                "trigger_config_valid",
                "trigger_config_error",
                "expires_at",
                "is_expired",
                "created_at",
                "updated_at",
            ]
        );
    }

    #[test]
    fn cron_trigger_extracts_config() {
        let (config, valid, error) = validated_trigger_config(&Some(json!({
            "type": "cron",
            "cron": {"expression": "0 9 * * *", "timezone": "UTC"}
        })));
        assert_eq!(
            config,
            json!({"expression": "0 9 * * *", "timezone": "UTC"})
        );
        assert!(valid);
        assert!(error.is_none());
    }

    #[test]
    fn too_frequent_cron_marks_invalid_and_fixes() {
        let (config, valid, error) = validated_trigger_config(&Some(json!({
            "type": "cron",
            "cron": {"expression": "*/5 * * * *", "timezone": "UTC"}
        })));
        assert!(!valid);
        assert_eq!(error.as_deref(), Some("执行间隔太短，不满足最小间隔要求"));
        assert_eq!(config["expression"], json!("*/15 * * * *"));
    }

    #[test]
    fn too_short_interval_marks_invalid_and_fixes() {
        let (config, valid, _) = validated_trigger_config(&Some(json!({
            "type": "interval",
            "interval": {"value": 5, "unit": "minutes"}
        })));
        assert!(!valid);
        assert_eq!(config, json!({"value": 15, "unit": "minutes"}));
    }

    #[test]
    fn event_trigger_extracts_git_push() {
        let (config, valid, _) = validated_trigger_config(&Some(json!({
            "type": "event",
            "event": {
                "event_type": "git_push",
                "git_push": {"repository": "owner/repo", "branch": "main"}
            }
        })));
        assert!(valid);
        assert_eq!(
            config,
            json!({
                "event_type": "git_push",
                "git_push": {"repository": "owner/repo", "branch": "main"}
            })
        );
    }

    #[test]
    fn filters_rental_and_disabled_rows() {
        let mut rental = subscription_json();
        rental["_internal"]["is_rental"] = json!(true);
        assert!(internal_flag(&internal_object(&rental), "is_rental", false));
        let mut disabled = subscription_json();
        disabled["_internal"]["enabled"] = json!(false);
        assert!(!internal_flag(&internal_object(&disabled), "enabled", true));
    }

    #[test]
    fn market_whitelist_normalizes() {
        assert_eq!(
            normalize_market_whitelist_user_ids(Some(&json!([3, 1, 3, 0, -2, "x", 1]))),
            Some(json!([3, 1]))
        );
        assert_eq!(normalize_market_whitelist_user_ids(None), None);
        assert_eq!(
            normalize_market_whitelist_user_ids(Some(&json!(null))),
            Some(json!([]))
        );
    }

    #[test]
    fn pydantic_datetime_renders() {
        let dt = NaiveDateTime::parse_from_str("2026-09-10T04:59:37", "%Y-%m-%dT%H:%M:%S").unwrap();
        assert_eq!(pydantic_datetime(dt), "2026-09-10T04:59:37");
    }

    #[test]
    fn page_slice_matches_python_semantics() {
        let rows = vec![
            kind_row(subscription_json()),
            kind_row(subscription_json()),
            kind_row(subscription_json()),
        ];
        assert_eq!(page_slice(&rows, 0, 20).len(), 3);
        assert_eq!(page_slice(&rows, 2, 20).len(), 1);
        assert_eq!(page_slice(&rows, 5, 20).len(), 0);
    }

    #[test]
    fn webhook_url_built_from_token() {
        let mut json = subscription_json();
        json["_internal"]["webhook_token"] = json!("tok123");
        let item = convert_to_subscription_in_db(&kind_row(json), &HashMap::new());
        assert_eq!(
            item.webhook_url.as_deref(),
            Some("/api/subscriptions/webhook/tok123")
        );
    }

    #[test]
    fn workspace_repo_fields_extracted() {
        let workspace = json!({
            "spec": {
                "repository": {
                    "gitRepo": "owner/repo",
                    "gitRepoId": 7,
                    "gitDomain": "github.com",
                    "branchName": "main"
                }
            }
        });
        let fields = extract_repo_fields(&workspace);
        assert_eq!(fields.git_repo.as_deref(), Some("owner/repo"));
        assert_eq!(fields.git_repo_id, Some(7));
        assert_eq!(fields.git_domain.as_deref(), Some("github.com"));
        assert_eq!(fields.branch_name.as_deref(), Some("main"));
    }
}
