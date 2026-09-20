// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/subscriptions/executions` — background execution timeline.
//!
//! Mirrors `app.api.endpoints.adapter.subscriptions.list_executions`
//! (route `/executions`, router prefix `/subscriptions`, under `/api`) and
//! `BackgroundExecutionManager.list_executions`
//! (`app.services.subscription.execution`).
//!
//! Source pipeline:
//! 1. `security.get_current_user` — JWT session decode plus the labeled
//!    `users` lookup.
//! 2. When no `subscription_id` filter is supplied and `include_following`
//!    is true (the default), load the user's followed subscription ids from
//!    `subscription_follows` (`invitation_status = 'accepted'`).
//! 3. Count the matching `background_executions` rows (own user_id OR
//!    followed subscription_id), excluding `COMPLETED_SILENT` unless
//!    `include_silent` is true. The count wraps the full select projection
//!    in a subquery, matching SQLAlchemy's `query.count()` rendering.
//! 4. Fetch the paginated `background_executions` rows ordered by
//!    `created_at DESC`, offset/limit.
//! 5. Batch-load the distinct subscription `kinds` rows (kind='Subscription')
//!    for the executions returned.
//! 6. Batch-load the team `kinds` rows (kind='Team') referenced by the
//!    subscription `teamRef` specs.
//! 7. Build each `BackgroundExecutionInDB` item from the execution row plus
//!    the joined subscription/team fields; `can_delete` is true only when the
//!    subscription's owner_user_id equals the current user.
//!
//! Field order matches the pydantic `BackgroundExecutionInDB` declaration
//! order: `subscription_id, trigger_type, trigger_reason, prompt, id,
//! user_id, task_id, status, result_summary, error_message, retry_attempt,
//! started_at, completed_at, created_at, updated_at, subscription_name,
//! subscription_display_name, team_name, task_type, can_delete`.
use std::collections::HashMap;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::{AuthFailure, get_current_user};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// Query parameters of the executions endpoint.
///
/// `status` is repeated (`Optional[List[BackgroundExecutionStatus]]`); the
/// source accepts the enum string values. `start_date`/`end_date` are
/// optional ISO datetimes.
#[derive(Debug, Default, Deserialize)]
pub struct ExecutionsQuery {
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub subscription_id: Option<String>,
    #[serde(default)]
    pub status: Option<Vec<String>>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub include_silent: Option<String>,
}

/// Validated pagination and filter parameters.
#[derive(Debug)]
struct ExecutionsParams {
    page: i64,
    limit: i64,
    subscription_id: Option<i32>,
    status: Vec<String>,
    start_date: Option<String>,
    end_date: Option<String>,
    include_silent: bool,
}

impl ExecutionsQuery {
    /// Validate the FastAPI query contract: `page >= 1`,
    /// `1 <= limit <= 100`. `include_silent` defaults to false.
    fn validated(self) -> Result<ExecutionsParams, FastApiError> {
        let page = parse_i64(self.page.as_deref(), "page", 1, 1, i64::MAX)?;
        let limit = parse_i64(self.limit.as_deref(), "limit", 50, 1, 100)?;
        let subscription_id = match self.subscription_id.as_deref() {
            None => None,
            Some(raw) => Some(parse_i64(Some(raw), "subscription_id", 0, 0, i64::MAX)? as i32),
        };
        let include_silent = parse_bool(self.include_silent.as_deref())?;
        Ok(ExecutionsParams {
            page,
            limit,
            subscription_id,
            status: self.status.unwrap_or_default(),
            start_date: self.start_date,
            end_date: self.end_date,
            include_silent,
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
            )),
            Err(_) => Err(validation_error(
                field,
                "int_parsing",
                "Input should be a valid integer, unable to parse string as an integer",
            )),
        },
    }
}

/// Parse a boolean query parameter (`"true"`/`"false"` case-insensitive),
/// matching FastAPI's bool query parsing. Absent means `false`.
fn parse_bool(raw: Option<&str>) -> Result<bool, FastApiError> {
    match raw {
        None => Ok(false),
        Some(value) => match value.to_ascii_lowercase().as_str() {
            "true" | "1" | "on" | "yes" => Ok(true),
            "false" | "0" | "off" | "no" | "" => Ok(false),
            _ => Err(validation_error(
                "include_silent",
                "bool_parsing",
                "Input should be a valid boolean, unable to interpret input as boolean",
            )),
        },
    }
}

