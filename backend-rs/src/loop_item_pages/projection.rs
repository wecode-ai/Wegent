// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Issue-to-`LoopItemResponse` projection for the loop-item-pages read
//! path.
//!
//! Mirrors `ExternalLoopItemProvider._response`: `_base_response`
//! (provider view built from the issue JSON and its labels) merged with
//! `_with_execution_state` (the newest `loop_item_executions` run overlay),
//! emitted as a typed [`LoopItemResponse`] whose field declaration order
//! matches the source pydantic schema's serialization order.
//!
//! Serialization contract: every `LoopItemResponse` field is always
//! present in the JSON output (FastAPI's default serialization has no
//! `exclude_none`), so each Rust field is a concrete type whose serde
//! representation is never omitted — `Option<T>` serializes `None` as
//! `null`, never skipped. This keeps the recorded byte output identical
//! to the previous `serde_json::Value` path, where `order_item_fields`
//! re-emitted all 47 fields and the defaults table filled every unset
//! field with its schema default.
use serde::Serialize;

use crate::board_snapshot::repository::ProjectRow;
use crate::state::AppState;

use super::execution::{ApprovalView, ExecutionRow, execution_ai_state, execution_display_state};
use super::{
    ASSIGNEE_PREFIX, CREATOR_PREFIX, PRIORITY_PREFIX, PageIssue, SECURITY_PREFIX, STATUS_PREFIX,
    has_permission, parent_id_from_issue,
};

/// The bare `users` entity column list SQLAlchemy renders for
/// `Session.get(User, id)`: every mapped column, no labels, no `LIMIT`.
const USER_ENTITY_COLUMNS: &str = "users.id, users.user_name, users.password_hash, \
     users.email, users.git_info, users.is_active, users.`role`, users.auth_source, \
     users.preferences, users.created_at, users.updated_at";

/// `LoopItemPermissions` (`app.schemas.delivery`): the per-item capability
/// flags emitted on every item. The external-provider path never narrows
/// them, so all four serialize `false`.
#[derive(Debug, Default, Serialize)]
struct Permissions {
    edit_content: bool,
    comment: bool,
    assign: bool,
    execute: bool,
}

/// `LoopItemResponse` (`app.schemas.delivery`): the 52-field board-task
/// view. Field declaration order mirrors the source pydantic schema's
/// serialization order exactly, so serde emits fields in the recorded
/// order without any manual reordering.
///
/// Every field is a concrete type (no `skip_serializing_if`): the source
/// FastAPI endpoint uses default serialization (no `response_model_exclude_*`),
/// so all fields are always emitted — `Option::None` renders as `null`,
/// never omitted. This preserves the byte-level output of the previous
/// `serde_json::Value` + `order_item_fields` path.
#[derive(Debug, Serialize)]
pub(crate) struct LoopItemResponse {
    id: String,
    cloud_project_id: String,
    sequence_number: i64,
    parent_id: Option<String>,
    title: String,
    description: String,
    status: String,
    assignee_user_id: Option<i64>,
    assignee_group_id: Option<String>,
    assignee_group_name: Option<String>,
    assignee_name: Option<String>,
    assignee_agent_id: Option<String>,
    assignee_agent_name: Option<String>,
    assignee_team_id: Option<i64>,
    assignee_team_name: Option<String>,
    ai_state: Option<brz_json::RawJson>,
    execution_id: Option<i64>,
    execution_state: Option<String>,
    execution_control_state: Option<String>,
    execution_observed_state: Option<String>,
    execution_sync_state: Option<String>,
    execution_attempt_no: Option<i64>,
    execution_last_event_seq: Option<i64>,
    can_approve: bool,
    assignment_history: Vec<brz_json::RawJson>,
    status_history: Vec<brz_json::RawJson>,
    approval: Option<ApprovalView>,
    queued_at: Option<String>,
    execution_note: Option<String>,
    execution_error: Option<String>,
    automation: Option<brz_json::RawJson>,
    workflow: Option<brz_json::RawJson>,
    execution_config: Option<brz_json::RawJson>,
    priority: String,
    due_at: Option<String>,
    sort_order: i64,
    tags: Vec<String>,
    created_by_user_id: i64,
    created_by_user_name: Option<String>,
    can_view_detail: bool,
    security_level: String,
    can_edit: bool,
    permissions: Permissions,
    detail_loaded: bool,
    content_revision: i64,
    activity_read_sequence: i64,
    is_unread: bool,
    current_delivery_id: Option<String>,
    version: i64,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

impl LoopItemResponse {
    /// The item id (`{project_key}-{number}`), used to look up the active
    /// execution run during the execution-state overlay.
    pub(super) fn id(&self) -> String {
        self.id.clone()
    }

