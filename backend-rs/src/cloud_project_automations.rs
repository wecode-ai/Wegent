// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/automations` — list the
//! automation rules of one cloud project.
//!
//! Mirrors `app.api.endpoints.project_automations.list_automations` ->
//! `project_automation_service.list(db, project_id, current_user.id)`.
//!
//! Source pipeline:
//! 1. `security.get_current_user` — JWT decode plus the labeled `users`
//!    lookup (the twelve-column `users_<column>` projection).
//! 2. `require_cloud_project_role(db, project_id, user_id, Reporter)` —
//!    re-read the active `loop_items` project row (inlined snowflake id as a
//!    string literal) and, for non-creators, the approved `resource_members`
//!    membership row (inlined `resource_id` and `entity_id`); public
//!    projects resolve a non-member to `RestrictedAnalyst`, which fails
//!    `has_permission(RestrictedAnalyst, Reporter)` and raises
//!    `403 {"detail": "Insufficient permission"}`.
//! 3. `ProjectAutomationRule` scan — automation-rule rows
//!    (`resource_type='automation_rule'`, unset `deleted_at`) ordered by
//!    `updated_at DESC`.
//! 4. `_rule_view` — each row renders the `ProjectAutomationView` payload
//!    (camelCase aliases via `ProjectChatSchema`).
//!
//! The recorded case is a public project visited by a non-member
//! (`RestrictedAnalyst`), so the source raises the 403 after the project and
//! membership lookups; the rule scan is implemented for the permitted path.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Serialize;
use serde_json::value::RawValue;

use crate::auth::{AuthFailure, get_current_user};
use crate::cloud_projects::{PROJECT_COLUMNS, ProjectListRow};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// The `loop_items` columns consumed by the automation-rule projection.
///
/// The recorded projection lists all mapped columns labeled
/// `loop_items_<column>`; only the fields below feed the response, but the
/// full labeled projection is selected so the prepared statement matches the
/// recorded exchange for replay.
#[derive(Debug, FromMysqlRow)]
struct AutomationRuleRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_cloud_project_id")]
    cloud_project_id: Option<String>,
    #[mysql(rename = "loop_items_title")]
    title: Option<String>,
    #[mysql(rename = "loop_items_description")]
    description: Option<String>,
    #[mysql(rename = "loop_items_assignee_agent_id")]
    assignee_agent_id: String,
    #[mysql(rename = "loop_items_created_by_user_id")]
    #[allow(dead_code, reason = "selected to match source column list")]
    created_by_user_id: Option<i32>,
    #[mysql(rename = "loop_items_status")]
    status: Option<String>,
    #[mysql(rename = "loop_items_due_at")]
    due_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_version")]
    version: i64,
    #[mysql(rename = "loop_items_created_at")]
    created_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_updated_at")]
    updated_at: Option<NaiveDateTime>,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<RuleMetadata>>,
}

/// Typed metadata of one automation rule (`_metadata(row)`). Only the fields
/// consumed by `_rule_view` are typed; unknown keys are ignored by serde.
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(default)]
struct RuleMetadata {
    action: Option<String>,
    event_type: Option<String>,
    event_config: Option<Box<RawValue>>,
    cron_expression: Option<String>,
    timezone: Option<String>,
    last_run_at: Option<String>,
    manager: Option<ManagerConfig>,
    role: Option<RoleConfig>,
    runtime: Option<RuntimeConfig>,
}

/// The `manager` sub-object of a rule's metadata.
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(default)]
struct ManagerConfig {
    r#type: Option<String>,
    wegent_team_id: Option<serde_json::Value>,
}

/// The `role` sub-object (`role_config`).
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(default)]
struct RoleConfig {
    source: Option<String>,
}

/// The `runtime` sub-object (`runtime_config`).
#[derive(Debug, Default, Clone, serde::Deserialize)]
#[serde(default)]
struct RuntimeConfig {
    source: Option<String>,
    runtime_profile_id: Option<String>,
    user_id: Option<serde_json::Value>,
}