/// FastAPI-style 422 validation error body.
fn validation_error(field: &str, kind: &str, message: &str) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": kind,
            "loc": ["query", field],
            "msg": message,
            "input": null,
        }
    ]))
}

/// A `background_executions` row, selected with the full labeled source
/// column list; only the response-driving fields are consumed. The result
/// columns carry the `background_executions_<column>` aliases.
#[derive(Debug, FromMysqlRow)]
struct ExecutionRow {
    #[mysql(rename = "background_executions_id")]
    id: i32,
    #[mysql(rename = "background_executions_user_id")]
    user_id: i32,
    #[mysql(rename = "background_executions_subscription_id")]
    subscription_id: i32,
    #[mysql(rename = "background_executions_task_id")]
    task_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "background_executions_inbox_message_id")]
    inbox_message_id: i32,
    #[mysql(rename = "background_executions_trigger_type")]
    trigger_type: String,
    #[mysql(rename = "background_executions_trigger_reason")]
    trigger_reason: String,
    #[mysql(rename = "background_executions_prompt")]
    prompt: String,
    #[mysql(rename = "background_executions_status")]
    status: String,
    #[mysql(rename = "background_executions_result_summary")]
    result_summary: String,
    #[mysql(rename = "background_executions_error_message")]
    error_message: String,
    #[mysql(rename = "background_executions_retry_attempt")]
    retry_attempt: i32,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "background_executions_version")]
    version: i32,
    #[mysql(rename = "background_executions_started_at")]
    started_at: NaiveDateTime,
    #[mysql(rename = "background_executions_completed_at")]
    completed_at: NaiveDateTime,
    #[mysql(rename = "background_executions_created_at")]
    created_at: NaiveDateTime,
    #[mysql(rename = "background_executions_updated_at")]
    updated_at: NaiveDateTime,
}

/// A `kinds` row (Subscription or Team), selected with the full labeled
/// source column list.
#[derive(Debug, FromMysqlRow)]
struct KindRow {
    #[mysql(rename = "kinds_id")]
    id: i32,
    #[mysql(rename = "kinds_user_id")]
    user_id: i32,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_kind")]
    kind: String,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[mysql(rename = "kinds_json")]
    json: Json<SubscriptionCrd>,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_is_active")]
    is_active: i8,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_created_at")]
    created_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_updated_at")]
    updated_at: NaiveDateTime,
}

/// The `kinds` column projection rendered by `db.query(Kind)` (SQLAlchemy
/// labels every column `kinds_<name>`).
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// The `background_executions` column projection rendered by
/// `db.query(BackgroundExecution)`.
const EXECUTION_COLUMNS: &str = "background_executions.id AS background_executions_id, \
     background_executions.user_id AS background_executions_user_id, \
     background_executions.subscription_id AS background_executions_subscription_id, \
     background_executions.task_id AS background_executions_task_id, \
     background_executions.inbox_message_id AS background_executions_inbox_message_id, \
     background_executions.trigger_type AS background_executions_trigger_type, \
     background_executions.trigger_reason AS background_executions_trigger_reason, \
     background_executions.prompt AS background_executions_prompt, \
     background_executions.status AS background_executions_status, \
     background_executions.result_summary AS background_executions_result_summary, \
     background_executions.error_message AS background_executions_error_message, \
     background_executions.retry_attempt AS background_executions_retry_attempt, \
     background_executions.version AS background_executions_version, \
     background_executions.started_at AS background_executions_started_at, \
     background_executions.completed_at AS background_executions_completed_at, \
     background_executions.created_at AS background_executions_created_at, \
     background_executions.updated_at AS background_executions_updated_at";

/// `subscription_follows.subscription_id` row.
#[derive(Debug, FromMysqlRow)]
struct FollowRow {
    #[mysql(rename = "subscription_follows_subscription_id")]
    subscription_id: i32,
}

/// `count(*) AS count_1` row.
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    #[mysql(rename = "count_1")]
    count: i64,
}