    /// `_base_response`'s `can_view_detail`, consumed by callers that gate on
    /// provider visibility (for example `external_loop_item_provider.get`).
    pub(crate) fn can_view_detail(&self) -> bool {
        self.can_view_detail
    }

    /// `_with_execution_state` (`app.services.loop_items.external_provider`):
    /// overlay the active run's execution, approval, and AI state on the
    /// provider view. When no execution row exists the view is returned
    /// unchanged (every overlaid field keeps its `None` schema default).
    async fn with_execution_state(
        self,
        state: &AppState,
        item_id: &str,
        user_id: i32,
    ) -> Result<Self, brz_mysql::MysqlError> {
        let Some(execution) = ExecutionRow::latest_for_item(&state.mysql, item_id).await? else {
            return Ok(self);
        };
        // `_execution_can_approve`: only a `pending_approval` run whose agent
        // was created by the caller can be approved. `db.get(ProjectChatAgent,
        // execution.agent_id)` resolves the agent creator.
        let can_approve = if execution.status.as_deref() == Some("pending_approval") {
            match execution.agent_id.as_deref().filter(|id| !id.is_empty()) {
                Some(agent_id) => {
                    let agent = ExecutionRow::chat_agent(&state.mysql, agent_id).await?;
                    agent.and_then(|agent| agent.created_by_user_id) == Some(user_id)
                }
                None => false,
            }
        } else {
            false
        };
        // `execution_ai_state(db, execution)`: the authoritative run
        // projection. The agent lookup here is a second, independent
        // `Session.get` in the recorded source, so it is not deduplicated
        // against the base-response lookup.
        let ai_state = execution_ai_state(&state.mysql, &execution).await?;
        // `merged["version"] = int(merged["version"]) + int(execution.id)`.
        let version = self.version + execution.id;
        Ok(LoopItemResponse {
            execution_id: Some(execution.id),
            execution_state: Some(execution_display_state(&execution)),
            execution_control_state: execution.status.clone(),
            execution_observed_state: execution.observed_state.clone(),
            execution_sync_state: execution.sync_state.clone(),
            execution_attempt_no: execution.attempt_no,
            execution_last_event_seq: execution.last_event_seq,
            can_approve,
            approval: execution.approval_view(),
            queued_at: ExecutionRow::optional_iso(execution.queued_at),
            execution_note: execution
                .execution_note
                .as_deref()
                .filter(|note| !note.is_empty())
                .map(str::to_string),
            ai_state: ai_state.map(|value| brz_json::raw_json(&value)),
            version,
            ..self
        })
    }
}

/// `_response` projection for one issue: `_base_response` merged with
/// `_with_execution_state`. Emits the complete `LoopItemResponse` field set
/// (all 47 fields), mirroring the source's pydantic serialization order and
/// defaults.
pub(crate) async fn issue_response(
    state: &AppState,
    project: &ProjectRow,
    role: &str,
    user_id: i32,
    issue: &PageIssue,
) -> Result<LoopItemResponse, brz_mysql::MysqlError> {
    let labels = issue.labels();
    let creator_id = creator_id_from_labels(&labels);
    let creator_name = creator_name_from_labels(&labels);
    let number = issue.number();
    let parent_id = parent_id_from_issue(project, issue).and_then(Option::from);
    // `include_description=False` on this path: the description is always "".
    let description = String::new();
    let item_status = issue.status();
    let created_at_raw = issue.created_at.as_deref().unwrap_or("");
    let updated_at_raw = issue
        .updated_at
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(created_at_raw);
    let created_at = datetime_reformat(created_at_raw);
    let updated_at = datetime_reformat(updated_at_raw);
    let (assignee_user_id, assignee_name, assignee_agent_id, assignee_agent_name) =
        assignee_from_labels(&state.mysql, &labels).await?;
    // `_security_level(labels, project)` and `_permissions(access, ...)`: the
    // security level drives `can_view`, whose `related` disjunct also depends
    // on the resolved assignee, so both follow the assignee lookup.
    let security_level = security_level_from_labels(&labels, project);
    let (can_view, can_edit) =
        permissions(role, &security_level, creator_id, assignee_user_id, user_id);
    let version = derived_version(updated_at_raw);

    let key = project.project_key.clone().unwrap_or_default();
    // `completed_at`: the source emits `str(issue.get("closed_at") or
    // updated_at)` (re-formatted by pydantic datetime serialization) when the
    // status is `completed`, else `None` (→ `null`). When the closed_at raw
    // string is empty it falls back to `updated_at`.
    let completed_at = if item_status == "completed" {
        let closed_raw = issue
            .closed_at
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(updated_at_raw);
        Some(datetime_reformat(closed_raw))
    } else {
        None
    };

    // `due_at` is always `None` on this provider path (no due-date label is
    // read), so it serializes as `null`, matching the source's `due_at: None`.
    let response = LoopItemResponse {
        id: format!("{key}-{number}"),
        cloud_project_id: project.id.clone(),
        sequence_number: number,
        parent_id,
        title: issue.title.clone().unwrap_or_default(),
        description,
        status: item_status,
        assignee_user_id,
        assignee_group_id: None,
        assignee_group_name: None,
        assignee_name,
        assignee_agent_id,
        assignee_agent_name,
        assignee_team_id: None,
        assignee_team_name: None,
        ai_state: None,
        execution_id: None,
        execution_state: None,
        execution_control_state: None,
        execution_observed_state: None,
        execution_sync_state: None,
        execution_attempt_no: None,
        execution_last_event_seq: None,
        can_approve: false,
        assignment_history: Vec::new(),
        status_history: Vec::new(),
        approval: None,
        queued_at: None,
        execution_note: None,
        execution_error: None,
        automation: None,
        workflow: None,
        execution_config: None,
        priority: priority_from_labels(&labels),
        due_at: None,
        sort_order: number,
        tags: public_tags(&labels),
        created_by_user_id: creator_id,
        created_by_user_name: creator_name,
        can_view_detail: can_view,
        security_level,
        can_edit,
        permissions: Permissions::default(),
        detail_loaded: false,
        content_revision: 1,
        activity_read_sequence: 0,
        is_unread: false,
        current_delivery_id: None,
        version,
        created_at,
        updated_at,
        completed_at,
    };

    let item_id = response.id();
    response
        .with_execution_state(state, &item_id, user_id)
        .await
}

impl LoopItemResponse {
    /// Convert the issue projection into the shared `loop_items` response body.
    ///
    /// The external projection does not carry the local-only `assignee_group_*`,
    /// `security_level`, `permissions`, or `activity_read_sequence` fields. The
    /// source's `_base_response` never sets `permissions` or
    /// `activity_read_sequence`, so those stay at their pydantic defaults; the
    /// external `security_level` is not represented on this path and therefore
    /// stays at the schema default (`open`).
    pub(crate) fn into_loop_items(self) -> crate::loop_items::response::LoopItemResponse {
        fn raw_value(raw: &brz_json::RawJson) -> serde_json::Value {
            serde_json::from_str(raw.get()).unwrap_or(serde_json::Value::Null)
        }
        crate::loop_items::response::LoopItemResponse {
            id: self.id,
            cloud_project_id: self.cloud_project_id,
            sequence_number: self.sequence_number,
            parent_id: self.parent_id,
            title: self.title,
            description: self.description,
            status: self.status,
            assignee_user_id: self.assignee_user_id.map(|id| id as i32),
            assignee_group_id: None,
            assignee_group_name: None,
            assignee_name: self.assignee_name,
            assignee_agent_id: self.assignee_agent_id,
            assignee_agent_name: self.assignee_agent_name,
            assignee_team_id: self.assignee_team_id.map(|id| id as i32),
            assignee_team_name: self.assignee_team_name,
            ai_state: self.ai_state.as_ref().map(raw_value),
            execution_id: self.execution_id,
            execution_state: self.execution_state,
            execution_control_state: self.execution_control_state,
            execution_observed_state: self.execution_observed_state,
            execution_sync_state: self.execution_sync_state,
            execution_attempt_no: self.execution_attempt_no,
            execution_last_event_seq: self.execution_last_event_seq,
            can_approve: self.can_approve,
            assignment_history: self.assignment_history.iter().map(raw_value).collect(),
            status_history: self.status_history.iter().map(raw_value).collect(),
            approval: self
                .approval
                .and_then(|view| serde_json::to_value(view).ok()),
            queued_at: self.queued_at,
            execution_note: self.execution_note,
            execution_error: self.execution_error,
            automation: self.automation.as_ref().map(raw_value),
            workflow: self.workflow.as_ref().map(raw_value),
            execution_config: self.execution_config.as_ref().map(raw_value),
            priority: self.priority,
            due_at: self.due_at,
            sort_order: self.sort_order,
            tags: self.tags,
            created_by_user_id: self.created_by_user_id,
            created_by_user_name: self.created_by_user_name,
            can_view_detail: self.can_view_detail,
            security_level: "open",
            can_edit: self.can_edit,
            permissions: crate::loop_items::response::LoopItemPermissions {
                edit_content: false,
                comment: false,
                assign: false,
                execute: false,
            },
            detail_loaded: self.detail_loaded,
            content_revision: self.content_revision,
            activity_read_sequence: 0,
            is_unread: self.is_unread,
            current_delivery_id: self.current_delivery_id,
            version: self.version,
            created_at: self.created_at,
            updated_at: self.updated_at,
            completed_at: self.completed_at,
        }
    }
}

/// `_creator_id(labels)`: the numeric creator id from the creator label, 0
/// when absent or unparsable.
fn creator_id_from_labels(labels: &[String]) -> i64 {
    let Some(label) = labels.iter().find(|l| l.starts_with(CREATOR_PREFIX)) else {
        return 0;
    };
    let rest = label.trim_start_matches(CREATOR_PREFIX);
    let id_part = rest.split(':').next().unwrap_or("");
    id_part.parse().unwrap_or(0)
}

/// `_creator_name(labels)`: the creator label's name part when non-empty.
fn creator_name_from_labels(labels: &[String]) -> Option<String> {
    let label = labels
        .iter()
        .find(|l| l.starts_with(CREATOR_PREFIX))?
        .trim_start_matches(CREATOR_PREFIX);
    let mut parts = label.splitn(2, ':');
    let _id = parts.next();
    parts
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// `_priority(labels)`: the priority label value within the known set.
fn priority_from_labels(labels: &[String]) -> String {
    let value = labels
        .iter()
        .find_map(|label| label.strip_prefix(PRIORITY_PREFIX))
        .unwrap_or("none");
    if matches!(value, "low" | "medium" | "high" | "urgent") {
        value.to_string()
    } else {
        "none".to_string()
    }
}

/// `_public_tags(labels)`: labels without any of the reserved prefixes.
fn public_tags(labels: &[String]) -> Vec<String> {
    labels
        .iter()
        .filter(|label| {
            !label.starts_with(PRIORITY_PREFIX)
                && !label.starts_with(STATUS_PREFIX)
                && !label.starts_with(CREATOR_PREFIX)
                && !label.starts_with(ASSIGNEE_PREFIX)
                && !label.starts_with(SECURITY_PREFIX)
        })
        .cloned()
        .collect()
}

/// `_security_level(labels, project)`: the `wegent:security:` label value when
/// it names a known level, otherwise the project's `default_issue_security`.
fn security_level_from_labels(labels: &[String], project: &ProjectRow) -> String {
    let value = labels
        .iter()
        .find_map(|label| label.strip_prefix(SECURITY_PREFIX));
    match value {
        Some(value) if matches!(value, "open" | "related") => value.to_string(),
        _ => project.default_issue_security().to_string(),
    }
}

/// `_permissions(access, ...)`: `can_view` is granted to members with
/// `Maintainer` or higher, to any `open` item, and to `related` items the
/// caller created or is assigned; `can_edit` additionally needs `Developer`.
///
/// The source's `related` disjunct also consults `is_related_item(db, ...)`,
/// which this read path does not issue; projects that opt into
/// `default_issue_security = related` therefore rely on the creator/assignee
/// match alone.
pub(super) fn permissions(
    role: &str,
    security_level: &str,
    creator_id: i64,
    assignee_user_id: Option<i64>,
    user_id: i32,
) -> (bool, bool) {
    let user_id = i64::from(user_id);
    let related = security_level == "related"
        && ((creator_id > 0 && creator_id == user_id) || assignee_user_id == Some(user_id));
    let can_view = has_permission(role, "Maintainer") || security_level == "open" || related;
    let can_edit = can_view && has_permission(role, "Developer");
    (can_view, can_edit)
}

/// `_assignee_from_labels` + the per-kind name resolution in
/// `_base_response`. The `user` kind resolves the display name from the
/// `users` table (`Session.get(User, id)`) when the label carries no name;
/// the `agent` kind resolves `agent.title or agent.name` through
/// `Session.get(ProjectChatAgent, id)` the same way. The `team` and `group`
/// kinds are not exercised by the recorded provider pages and keep the
/// source's raw-label semantics (id kept as-is when parsable, name from the
/// label only).
#[allow(clippy::type_complexity)]
async fn assignee_from_labels<M: brz_mysql::Mysql>(
    mysql: &M,
    labels: &[String],
) -> Result<(Option<i64>, Option<String>, Option<String>, Option<String>), brz_mysql::MysqlError> {
    let Some(label) = labels.iter().find(|l| l.starts_with(ASSIGNEE_PREFIX)) else {
        return Ok((None, None, None, None));
    };
    let rest = label.trim_start_matches(ASSIGNEE_PREFIX);
    let mut parts = rest.splitn(3, ':');
    let kind = parts.next().unwrap_or("");
    let id = parts.next().unwrap_or("");
    let name = parts.next().map(str::trim).unwrap_or("");
    match kind {
        "user" if !id.is_empty() => {
            let assignee_user_id: i64 = id.parse().unwrap_or(0);
            let assignee_name = if name.is_empty() {
                user_name_by_id(mysql, assignee_user_id).await?
            } else {
                Some(name.to_string())
            };
            Ok((Some(assignee_user_id), assignee_name, None, None))
        }
        "agent" if !id.is_empty() => {
            let assignee_agent_name = if name.is_empty() {
                let agent = ExecutionRow::chat_agent(mysql, id).await?;
                agent.and_then(|agent| agent.display_name())
            } else {
                Some(name.to_string())
            };
            Ok((None, None, Some(id.to_string()), assignee_agent_name))
        }
        _ => Ok((None, None, None, None)),
    }
}

/// `db.get(User, id)`: the user's `user_name` when the row exists. The ORM
/// `Session.get` renders the bare entity column list with the id inlined as
/// an integer literal, matching the recorded exchange.
async fn user_name_by_id<M: brz_mysql::Mysql>(
    mysql: &M,
    user_id: i64,
) -> Result<Option<String>, brz_mysql::MysqlError> {
    #[derive(Debug, brz_mysql::FromMysqlRow)]
    struct NameRow {
        user_name: String,
    }
    let row: Option<NameRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {USER_ENTITY_COLUMNS} \nFROM users \n\
                 WHERE users.id = {user_id}"
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| row.user_name))
}