impl RuleMetadata {
    /// `assignment_mode(metadata)` (`project_automation_domain`): the
    /// metadata `action` maps `execute` -> manual, `ai_assign` ->
    /// ai_managed. An invalid or missing action raises `ValueError` in the
    /// source, which FastAPI renders as a 500; the caller maps `None` to
    /// that internal-error response.
    fn assignment_mode(&self) -> Option<&'static str> {
        match self.action.as_deref() {
            Some("execute") => Some("manual"),
            Some("ai_assign") => Some("ai_managed"),
            _ => None,
        }
    }

    /// `manager_type(metadata)`: the configured manager type when valid.
    /// An invalid configured type raises `ValueError` in the source (500);
    /// `None` selects that response when the key was set to an unknown
    /// value.
    fn manager_type(&self) -> Option<Option<&'static str>> {
        match self
            .manager
            .as_ref()
            .map(|manager| manager.r#type.as_deref())
        {
            None | Some(None) => Some(None),
            Some(Some("custom")) => Some(Some("custom")),
            Some(Some("wegent")) => Some(Some("wegent")),
            Some(Some(_)) => None,
        }
    }
}

/// `integer(value)` (`project_automation_domain`): `Some(n)` for JSON
/// integer-like values, `None` otherwise.
fn metadata_integer(value: Option<&serde_json::Value>) -> Option<i64> {
    match value? {
        serde_json::Value::Number(number) => number.as_i64(),
        _ => None,
    }
}

/// The `resource_members` role row for the membership lookup.
#[derive(Debug, FromMysqlRow)]
struct RoleRow {
    #[mysql(rename = "resource_members_role")]
    role: String,
}

/// The `require_cloud_project_role` membership lookup for a non-creator.
/// The recorded COM_QUERY inlines the snowflake `resource_id` and the user
/// id as string literals, matching the source SQLAlchemy rendering (the ids
/// are passed as strings).
async fn membership_role<M: Mysql>(
    mysql: &M,
    project_id: &str,
    user_id: i32,
) -> MysqlResult<Option<String>> {
    let row: Option<RoleRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT resource_members.id AS resource_members_id, \
             resource_members.resource_type AS resource_members_resource_type, \
             resource_members.resource_id AS resource_members_resource_id, \
             resource_members.entity_type AS resource_members_entity_type, \
             resource_members.entity_id AS resource_members_entity_id, \
             resource_members.entity_display_name AS resource_members_entity_display_name, \
             resource_members.user_id AS resource_members_user_id, \
             resource_members.`role` AS resource_members_role, \
             resource_members.status AS resource_members_status, \
             resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
             resource_members.share_link_id AS resource_members_share_link_id, \
             resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
             resource_members.reviewed_at AS resource_members_reviewed_at, \
             resource_members.copied_resource_id AS resource_members_copied_resource_id, \
             resource_members.requested_at AS resource_members_requested_at, \
             resource_members.created_at AS resource_members_created_at, \
             resource_members.updated_at AS resource_members_updated_at \n\
             FROM resource_members \n\
             WHERE resource_members.resource_type = 'CloudProject' \
             AND resource_members.resource_id = '{project_id}' \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = '{user_id}' \
             AND resource_members.status = 'approved' \n LIMIT 1"
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| row.role))
}

/// `ProjectAutomationRule` scan: the project's automation-rule rows with an
/// unset `deleted_at`, newest `updated_at` first. `cloud_project_id` is
/// inlined as a quoted string literal (the source passes `project_id` as a
/// string).
async fn list_rule_rows<M: Mysql>(
    mysql: &M,
    project_id: &str,
) -> MysqlResult<Vec<AutomationRuleRow>> {
    let sql = format!(
        "SELECT {} \nFROM loop_items \n\
         WHERE loop_items.cloud_project_id = '{project_id}' \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
             ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND loop_items.resource_type IN ('automation_rule') \
         ORDER BY loop_items.updated_at DESC",
        crate::cloud_projects::PROJECT_COLUMNS
    );
    mysql.fetch_all(sql, ()).await
}