/// `BackgroundExecutionListResponse` — the top-level JSON body.
#[derive(Debug, Serialize)]
struct ExecutionListResponse {
    total: i64,
    items: Vec<ExecutionItem>,
}

/// One `BackgroundExecutionInDB` item in pydantic field declaration order.
#[derive(Debug, Serialize)]
struct ExecutionItem {
    subscription_id: i32,
    trigger_type: String,
    trigger_reason: String,
    prompt: String,
    id: i32,
    user_id: i32,
    task_id: i64,
    status: String,
    result_summary: String,
    error_message: String,
    retry_attempt: i32,
    started_at: PydanticDateTime,
    completed_at: PydanticDateTime,
    created_at: PydanticDateTime,
    updated_at: PydanticDateTime,
    subscription_name: Option<String>,
    subscription_display_name: Option<String>,
    team_name: Option<String>,
    task_type: Option<String>,
    can_delete: bool,
}

/// pydantic naive-datetime serialization wrapper: `YYYY-MM-DDTHH:MM:SS`
/// plus fractional seconds when nonzero.
#[derive(Debug, Serialize)]
struct PydanticDateTime(String);

impl PydanticDateTime {
    fn new(value: NaiveDateTime) -> Self {
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            Self(base)
        } else {
            Self(format!(
                "{base}.{:06}",
                value.and_utc().timestamp_subsec_micros()
            ))
        }
    }
}

/// GET /api/subscriptions/executions: the executions free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/subscriptions/executions")]
async fn list_executions(
    #[inject(state)] state: &AppState,
    #[header] authorization: Option<&str>,
    query: brz_http_server::Query<ExecutionsQuery>,
) -> Result<ExecutionListResponse, FastApiError> {
    executions(state, authorization, &query).await
}

/// Handler body for `GET /api/subscriptions/executions`.
async fn executions(
    state: &AppState,
    authorization: Option<&str>,
    query: &ExecutionsQuery,
) -> Result<ExecutionListResponse, FastApiError> {
    let params = ExecutionsQuery {
        page: query.page.clone(),
        limit: query.limit.clone(),
        subscription_id: query.subscription_id.clone(),
        status: query.status.clone(),
        start_date: query.start_date.clone(),
        end_date: query.end_date.clone(),
        include_silent: query.include_silent.clone(),
    }
    .validated()?;

    let current_user = match get_current_user(&state.auth, &state.mysql, authorization).await {
        Ok(user) => user,
        Err(AuthFailure::InvalidCredentials) => {
            return Err(FastApiError::unauthorized("Could not validate credentials"));
        }
        Err(AuthFailure::UserNotActivated) => {
            return Err(FastApiError::unauthorized("User not activated"));
        }
    };
    let user_id = current_user.id;

    // Load followed subscription ids when no subscription_id filter is
    // supplied (the source sets include_following=True by default and skips
    // the follow lookup when subscription_id is provided).
    let followed_ids: Vec<i32> = if params.subscription_id.is_none() {
        followed_subscription_ids(&state.mysql, user_id)
            .await
            .map_err(internal_error)?
    } else {
        Vec::new()
    };

    // Build the WHERE clause fragment and the count/select queries. The
    // source renders `(user_id = N OR subscription_id IN (...))` when
    // follows exist, otherwise `user_id = N`.
    let where_clause = build_where_clause(user_id, &followed_ids, &params);
    let total = count_executions(&state.mysql, &where_clause, &params)
        .await
        .map_err(internal_error)?;
    let skip = (params.page - 1) * params.limit;
    let executions = fetch_executions(&state.mysql, &where_clause, &params, skip)
        .await
        .map_err(internal_error)?;

    if executions.is_empty() {
        return Ok(ExecutionListResponse {
            total,
            items: Vec::new(),
        });
    }

    // Batch-load subscription kinds for the distinct subscription_ids.
    let subscription_ids: Vec<i32> = distinct_subscription_ids(&executions);
    let subscriptions = fetch_subscriptions(&state.mysql, &subscription_ids)
        .await
        .map_err(internal_error)?;

    // Build the subscription cache: id -> SubscriptionInfo.
    let mut subscription_cache: Vec<(i32, SubscriptionInfo)> = Vec::new();
    let mut team_refs: Vec<(String, String)> = Vec::new();
    for sub in &subscriptions {
        let mut info = parse_subscription(&sub.json.0);
        info.name = sub.name.clone();
        info.owner_user_id = sub.user_id;
        if let Some(ref team_ref) = info.team_ref {
            team_refs.push((team_ref.name.clone(), team_ref.namespace.clone()));
        }
        subscription_cache.push((sub.id, info));
    }

    // Batch-load team kinds for the referenced teamRefs.
    let teams = if team_refs.is_empty() {
        Vec::new()
    } else {
        fetch_teams(&state.mysql, &team_refs)
            .await
            .map_err(internal_error)?
    };
    let team_map = build_team_map(&teams);

    // Build the response items in pydantic BackgroundExecutionInDB field
    // order.
    let mut items: Vec<ExecutionItem> = Vec::with_capacity(executions.len());
    for exec in &executions {
        let sub_info = find_subscription(&subscription_cache, exec.subscription_id);
        let subscription_name = sub_info.map(|i| i.name.clone());
        let subscription_display_name = sub_info.and_then(|i| i.display_name.clone());
        let task_type = sub_info.and_then(|i| i.task_type.clone());
        let team_name = sub_info
            .and_then(|i| i.team_ref.as_ref())
            .and_then(|tr| team_map.get(&(tr.name.clone(), tr.namespace.clone())))
            .cloned();
        let can_delete = sub_info
            .map(|i| i.owner_user_id == user_id)
            .unwrap_or(false);
        items.push(execution_item(
            exec,
            subscription_name,
            subscription_display_name,
            team_name,
            task_type,
            can_delete,
        ));
    }

    Ok(ExecutionListResponse { total, items })
}

