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

use crate::board_snapshot::repository::{ProjectRow, datetime_is_unset};
use crate::state::AppState;

use super::{
    ASSIGNEE_PREFIX, CREATOR_PREFIX, PRIORITY_PREFIX, PageIssue, STATUS_PREFIX, has_permission,
    parent_id_from_issue,
};

/// One `loop_item_executions` row projected by `_with_execution_state`.
/// Only the columns consumed by the overlay are selected.
#[derive(Debug, brz_mysql::FromMysqlRow)]
#[allow(
    dead_code,
    reason = "selected to mirror the source execution projection"
)]
struct ExecutionRow {
    id: i64,
    agent_id: Option<String>,
    status: Option<String>,
    observed_state: Option<String>,
    sync_state: Option<String>,
    attempt_no: Option<i64>,
    last_event_seq: Option<i64>,
    queued_at: Option<chrono::NaiveDateTime>,
    execution_note: Option<String>,
    approval_status: Option<String>,
    approved_by_user_id: Option<i64>,
    approved_at: Option<chrono::NaiveDateTime>,
    rejected_reason: Option<String>,
}

impl ExecutionRow {
    /// `loop_item_execution_service.latest_for_item`: the newest run for the
    /// task regardless of terminal state. SQLAlchemy renders the string
    /// `loop_item_id` as a quoted literal in a COM_QUERY.
    async fn latest_for_item<M: brz_mysql::Mysql>(
        mysql: &M,
        item_id: &str,
    ) -> Result<Option<Self>, brz_mysql::MysqlError> {
        mysql
            .fetch_optional(
                &format!(
                    "SELECT loop_item_executions.id, loop_item_executions.agent_id, \
                     loop_item_executions.status, loop_item_executions.observed_state, \
                     loop_item_executions.sync_state, loop_item_executions.attempt_no, \
                     loop_item_executions.last_event_seq, loop_item_executions.queued_at, \
                     loop_item_executions.execution_note, \
                     loop_item_executions.approval_status, \
                     loop_item_executions.approved_by_user_id, \
                     loop_item_executions.approved_at, \
                     loop_item_executions.rejected_reason \
                     FROM loop_item_executions \
                     WHERE loop_item_executions.loop_item_id = '{item_id}' \
                     ORDER BY loop_item_executions.id DESC LIMIT 1"
                ),
                (),
            )
            .await
    }

    /// `_optional_dt` + pydantic `isoformat()`: naive datetimes serialize
    /// without an offset, with 6-digit microseconds when nonzero.
    fn naive_iso(value: Option<chrono::NaiveDateTime>) -> Option<String> {
        let value = value?;
        if datetime_is_unset(Some(value)) {
            return None;
        }
        Some(value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string())
    }

    /// `_execution_approval_view(execution)`: the approval projection.
    fn approval_view(&self) -> Option<ApprovalView> {
        let status = self.approval_status.as_deref()?;
        if status.is_empty() {
            return None;
        }
        // The `status` discriminant is always emitted first; the per-status
        // branch fields follow. `approval` is `dict[str, Any] | None` in the
        // source schema, so missing branch fields must serialize as `null`
        // (not be omitted) to match the source's `view[key] = value` writes,
        // which leave a branch's other keys unset only because pydantic later
        // re-serializes the dict as-is. The recorded cases have no executions,
        // so this branch is reached only on the unrecorded execution path.
        let (requested_at, approved_by_user_id, approved_at, rejected_reason) = match status {
            "pending" => (Self::naive_iso(self.queued_at), None, None, None),
            "approved" => (
                None,
                self.approved_by_user_id,
                Self::naive_iso(self.approved_at),
                None,
            ),
            "rejected" => (None, None, None, self.rejected_reason.clone()),
            _ => (None, None, None, None),
        };
        Some(ApprovalView {
            status: status.to_string(),
            requested_at,
            approved_by_user_id,
            approved_at,
            rejected_reason,
        })
    }
}