/// GET /api/v1/cloud-projects/{project_id}/automations: the automations
/// free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/cloud-projects/:project_id/automations")]
async fn list_automations(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[header] authorization: Option<&str>,
) -> Result<Vec<ProjectAutomationView>, FastApiError> {
    automations(state, project_id, authorization).await
}

/// Handler body for `GET /api/v1/cloud-projects/{project_id}/automations`.
async fn automations(
    state: &AppState,
    project_id: &str,
    authorization: Option<&str>,
) -> Result<Vec<ProjectAutomationView>, FastApiError> {
    let current_user = get_current_user(&state.auth, &state.mysql, authorization)
        .await
        .map_err(auth_error)?;

    // `require_cloud_project_role(db, project_id, user_id, Reporter)`: the
    // source passes the path parameter (a string) through, so SQLAlchemy
    // renders `loop_items.id = '<id>'` with a quoted string literal — the
    // recorded exchange of this endpoint inlines the id that way.
    let row: Option<ProjectListRow> = state
        .mysql
        .fetch_optional(
            &format!(
                "SELECT {PROJECT_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.id = '{project_id}' AND loop_items.status = 'active' \
                 AND loop_items.resource_type IN ('project') \n LIMIT 1"
            ),
            (),
        )
        .await
        .map_err(internal_error)?;
    let project =
        row.ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found"))?;

    // Role resolution: creator -> Owner, approved member -> stored role,
    // public project -> RestrictedAnalyst (fails the Reporter check below),
    // private project -> 404.
    let role = if project.created_by_user_id == current_user.id {
        "Owner".to_string()
    } else {
        match membership_role(&state.mysql, &project.id, current_user.id)
            .await
            .map_err(internal_error)?
        {
            Some(role) => role,
            None if project
                .metadata
                .as_ref()
                .and_then(|json| json.0.value.as_ref())
                .and_then(|metadata| metadata.visibility.as_deref())
                == Some("public") =>
            {
                "RestrictedAnalyst".to_string()
            }
            None => {
                return Err(FastApiError::detail(
                    StatusCode::NOT_FOUND,
                    "Cloud project not found",
                ));
            }
        }
    };
    if !crate::board_snapshot::repository::has_permission(&role, "Reporter") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `project_automation_service.list`: the project's automation rules.
    let rows = list_rule_rows(&state.mysql, project_id)
        .await
        .map_err(internal_error)?;
    let mut views = Vec::with_capacity(rows.len());
    for row in &rows {
        views.push(rule_view(row).map_err(|()| FastApiError::internal())?);
    }
    Ok(views)
}