/// Parsed subscription info from the `kinds.json` CRD.
struct SubscriptionInfo {
    name: String,
    display_name: Option<String>,
    task_type: Option<String>,
    team_ref: Option<TeamRef>,
    owner_user_id: i32,
}

/// A `spec.teamRef` value.
struct TeamRef {
    name: String,
    namespace: String,
}

/// Typed `kinds.json` CRD for Subscription rows — only the fields consumed
/// by the response are deserialized; remaining JSON is ignored by serde.
#[derive(Debug, Deserialize)]
struct SubscriptionCrd {
    spec: Option<SubscriptionSpec>,
}

/// `spec` block of the subscription CRD.
#[derive(Debug, Deserialize)]
struct SubscriptionSpec {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "taskType")]
    task_type: Option<String>,
    #[serde(rename = "teamRef")]
    team_ref: Option<SubscriptionTeamRef>,
}

/// `spec.teamRef` value.
#[derive(Debug, Deserialize)]
struct SubscriptionTeamRef {
    name: String,
    #[serde(default = "default_namespace")]
    namespace: String,
}

fn default_namespace() -> String {
    "default".to_string()
}

/// Parse the subscription CRD JSON (`kinds.json`) into the fields consumed
/// by the response. `name` comes from the `kinds.name` column, not the JSON;
/// `owner_user_id` comes from `kinds.user_id`.
fn parse_subscription(crd: &SubscriptionCrd) -> SubscriptionInfo {
    let spec = match &crd.spec {
        Some(spec) => spec,
        None => {
            return SubscriptionInfo {
                name: String::new(),
                display_name: None,
                task_type: None,
                team_ref: None,
                owner_user_id: 0,
            };
        }
    };
    let team_ref = spec.team_ref.as_ref().map(|tr| TeamRef {
        name: tr.name.clone(),
        namespace: tr.namespace.clone(),
    });
    SubscriptionInfo {
        name: String::new(),
        display_name: spec.display_name.clone(),
        task_type: spec.task_type.clone(),
        team_ref,
        owner_user_id: 0,
    }
}

/// Find a subscription in the cache by id.
fn find_subscription(
    cache: &[(i32, SubscriptionInfo)],
    subscription_id: i32,
) -> Option<&SubscriptionInfo> {
    cache
        .iter()
        .find(|(id, _)| *id == subscription_id)
        .map(|(_, info)| info)
}

/// Build a map from (name, namespace) to team name.
fn build_team_map(teams: &[KindRow]) -> HashMap<(String, String), String> {
    let mut map = HashMap::new();
    for team in teams {
        map.insert(
            (team.name.clone(), team.namespace.clone()),
            team.name.clone(),
        );
    }
    map
}