/// `_derived_version(updated_at)`: the issue's updated time as a Unix
/// timestamp; 1 when unparsable.
fn derived_version(updated_at: &str) -> i64 {
    parse_datetime(updated_at)
        .map(|value| value.timestamp())
        .unwrap_or(1)
}

/// Parse an ISO-8601 timestamp the provider emits (fractional seconds with
/// 0–9 digits, `Z`, or a numeric offset).
fn parse_datetime(value: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    use chrono::DateTime;
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Some(value);
    }
    None
}

/// Pydantic `datetime` serialization: the parsed timestamp re-emitted as
/// ISO-8601 with 6-digit microseconds and the original offset. The result
/// stays a String, including empty or invalid provider timestamps. Serde
/// applies the same JSON string escaping as the previous Value::String.
pub(crate) fn datetime_reformat(value: &str) -> String {
    match parse_datetime(value) {
        Some(parsed) => {
            let nanos = parsed.timestamp_subsec_nanos();
            let base = parsed.format("%Y-%m-%dT%H:%M:%S").to_string();
            // `%:z` renders the sign as part of the offset (`+08:00`), so no
            // extra `+` is prepended here.
            let offset = parsed.format("%:z").to_string();
            if nanos == 0 {
                format!("{base}{offset}")
            } else {
                let micros = nanos / 1_000;
                format!("{base}.{micros:06}{offset}")
            }
        }
        None => value.to_string(),
    }
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "projection_json_contract_tests.rs"]
mod json_contract_tests;