/// `_rule_view(db, row)`: the `ProjectAutomationView` payload. `Err(())`
/// marks a metadata contract violation that the source renders as a 500
/// (`ValueError` in `assignment_mode` / `manager_type`).
fn rule_view(row: &AutomationRuleRow) -> Result<ProjectAutomationView, ()> {
    let metadata = row
        .metadata
        .as_ref()
        .map(|json| &json.0)
        .cloned()
        .unwrap_or_default();
    let mode = metadata.assignment_mode().ok_or(())?;
    let manager = metadata.manager_type().ok_or(())?;
    let manager_config = metadata.manager.as_ref();
    let team_id =
        metadata_integer(manager_config.and_then(|manager| manager.wegent_team_id.as_ref()));

    // `bot_config(agent)` values for the manual mode; the recorded case has
    // no rules, so the defaults keep the documented payload shape.
    let (agent_name, environment, device_id, model) = match mode {
        "manual" => ("AI".to_string(), "local".to_string(), None, None),
        _ if manager == Some("custom") => (
            "自定义 AI 调度员".to_string(),
            "local".to_string(),
            None,
            None,
        ),
        _ => (
            "Wegent 智能体".to_string(),
            "managed".to_string(),
            None,
            None,
        ),
    };

    let role_source = metadata
        .role
        .as_ref()
        .and_then(|role| role.source.clone())
        .unwrap_or_else(|| "agent".to_string());
    let runtime = metadata.runtime.as_ref().cloned().unwrap_or_default();
    let runtime_source = runtime
        .source
        .clone()
        .unwrap_or_else(|| "agent_default".to_string());

    Ok(ProjectAutomationView {
        id: row.id.clone(),
        project_id: row.cloud_project_id.clone().unwrap_or_default(),
        name: row.title.clone().unwrap_or_default(),
        prompt: row.description.clone().unwrap_or_default(),
        trigger_type: "schedule".to_string(),
        event_type: metadata.event_type.clone(),
        event_config: metadata
            .event_config
            .clone()
            .unwrap_or_else(raw_empty_object),
        assignment_mode: mode.to_string(),
        manager_type: manager.map(str::to_string),
        cron_expression: metadata.cron_expression.clone(),
        timezone: metadata
            .timezone
            .clone()
            .unwrap_or_else(|| "Asia/Shanghai".to_string()),
        agent_id: (!row.assignee_agent_id.is_empty()).then(|| row.assignee_agent_id.clone()),
        wegent_team_id: team_id,
        model,
        agent_name,
        execution_environment: environment,
        execution_device_id: device_id,
        role_source,
        runtime_source,
        runtime_profile_id: non_empty(runtime.runtime_profile_id.clone()),
        runtime_user_id: metadata_integer(runtime.user_id.as_ref()),
        enabled: row.status.as_deref() == Some("enabled"),
        next_run_at: row
            .due_at
            .filter(|value| !datetime_is_unset(*value))
            .map(utc_datetime),
        last_run_at: metadata
            .last_run_at
            .as_deref()
            .and_then(parse_iso_datetime)
            .map(utc_datetime),
        last_run_status: None,
        version: row.version,
        created_at: row.created_at.map(|value| shifted_datetime(value, 8)),
        updated_at: row.updated_at.map(|value| shifted_datetime(value, 8)),
    })
}

/// One `ProjectAutomationView` row. Field aliases are the camelCase names
/// generated by `ProjectChatSchema` (`_to_camel`).
#[derive(Debug, Serialize)]
struct ProjectAutomationView {
    id: String,
    #[serde(rename = "projectId")]
    project_id: String,
    name: String,
    prompt: String,
    #[serde(rename = "triggerType")]
    trigger_type: String,
    #[serde(rename = "eventType")]
    event_type: Option<String>,
    #[serde(rename = "eventConfig")]
    event_config: Box<RawValue>,
    #[serde(rename = "assignmentMode")]
    assignment_mode: String,
    #[serde(rename = "managerType")]
    manager_type: Option<String>,
    #[serde(rename = "cronExpression")]
    cron_expression: Option<String>,
    timezone: String,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    #[serde(rename = "wegentTeamId")]
    wegent_team_id: Option<i64>,
    model: Option<String>,
    #[serde(rename = "agentName")]
    agent_name: String,
    #[serde(rename = "executionEnvironment")]
    execution_environment: String,
    #[serde(rename = "executionDeviceId")]
    execution_device_id: Option<String>,
    #[serde(rename = "roleSource")]
    role_source: String,
    #[serde(rename = "runtimeSource")]
    runtime_source: String,
    #[serde(rename = "runtimeProfileId")]
    runtime_profile_id: Option<String>,
    #[serde(rename = "runtimeUserId")]
    runtime_user_id: Option<i64>,
    enabled: bool,
    #[serde(rename = "nextRunAt")]
    next_run_at: Option<String>,
    #[serde(rename = "lastRunAt")]
    last_run_at: Option<String>,
    #[serde(rename = "lastRunStatus")]
    last_run_status: Option<String>,
    version: i64,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

/// A raw empty JSON object for the `event_config` default.
fn raw_empty_object() -> Box<RawValue> {
    serde_json::value::to_raw_value(&std::collections::BTreeMap::<String, String>::new())
        .expect("empty object serializes")
}

/// `text(value)` (`project_automation_domain`): a non-empty string value.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

/// `loop_datetime_value_is_unset`: NULL or the 1970-01-01 sentinels.
fn datetime_is_unset(value: NaiveDateTime) -> bool {
    value.format("%Y-%m-%d %H:%M:%S").to_string() == "1970-01-01 00:00:00"
        || value.format("%Y-%m-%d %H:%M:%S").to_string() == "1970-01-01 00:00:01"
}

/// `datetime.fromisoformat` for a metadata `last_run_at` string; only the
/// naive/aware forms the source writes are parsed.
fn parse_iso_datetime(value: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|value| value.naive_utc())
        })
}