/// Collect distinct subscription_ids from the execution rows, preserving
/// first-seen order (the source uses `list(set(...))` which is unordered,
/// but the IN-list order does not affect results).
fn distinct_subscription_ids(executions: &[ExecutionRow]) -> Vec<i32> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for exec in executions {
        if seen.insert(exec.subscription_id) {
            result.push(exec.subscription_id);
        }
    }
    result
}

/// Build the WHERE clause fragment for the execution queries. The source
/// renders `(user_id = N OR subscription_id IN (...))` when followed ids
/// exist, otherwise `user_id = N`. When `subscription_id` filter is set,
/// it adds `AND subscription_id = N`.
fn build_where_clause(user_id: i32, followed_ids: &[i32], params: &ExecutionsParams) -> String {
    let mut clause = if !followed_ids.is_empty() {
        let list = followed_ids
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "(background_executions.user_id = {user_id} OR background_executions.subscription_id IN ({list}))"
        )
    } else {
        format!("background_executions.user_id = {user_id}")
    };
    if let Some(sub_id) = params.subscription_id {
        clause.push_str(&format!(
            " AND background_executions.subscription_id = {sub_id}"
        ));
    }
    // Exclude COMPLETED_SILENT unless explicitly included.
    let silent_in_status = params.status.iter().any(|s| s == "COMPLETED_SILENT");
    if !params.include_silent && !silent_in_status {
        clause.push_str(" AND background_executions.status != 'COMPLETED_SILENT'");
    }
    // Status filter (IN list).
    if !params.status.is_empty() {
        let list = params
            .status
            .iter()
            .map(|s| format!("'{}'", escape_sql_string(s)))
            .collect::<Vec<_>>()
            .join(", ");
        clause.push_str(&format!(" AND background_executions.status IN ({list})"));
    }
    // Date range filters on created_at.
    if let Some(ref start) = params.start_date {
        clause.push_str(&format!(
            " AND background_executions.created_at >= '{}'",
            escape_sql_string(start)
        ));
    }
    if let Some(ref end) = params.end_date {
        clause.push_str(&format!(
            " AND background_executions.created_at <= '{}'",
            escape_sql_string(end)
        ));
    }
    clause
}

/// `subscription_follow_service.get_followed_subscription_ids`: load the
/// user's followed subscription ids with `invitation_status = 'accepted'`.
async fn followed_subscription_ids<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> Result<Vec<i32>, brz_mysql::MysqlError> {
    let rows: Vec<FollowRow> = mysql
        .fetch_all(
            "SELECT subscription_follows.subscription_id AS subscription_follows_subscription_id \n\
             FROM subscription_follows \n\
             WHERE subscription_follows.follower_user_id = ? \
             AND subscription_follows.invitation_status = 'accepted'",
            (user_id,),
        )
        .await?;
    Ok(rows.into_iter().map(|r| r.subscription_id).collect())
}

/// Count matching executions. The source wraps the full select projection
/// in a subquery (`SELECT count(*) FROM (SELECT ... FROM ... WHERE ...) AS anon_1`).
async fn count_executions<M: Mysql>(
    mysql: &M,
    where_clause: &str,
    _params: &ExecutionsParams,
) -> Result<i64, brz_mysql::MysqlError> {
    let sql = format!(
        "SELECT count(*) AS count_1 \n\
         FROM (SELECT {EXECUTION_COLUMNS} \n\
         FROM background_executions \n\
         WHERE {where_clause}) AS anon_1"
    );
    let row: CountRow = mysql.fetch_one(sql, ()).await?;
    Ok(row.count)
}

/// Fetch the paginated execution rows ordered by `created_at DESC`.
async fn fetch_executions<M: Mysql>(
    mysql: &M,
    where_clause: &str,
    params: &ExecutionsParams,
    skip: i64,
) -> Result<Vec<ExecutionRow>, brz_mysql::MysqlError> {
    let sql = format!(
        "SELECT {EXECUTION_COLUMNS} \n\
         FROM background_executions \n\
         WHERE {where_clause} ORDER BY background_executions.created_at DESC \n\
         LIMIT {skip}, {limit}",
        limit = params.limit
    );
    mysql.fetch_all(sql, ()).await
}