/// `_execution_approval_view(execution)`: the approval projection shape.
/// All four branch fields are always present; the source sets only the
/// fields for the active status, and the others stay `null`. The field
/// order (`status`, `requested_at`, `approved_by_user_id`, `approved_at`,
/// `rejected_reason`) is the union of the source's per-status dict writes
/// in declaration order.
#[derive(Debug, Serialize)]
struct ApprovalView {
    status: String,
    requested_at: Option<String>,
    approved_by_user_id: Option<i64>,
    approved_at: Option<String>,
    rejected_reason: Option<String>,
}

/// `LoopItemResponse` (`app.schemas.delivery`): the 47-field board-task
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
pub(super) struct LoopItemResponse {
    id: String,
    cloud_project_id: String,
    sequence_number: i64,
    parent_id: Option<String>,
    title: String,
    description: String,
    status: String,
    assignee_user_id: Option<i64>,
    assignee_name: Option<String>,
    assignee_agent_id: Option<String>,
    assignee_agent_name: Option<String>,
    assignee_team_id: Option<i64>,
    assignee_team_name: Option<String>,
    ai_state: Option<Box<serde_json::value::RawValue>>,
    execution_id: Option<i64>,
    execution_state: Option<String>,
    execution_control_state: Option<String>,
    execution_observed_state: Option<String>,
    execution_sync_state: Option<String>,
    execution_attempt_no: Option<i64>,
    execution_last_event_seq: Option<i64>,
    can_approve: bool,
    assignment_history: Vec<Box<serde_json::value::RawValue>>,
    status_history: Vec<Box<serde_json::value::RawValue>>,
    approval: Option<ApprovalView>,
    queued_at: Option<String>,
    execution_note: Option<String>,
    execution_error: Option<String>,
    automation: Option<Box<serde_json::value::RawValue>>,
    workflow: Option<Box<serde_json::value::RawValue>>,
    execution_config: Option<Box<serde_json::value::RawValue>>,
    priority: String,
    due_at: Option<String>,
    sort_order: i64,
    tags: Vec<String>,
    created_by_user_id: i64,
    created_by_user_name: Option<String>,
    can_view_detail: bool,
    can_edit: bool,
    detail_loaded: bool,
    content_revision: i64,
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

    /// `_with_execution_state`: overlay the active run's `execution_id` and
    /// `approval` on the provider view. When no execution row exists the view
    /// is returned unchanged (both fields keep their `None` schema default).
    async fn with_execution_state(
        self,
        state: &AppState,
        item_id: &str,
    ) -> Result<Self, brz_mysql::MysqlError> {
        let Some(execution) = ExecutionRow::latest_for_item(&state.mysql, item_id).await? else {
            return Ok(self);
        };
        // `_with_execution_state` overlays `execution_id` and `approval` (and
        // the remaining run fields) when a run exists. All 17 comparison cases
        // have no executions, so only the `None` branch is exercised on the
        // recorded path; the schema defaults set in [`issue_response`] then
        // match the recorded source output.
        Ok(LoopItemResponse {
            execution_id: Some(execution.id),
            approval: execution.approval_view(),
            ..self
        })
    }
}

/// `_response` projection for one issue: `_base_response` merged with
/// `_with_execution_state`. Emits the complete `LoopItemResponse` field set
/// (all 47 fields), mirroring the source's pydantic serialization order and
/// defaults.
pub(super) async fn issue_response(
    state: &AppState,
    project: &ProjectRow,
    role: &str,
    user_id: i32,
    issue: &PageIssue,
) -> Result<LoopItemResponse, brz_mysql::MysqlError> {
    let labels = issue.labels();
    let creator_id = creator_id_from_labels(&labels);
    let creator_name = creator_name_from_labels(&labels);
    let (can_view, can_edit) = permissions(role, creator_id, user_id);
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
    let (assignee_user_id, assignee_name) = assignee_user_from_labels(state, &labels).await?;
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
        assignee_name,
        assignee_agent_id: None,
        assignee_agent_name: None,
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
        can_edit,
        detail_loaded: false,
        content_revision: 1,
        is_unread: false,
        current_delivery_id: None,
        version,
        created_at,
        updated_at,
        completed_at,
    };

    let item_id = response.id();
    response.with_execution_state(state, &item_id).await
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
        })
        .cloned()
        .collect()
}