/// `_utc_aware(value)` with the default UTC naive timezone, rendered like
/// pydantic: RFC 3339 with the `Z` suffix (microseconds only when nonzero).
fn utc_datetime(value: NaiveDateTime) -> String {
    let base = value.and_utc().format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        format!("{base}Z")
    } else {
        format!("{base}.{:06}Z", value.and_utc().timestamp_subsec_micros())
    }
}

/// `_utc_aware(value, MYSQL_SESSION_TIMEZONE)`: interpret the naive database
/// datetime as UTC+8, convert to UTC, and render with the `Z` suffix.
fn shifted_datetime(value: NaiveDateTime, offset_hours: i32) -> String {
    use chrono::TimeZone as _;
    let shifted = chrono::FixedOffset::east_opt(offset_hours * 3600)
        .expect("valid fixed offset")
        .from_local_datetime(&value)
        .single()
        .expect("database datetime is representable")
        .with_timezone(&chrono::Utc);
    utc_datetime(shifted.naive_utc())
}

/// `get_current_user` failures mapped to the source 401 responses.
fn auth_error(error: AuthFailure) -> FastApiError {
    match error {
        AuthFailure::InvalidCredentials => {
            FastApiError::unauthorized("Could not validate credentials")
        }
        AuthFailure::UserNotActivated => FastApiError::unauthorized("User not activated"),
    }
}