/// Batch-load subscription `kinds` rows for the given ids.
async fn fetch_subscriptions<M: Mysql>(
    mysql: &M,
    subscription_ids: &[i32],
) -> Result<Vec<KindRow>, brz_mysql::MysqlError> {
    if subscription_ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = subscription_ids
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {KIND_COLUMNS} \n\
         FROM kinds \n\
         WHERE kinds.id IN ({list}) AND kinds.kind = 'Subscription'"
    );
    mysql.fetch_all(sql, ()).await
}

/// Batch-load team `kinds` rows for the referenced teamRefs. The source
/// renders `(kinds.name = N1 AND kinds.namespace = NS1 OR kinds.name = N2
/// AND kinds.namespace = NS2)`.
async fn fetch_teams<M: Mysql>(
    mysql: &M,
    team_refs: &[(String, String)],
) -> Result<Vec<KindRow>, brz_mysql::MysqlError> {
    let conditions = team_refs
        .iter()
        .map(|(name, ns)| {
            format!(
                "kinds.name = '{}' AND kinds.namespace = '{}'",
                escape_sql_string(name),
                escape_sql_string(ns)
            )
        })
        .collect::<Vec<_>>()
        .join(" OR ");
    let sql = format!(
        "SELECT {KIND_COLUMNS} \n\
         FROM kinds \n\
         WHERE kinds.kind = 'Team' AND ({conditions})"
    );
    mysql.fetch_all(sql, ()).await
}

/// Build one `BackgroundExecutionInDB` item in pydantic field order.
fn execution_item(
    exec: &ExecutionRow,
    subscription_name: Option<String>,
    subscription_display_name: Option<String>,
    team_name: Option<String>,
    task_type: Option<String>,
    can_delete: bool,
) -> ExecutionItem {
    ExecutionItem {
        subscription_id: exec.subscription_id,
        trigger_type: exec.trigger_type.clone(),
        trigger_reason: exec.trigger_reason.clone(),
        prompt: exec.prompt.clone(),
        id: exec.id,
        user_id: exec.user_id,
        task_id: exec.task_id,
        status: exec.status.clone(),
        result_summary: exec.result_summary.clone(),
        error_message: exec.error_message.clone(),
        retry_attempt: exec.retry_attempt,
        started_at: PydanticDateTime::new(exec.started_at),
        completed_at: PydanticDateTime::new(exec.completed_at),
        created_at: PydanticDateTime::new(exec.created_at),
        updated_at: PydanticDateTime::new(exec.updated_at),
        subscription_name,
        subscription_display_name,
        team_name,
        task_type,
        can_delete,
    }
}

/// Escape one string literal with MySQL's default quoting rules.
///
/// Iterates over Unicode scalar values (chars), not raw bytes, so that
/// multi-byte UTF-8 sequences (e.g. Chinese team names) are preserved
/// correctly. The source SQLAlchemy renders these as inline COM_QUERY
/// literals with the connection charset (UTF-8).
fn escape_sql_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{1a}' => out.push_str("\\Z"),
            other => out.push(other),
        }
    }
    out
}