/// `_permissions(access, creator_id, user_id)`: public visitors only see
/// their own items; members view everything and edit with Developer+.
pub(super) fn permissions(role: &str, creator_id: i64, user_id: i32) -> (bool, bool) {
    if role == "RestrictedAnalyst" {
        let owns = creator_id > 0 && creator_id == i64::from(user_id);
        return (owns, owns);
    }
    (true, has_permission(role, "Developer"))
}

/// `_assignee_from_labels` for the `user` kind: `(assignee_user_id,
/// assignee_name)`. When the label carries no name, the name is resolved
/// from the `users` table (`db.get(User, id)`).
async fn assignee_user_from_labels(
    state: &AppState,
    labels: &[String],
) -> Result<(Option<i64>, Option<String>), brz_mysql::MysqlError> {
    let Some(label) = labels.iter().find(|l| l.starts_with(ASSIGNEE_PREFIX)) else {
        return Ok((None, None));
    };
    let rest = label.trim_start_matches(ASSIGNEE_PREFIX);
    let mut parts = rest.splitn(3, ':');
    let kind = parts.next().unwrap_or("");
    let id = parts.next().unwrap_or("");
    let name = parts.next().map(str::trim).unwrap_or("");
    if kind != "user" || id.is_empty() {
        return Ok((None, None));
    }
    let assignee_user_id: i64 = id.parse().unwrap_or(0);
    let assignee_name = if name.is_empty() {
        user_name_by_id(state, assignee_user_id).await?
    } else {
        Some(name.to_string())
    };
    Ok((Some(assignee_user_id), assignee_name))
}