/// Dependency failures mapped to the source 500 response.
fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "cloud-projects automations dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignment_mode_maps_action_values() {
        let mut metadata = RuleMetadata::default();
        assert_eq!(metadata.assignment_mode(), None);
        metadata.action = Some("execute".to_string());
        assert_eq!(metadata.assignment_mode(), Some("manual"));
        metadata.action = Some("ai_assign".to_string());
        assert_eq!(metadata.assignment_mode(), Some("ai_managed"));
        metadata.action = Some("unknown".to_string());
        assert_eq!(metadata.assignment_mode(), None);
    }

    #[test]
    fn manager_type_validates_configured_values() {
        let mut metadata = RuleMetadata::default();
        assert_eq!(metadata.manager_type(), Some(None));
        metadata.manager = Some(ManagerConfig {
            r#type: Some("custom".to_string()),
            wegent_team_id: None,
        });
        assert_eq!(metadata.manager_type(), Some(Some("custom")));
        metadata.manager = Some(ManagerConfig {
            r#type: Some("bogus".to_string()),
            wegent_team_id: None,
        });
        assert_eq!(metadata.manager_type(), None);
    }

    #[test]
    fn metadata_integer_accepts_only_integers() {
        assert_eq!(metadata_integer(None), None);
        assert_eq!(metadata_integer(Some(&serde_json::json!(7))), Some(7));
        assert_eq!(metadata_integer(Some(&serde_json::json!("7"))), None);
        assert_eq!(metadata_integer(Some(&serde_json::json!(1.5))), None);
    }

    #[test]
    fn unset_datetimes_are_detected() {
        assert!(datetime_is_unset(
            NaiveDateTime::parse_from_str("1970-01-01 00:00:00", "%Y-%m-%d %H:%M:%S").unwrap()
        ));
        assert!(datetime_is_unset(
            NaiveDateTime::parse_from_str("1970-01-01 00:00:01", "%Y-%m-%d %H:%M:%S").unwrap()
        ));
        assert!(!datetime_is_unset(
            NaiveDateTime::parse_from_str("2026-09-11 08:49:35", "%Y-%m-%d %H:%M:%S").unwrap()
        ));
    }

    #[test]
    fn utc_datetime_renders_pydantic_shape() {
        let whole =
            NaiveDateTime::parse_from_str("2026-09-11 08:49:35", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(utc_datetime(whole), "2026-09-11T08:49:35Z");
        let micros =
            NaiveDateTime::parse_from_str("2026-09-11 08:49:35.123", "%Y-%m-%d %H:%M:%S%.f")
                .unwrap();
        assert_eq!(utc_datetime(micros), "2026-09-11T08:49:35.123000Z");
    }

    #[test]
    fn shifted_datetime_converts_plus_eight_to_utc() {
        let value =
            NaiveDateTime::parse_from_str("2026-09-11 16:49:35", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(shifted_datetime(value, 8), "2026-09-11T08:49:35Z");
    }

    #[test]
    fn iso_datetime_parses_naive_and_aware() {
        let naive = parse_iso_datetime("2026-09-11T08:49:35").unwrap();
        assert_eq!(
            naive.format("%Y-%m-%d %H:%M:%S").to_string(),
            "2026-09-11 08:49:35"
        );
        let aware = parse_iso_datetime("2026-09-11T08:49:35+00:00").unwrap();
        assert_eq!(
            aware.format("%Y-%m-%d %H:%M:%S").to_string(),
            "2026-09-11 08:49:35"
        );
        assert!(parse_iso_datetime("not a date").is_none());
    }

    #[test]
    fn view_serializes_camel_case_shape() {
        let view = ProjectAutomationView {
            id: "1712605396200092400".to_string(),
            project_id: "1712605396200092385".to_string(),
            name: "rule".to_string(),
            prompt: "do work".to_string(),
            trigger_type: "schedule".to_string(),
            event_type: None,
            event_config: raw_empty_object(),
            assignment_mode: "manual".to_string(),
            manager_type: None,
            cron_expression: None,
            timezone: "Asia/Shanghai".to_string(),
            agent_id: None,
            wegent_team_id: None,
            model: None,
            agent_name: "AI".to_string(),
            execution_environment: "local".to_string(),
            execution_device_id: None,
            role_source: "agent".to_string(),
            runtime_source: "agent_default".to_string(),
            runtime_profile_id: None,
            runtime_user_id: None,
            enabled: true,
            next_run_at: None,
            last_run_at: None,
            last_run_status: None,
            version: 1,
            created_at: Some("2026-09-11T08:49:35Z".to_string()),
            updated_at: Some("2026-09-11T08:49:35Z".to_string()),
        };
        let value = serde_json::to_value(&view).unwrap();
        assert_eq!(value["projectId"], "1712605396200092385");
        assert_eq!(value["triggerType"], "schedule");
        assert_eq!(value["eventConfig"], serde_json::json!({}));
        assert_eq!(value["assignmentMode"], "manual");
        assert_eq!(value["cronExpression"], serde_json::Value::Null);
        assert_eq!(value["agentName"], "AI");
        assert_eq!(value["executionEnvironment"], "local");
        assert_eq!(value["roleSource"], "agent");
        assert_eq!(value["runtimeSource"], "agent_default");
        assert_eq!(value["nextRunAt"], serde_json::Value::Null);
        assert_eq!(value["createdAt"], "2026-09-11T08:49:35Z");
    }
}