/// Source `python_exception_handler` 500 response shape.
fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "subscriptions executions dependency failure");
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error_code": 500, "detail": "Internal server error"}).to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn exec_row(id: i32, sub_id: i32) -> ExecutionRow {
        let dt = NaiveDate::from_ymd_opt(2026, 9, 10)
            .unwrap()
            .and_hms_opt(4, 59, 37)
            .unwrap();
        ExecutionRow {
            id,
            user_id: 1237,
            subscription_id: sub_id,
            task_id: 170011985603497,
            inbox_message_id: 0,
            trigger_type: "cron".to_string(),
            trigger_reason: "Scheduled (cron: 29,59 8-19 * * *)".to_string(),
            prompt: "test prompt".to_string(),
            status: "COMPLETED".to_string(),
            result_summary: "summary".to_string(),
            error_message: String::new(),
            retry_attempt: 0,
            version: 1,
            started_at: dt,
            completed_at: dt,
            created_at: dt,
            updated_at: dt,
        }
    }

    #[test]
    fn execution_item_has_pydantic_field_order() {
        let item = execution_item(
            &exec_row(2164069, 259790),
            Some("sub-name".to_string()),
            Some("Display".to_string()),
            Some("team".to_string()),
            Some("collection".to_string()),
            true,
        );
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
                "subscription_id",
                "trigger_type",
                "trigger_reason",
                "prompt",
                "id",
                "user_id",
                "task_id",
                "status",
                "result_summary",
                "error_message",
                "retry_attempt",
                "started_at",
                "completed_at",
                "created_at",
                "updated_at",
                "subscription_name",
                "subscription_display_name",
                "team_name",
                "task_type",
                "can_delete",
            ]
        );
    }

    #[test]
    fn pydantic_datetime_renders_without_fraction() {
        let dt = NaiveDate::from_ymd_opt(2026, 9, 10)
            .unwrap()
            .and_hms_opt(4, 59, 37)
            .unwrap();
        let rendered = serde_json::to_value(PydanticDateTime::new(dt)).unwrap();
        assert_eq!(rendered, json!("2026-09-10T04:59:37"));
    }

    #[test]
    fn pydantic_datetime_renders_with_microseconds() {
        let dt = NaiveDate::from_ymd_opt(2026, 9, 10)
            .unwrap()
            .and_hms_micro_opt(4, 59, 37, 123456)
            .unwrap();
        let rendered = serde_json::to_value(PydanticDateTime::new(dt)).unwrap();
        assert_eq!(rendered, json!("2026-09-10T04:59:37.123456"));
    }

    #[test]
    fn parses_default_query_params() {
        let params = ExecutionsQuery {
            page: None,
            limit: None,
            subscription_id: None,
            status: None,
            start_date: None,
            end_date: None,
            include_silent: None,
        }
        .validated()
        .unwrap();
        assert_eq!(params.page, 1);
        assert_eq!(params.limit, 50);
        assert_eq!(params.subscription_id, None);
        assert!(!params.include_silent);
    }

    #[test]
    fn parses_explicit_query_params() {
        let params = ExecutionsQuery {
            page: Some("2".to_string()),
            limit: Some("100".to_string()),
            subscription_id: Some("42".to_string()),
            status: Some(vec!["COMPLETED".to_string()]),
            start_date: None,
            end_date: None,
            include_silent: Some("true".to_string()),
        }
        .validated()
        .unwrap();
        assert_eq!(params.page, 2);
        assert_eq!(params.limit, 100);
        assert_eq!(params.subscription_id, Some(42));
        assert!(params.include_silent);
        assert_eq!(params.status, vec!["COMPLETED"]);
    }

    #[test]
    fn rejects_limit_over_100() {
        let error = ExecutionsQuery {
            page: None,
            limit: Some("101".to_string()),
            subscription_id: None,
            status: None,
            start_date: None,
            end_date: None,
            include_silent: None,
        }
        .validated()
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn build_where_clause_excludes_silent_by_default() {
        let params = ExecutionsParams {
            page: 1,
            limit: 50,
            subscription_id: None,
            status: Vec::new(),
            start_date: None,
            end_date: None,
            include_silent: false,
        };
        let clause = build_where_clause(1237, &[], &params);
        assert!(clause.contains("status != 'COMPLETED_SILENT'"));
    }

    #[test]
    fn build_where_clause_includes_followed_ids() {
        let params = ExecutionsParams {
            page: 1,
            limit: 50,
            subscription_id: None,
            status: Vec::new(),
            start_date: None,
            end_date: None,
            include_silent: false,
        };
        let clause = build_where_clause(1237, &[237489, 259790], &params);
        assert!(clause.contains(
            "(background_executions.user_id = 1237 OR background_executions.subscription_id IN (237489, 259790))"
        ));
    }

    #[test]
    fn distinct_subscription_ids_dedupes() {
        let rows = vec![exec_row(1, 10), exec_row(2, 20), exec_row(3, 10)];
        let ids = distinct_subscription_ids(&rows);
        assert_eq!(ids, vec![10, 20]);
    }

    #[test]
    fn escape_sql_string_quotes_apostrophes() {
        assert_eq!(escape_sql_string("a'b"), "a\\'b");
        assert_eq!(escape_sql_string("normal"), "normal");
    }
}