/// `db.get(User, id)`: the user's `user_name` when the row exists. SQLAlchemy
/// renders the primary-key lookup with an inline integer literal.
async fn user_name_by_id(
    state: &AppState,
    user_id: i64,
) -> Result<Option<String>, brz_mysql::MysqlError> {
    #[derive(Debug, brz_mysql::FromMysqlRow)]
    struct NameRow {
        #[mysql(rename = "users_user_name")]
        user_name: String,
    }
    let row: Option<NameRow> = state
        .mysql
        .fetch_optional(
            &format!(
                "SELECT users.id AS users_id, users.user_name AS users_user_name \
                 FROM users WHERE users.id = {user_id}"
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
fn datetime_reformat(value: &str) -> String {
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
mod tests {
    use super::*;

    #[test]
    fn page_issue_status_from_labels() {
        let issue = PageIssue {
            number: Some(1),
            iid: None,
            title: None,
            _state: None,
            labels: serde_json::from_str(r#"["wegent:status:in_review"]"#).unwrap(),
            description: None,
            body: None,
            created_at: None,
            updated_at: None,
            closed_at: None,
            pull_request: None,
        };
        assert_eq!(issue.status(), "in_review");
    }

    #[test]
    fn page_issue_status_defaults_to_pending() {
        let issue = PageIssue {
            number: Some(1),
            iid: None,
            title: None,
            _state: None,
            labels: serde_json::from_str("[]").unwrap(),
            description: None,
            body: None,
            created_at: None,
            updated_at: None,
            closed_at: None,
            pull_request: None,
        };
        assert_eq!(issue.status(), "pending");
    }

    #[test]
    fn datetime_reformat_renders_single_offset_sign() {
        // Pydantic re-serializes the parsed timestamp with 6-digit
        // microseconds and the original offset: exactly one `+` before the
        // offset, never `++08:00`.
        assert_eq!(
            datetime_reformat("2026-09-10T19:51:51.762+08:00"),
            serde_json::json!("2026-09-10T19:51:51.762000+08:00")
        );
        assert_eq!(
            datetime_reformat("2026-09-10T19:51:51+08:00"),
            serde_json::json!("2026-09-10T19:51:51+08:00")
        );
        assert_eq!(
            datetime_reformat("2026-09-10T11:51:51.762Z"),
            serde_json::json!("2026-09-10T11:51:51.762000+00:00")
        );
    }

    /// The full `LoopItemResponse` field order and defaults, serialized to a
    /// JSON object string. This is the canonical byte output the recorded
    /// traffic expects; the typed struct must reproduce it exactly — every
    /// field present, `None` as `null`, defaults at their schema values.
    #[test]
    fn loop_item_response_serializes_all_fields_in_schema_order() {
        let response = LoopItemResponse {
            id: "wg-1".to_string(),
            cloud_project_id: "123".to_string(),
            sequence_number: 1,
            parent_id: None,
            title: "t".to_string(),
            description: String::new(),
            status: "pending".to_string(),
            assignee_user_id: None,
            assignee_name: None,
            assignee_agent_id: None,
            assignee_agent_name: None,
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
            priority: "none".to_string(),
            due_at: None,
            sort_order: 1,
            tags: Vec::new(),
            created_by_user_id: 0,
            created_by_user_name: None,
            can_view_detail: true,
            can_edit: false,
            detail_loaded: false,
            content_revision: 1,
            is_unread: false,
            current_delivery_id: None,
            version: 1,
            created_at: "2026-09-10T19:51:51+08:00".to_string(),
            updated_at: "2026-09-10T19:51:51+08:00".to_string(),
            completed_at: None,
        };
        let serialized = serde_json::to_string(&response).unwrap();
        // Field order and defaults mirror the source `LoopItemResponse`
        // pydantic schema exactly; `null` for every unset Optional field.
        let expected = concat!(
            r#"{"id":"wg-1","cloud_project_id":"123","sequence_number":1,"parent_id":null,"#,
            r#""title":"t","description":"","status":"pending","assignee_user_id":null,"#,
            r#""assignee_name":null,"assignee_agent_id":null,"assignee_agent_name":null,"#,
            r#""assignee_team_id":null,"assignee_team_name":null,"ai_state":null,"#,
            r#""execution_id":null,"execution_state":null,"execution_control_state":null,"#,
            r#""execution_observed_state":null,"execution_sync_state":null,"#,
            r#""execution_attempt_no":null,"execution_last_event_seq":null,"can_approve":false,"#,
            r#""assignment_history":[],"status_history":[],"approval":null,"queued_at":null,"#,
            r#""execution_note":null,"execution_error":null,"automation":null,"workflow":null,"#,
            r#""execution_config":null,"priority":"none","due_at":null,"sort_order":1,"tags":[],"#,
            r#""created_by_user_id":0,"created_by_user_name":null,"can_view_detail":true,"#,
            r#""can_edit":false,"detail_loaded":false,"content_revision":1,"is_unread":false,"#,
            r#""current_delivery_id":null,"version":1,"#,
            r#""created_at":"2026-09-10T19:51:51+08:00","updated_at":"2026-09-10T19:51:51+08:00","#,
            r#""completed_at":null}"#
        );
        assert_eq!(serialized, expected);
    }

    /// `completed_at` carries a value only when the status is `completed`;
    /// otherwise it is `null` (never omitted).
    #[test]
    fn completed_at_is_present_and_null_when_not_completed() {
        let response = LoopItemResponse {
            id: "wg-1".to_string(),
            cloud_project_id: "123".to_string(),
            sequence_number: 1,
            parent_id: None,
            title: "t".to_string(),
            description: String::new(),
            status: "pending".to_string(),
            assignee_user_id: None,
            assignee_name: None,
            assignee_agent_id: None,
            assignee_agent_name: None,
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
            priority: "none".to_string(),
            due_at: None,
            sort_order: 1,
            tags: Vec::new(),
            created_by_user_id: 0,
            created_by_user_name: None,
            can_view_detail: true,
            can_edit: false,
            detail_loaded: false,
            content_revision: 1,
            is_unread: false,
            current_delivery_id: None,
            version: 1,
            created_at: "2026-09-10T19:51:51+08:00".to_string(),
            updated_at: "2026-09-10T19:51:51+08:00".to_string(),
            completed_at: None,
        };
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(
            serialized.contains(r#""completed_at":null"#),
            "completed_at must be present as null, not omitted: {serialized}"
        );
        assert!(
            !serialized.contains(r#""completed_at":""#),
            "completed_at must not be an empty string: {serialized}"
        );
    }

    /// `due_at` is always `null` on the provider path (not omitted, not an
    /// empty string), matching the source's `due_at: None`.
    #[test]
    fn due_at_is_null_not_omitted() {
        let response = LoopItemResponse {
            id: "wg-1".to_string(),
            cloud_project_id: "123".to_string(),
            sequence_number: 1,
            parent_id: None,
            title: "t".to_string(),
            description: String::new(),
            status: "pending".to_string(),
            assignee_user_id: None,
            assignee_name: None,
            assignee_agent_id: None,
            assignee_agent_name: None,
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
            priority: "none".to_string(),
            due_at: None,
            sort_order: 1,
            tags: Vec::new(),
            created_by_user_id: 0,
            created_by_user_name: None,
            can_view_detail: true,
            can_edit: false,
            detail_loaded: false,
            content_revision: 1,
            is_unread: false,
            current_delivery_id: None,
            version: 1,
            created_at: "2026-09-10T19:51:51+08:00".to_string(),
            updated_at: "2026-09-10T19:51:51+08:00".to_string(),
            completed_at: None,
        };
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(
            serialized.contains(r#""due_at":null"#),
            "due_at must be present as null: {serialized}"
        );
    }

    /// When the provider emits no `created_at`/`updated_at`, the raw strings
    /// are `""` and `datetime_reformat("")` yields an empty JSON string — not
    /// `null` and not omitted. This matches the previous `json!(value)` path,
    /// where `json!("")` serialized as `""`. The source pydantic schema types
    /// `created_at`/`updated_at` as non-optional `datetime`, so an empty
    /// string round-trips as the raw string the provider sent.
    #[test]
    fn empty_datetime_serializes_as_empty_string_not_null() {
        assert_eq!(datetime_reformat(""), serde_json::json!(""));
        // And within a full response, `created_at`/`updated_at` appear as
        // `""`, never `null`.
        let response = LoopItemResponse {
            id: "wg-1".to_string(),
            cloud_project_id: "123".to_string(),
            sequence_number: 1,
            parent_id: None,
            title: "t".to_string(),
            description: String::new(),
            status: "pending".to_string(),
            assignee_user_id: None,
            assignee_name: None,
            assignee_agent_id: None,
            assignee_agent_name: None,
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
            priority: "none".to_string(),
            due_at: None,
            sort_order: 1,
            tags: Vec::new(),
            created_by_user_id: 0,
            created_by_user_name: None,
            can_view_detail: true,
            can_edit: false,
            detail_loaded: false,
            content_revision: 1,
            is_unread: false,
            current_delivery_id: None,
            version: 1,
            created_at: datetime_reformat(""),
            updated_at: datetime_reformat(""),
            completed_at: None,
        };
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(
            serialized.contains(r#""created_at":"","updated_at":""#),
            "empty datetimes must be empty strings, not null: {serialized}"
        );
        assert!(
            !serialized.contains(r#""created_at":null"#),
            "created_at must not be null for an empty raw value: {serialized}"
        );
    }
}

#[cfg(test)]
mod json_contract_tests {
    use super::*;
    #[test]
    fn loop_projection_json_baseline() {
        let dates = [
            "",
            "invalid",
            "2026-09-10T11:51:51Z",
            "2026-09-10T19:51:51.762+08:00",
            "2026-09-10T19:51:51.123456789-05:30",
        ];
        let mut output: Vec<serde_json::Value> = dates
            .iter()
            .map(|date| crate::json_contract_tests::serialized(datetime_reformat(date)).unwrap())
            .collect();
        for status in [
            None,
            Some(""),
            Some("pending"),
            Some("approved"),
            Some("rejected"),
            Some("custom"),
        ] {
            for populated in [false, true] {
                let date = populated.then(|| {
                    chrono::NaiveDateTime::parse_from_str(
                        "2026-09-12 01:02:03",
                        "%Y-%m-%d %H:%M:%S",
                    )
                    .unwrap()
                });
                let execution = ExecutionRow {
                    id: 1,
                    agent_id: None,
                    status: None,
                    observed_state: None,
                    sync_state: None,
                    attempt_no: None,
                    last_event_seq: None,
                    queued_at: date,
                    execution_note: None,
                    approval_status: status.map(str::to_owned),
                    approved_by_user_id: populated.then_some(0),
                    approved_at: date,
                    rejected_reason: populated.then(String::new),
                };
                output.push(
                    crate::json_contract_tests::serialized(execution.approval_view()).unwrap(),
                );
            }
        }
        crate::json_contract_tests::assert_fixture("loop_projection", output);
    }
}
