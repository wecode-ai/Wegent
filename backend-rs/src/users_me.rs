// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Current-user response with public preference defaults and an optional
//! application-supplied profile extension. Missing credentials return 401.
use serde::Deserialize;
#[cfg(test)]
use serde_json::json;

use crate::auth::{UserRow, get_current_user};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// GET /api/users/me: the users-me free function, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/users/me")]
async fn read_current_user(
    #[inject(state)] state: &AppState,
    #[header] authorization: Option<&str>,
) -> Result<brz_http_server::HttpResponse<brz_http_server::Binary>, FastApiError> {
    users_me(state, authorization).await
}

/// Handler body for `GET /api/users/me`.
async fn users_me(
    state: &AppState,
    authorization: Option<&str>,
) -> Result<brz_http_server::HttpResponse<brz_http_server::Binary>, FastApiError> {
    // `get_current_user_optional`: a missing or invalid token returns
    // `None` and the handler raises its own 401 (the startup-loaded admin
    // bootstrap state is not required here, so the 400 branch cannot fire).
    // The optional scheme maps inactive users to `None` as well; the
    // handler then raises the same 401.
    let user = match get_current_user(&state.auth, &state.mysql, authorization).await {
        Ok(user) => user,
        Err(_) => return Err(missing_credentials()),
    };

    // `admin_setup_completed` is only read for the initial `admin` user
    // (`current_user.user_name == "admin"`); every other user keeps the
    // model default `None`.
    let body = user_in_db_response_with_extra(&user, state.user_profile.current_user_ext(&user));

    Ok(brz_http_server::HttpResponse::new(
        brz_http_server::Binary::new(serde_json::to_vec(&body).unwrap_or_default()),
    ))
}

/// The handler's 401 for a `None` current user: `HTTPException(401,
/// "Missing authentication credentials", WWW-Authenticate: Bearer)`.
fn missing_credentials() -> FastApiError {
    FastApiError::unauthorized("Missing authentication credentials")
}

/// `_build_user_response` + pydantic `UserInDB` serialization: field order
/// follows the model declaration (`UserBase` then `UserInDB`).
#[derive(serde::Serialize)]
pub struct UserView {
    user_name: String,
    email: Option<String>,
    is_active: bool,
    id: i32,
    git_info: Option<Vec<GitInfoEntry>>,
    preferences: Option<PreferencesResponse>,
    role: String,
    auth_source: String,
    #[serde(flatten)]
    extra: crate::user_profile::ErasedFields,
    created_at: String,
    updated_at: String,
    admin_setup_completed: Option<bool>,
}

pub(crate) fn user_in_db_response(user: &UserRow) -> UserView {
    user_in_db_response_with_extra(user, crate::user_profile::UserViewExt::empty())
}

pub(crate) fn user_in_db_response_with_extra(
    user: &UserRow,
    extra: crate::user_profile::UserViewExt,
) -> UserView {
    let (top_level_extra, preference_extra) = extra.into_parts();
    UserView {
        user_name: user.user_name.clone(),
        email: user.email.clone(),
        is_active: user.is_active != 0,
        id: user.id,
        git_info: git_info_view(user),
        preferences: preferences_view(&user.preferences, preference_extra),
        role: user.role.clone(),
        auth_source: user.auth_source.clone(),
        extra: top_level_extra,
        created_at: pydantic_datetime(user.created_at),
        updated_at: pydantic_datetime(user.updated_at),
        admin_setup_completed: None,
    }
}

/// The `UserPreferences`-modeled preference keys the response echoes.
/// Dynamic-keyed objects (`quick_access`,
/// `wework_project_work_preferences`, `runtime_configs`, `options`) echo
/// their stored JSON verbatim through [`RawEcho`].
#[derive(Debug, Default, Deserialize)]
struct EchoedPreferences {
    #[serde(default)]
    employee_id: Option<String>,
    #[serde(default)]
    send_key: Option<String>,
    #[serde(default)]
    search_key: Option<String>,
    #[serde(default)]
    memory_enabled: Option<bool>,
    #[serde(default)]
    chat_status_items: Option<Vec<String>>,
    #[serde(default)]
    tool_output_guard_enabled: Option<bool>,
    #[serde(default)]
    quick_access: Option<RawEcho>,
    #[serde(default)]
    default_execution_target: Option<String>,
    #[serde(default)]
    wework_new_chat_model_selection: Option<ModelSelectionPreference>,
    #[serde(default)]
    wework_project_execution_mode: Option<String>,
    #[serde(default)]
    wework_project_work_preferences: Option<RawEcho>,
    #[serde(default)]
    runtime_configs: Option<RawEcho>,
}

/// `UserModelSelectionPreference`: `modelName`, `modelType`, `options`.
#[derive(Debug, Deserialize)]
struct ModelSelectionPreference {
    #[serde(rename = "modelName", default)]
    model_name: Option<String>,
    #[serde(rename = "modelType", default)]
    model_type: Option<String>,
    #[serde(default)]
    options: Option<RawEcho>,
}

/// A raw JSON document echoed verbatim through `raw_value` (dynamic keys,
/// no materialized dynamic value). Deserialization captures the exact
/// stored serialization, which re-emits byte-identical JSON.
#[derive(Debug, Clone)]
struct RawEcho(Box<serde_json::value::RawValue>);

impl<'de> Deserialize<'de> for RawEcho {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Box::<serde_json::value::RawValue>::deserialize(deserializer).map(RawEcho)
    }
}

impl serde::Serialize for RawEcho {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

/// `UserPreferences`'s serialized shape: known fields keep their stored
/// non-null value or fall back to the schema default; unknown fields are
/// dropped; nested dict fields coerce to `{}` when absent. A
/// `null`-rendering stored string (`None`/`""`/`"null"`/invalid JSON/empty
/// object) serializes the whole field as `null`.
#[derive(serde::Serialize)]
struct PreferencesResponse {
    employee_id: Option<String>,
    send_key: String,
    search_key: String,
    memory_enabled: bool,
    chat_status_items: Option<Vec<String>>,
    tool_output_guard_enabled: bool,
    mcp_provider_keys: Option<RawEcho>,
    quick_access: Option<RawEcho>,
    default_execution_target: Option<String>,
    wework_new_chat_model_selection: Option<ModelSelectionResponse>,
    wework_project_execution_mode: String,
    #[serde(flatten)]
    extra: crate::user_profile::ErasedFields,
    wework_project_work_preferences: RawEcho,
    runtime_configs: RawEcho,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelSelectionResponse {
    model_name: Option<String>,
    model_type: Option<String>,
    options: RawEcho,
}

fn preferences_view(
    raw: &str,
    extra: crate::user_profile::ErasedFields,
) -> Option<PreferencesResponse> {
    if raw.is_empty() || raw == "null" || raw == "{}" {
        return None;
    }
    let source = serde_json::from_str::<EchoedPreferences>(raw).ok()?;
    let selection =
        source
            .wework_new_chat_model_selection
            .map(|selection| ModelSelectionResponse {
                model_name: selection.model_name,
                model_type: selection.model_type,
                options: selection.options.unwrap_or_else(empty_object_echo),
            });
    Some(PreferencesResponse {
        employee_id: source.employee_id,
        send_key: source.send_key.unwrap_or_else(|| "enter".to_string()),
        search_key: source.search_key.unwrap_or_else(|| "cmd_k".to_string()),
        memory_enabled: source.memory_enabled.unwrap_or(false),
        chat_status_items: source.chat_status_items,
        tool_output_guard_enabled: source.tool_output_guard_enabled.unwrap_or(false),
        mcp_provider_keys: None,
        quick_access: source.quick_access,
        default_execution_target: source.default_execution_target,
        wework_new_chat_model_selection: selection,
        wework_project_execution_mode: source
            .wework_project_execution_mode
            .unwrap_or_else(|| "current_workspace".to_string()),
        extra,
        wework_project_work_preferences: source
            .wework_project_work_preferences
            .unwrap_or_else(empty_object_echo),
        runtime_configs: source.runtime_configs.unwrap_or_else(empty_object_echo),
    })
}

/// The `{}` document for a schema-defaulted nested dict field
/// (`default_factory=dict`).
fn empty_object_echo() -> RawEcho {
    RawEcho(serde_json::value::RawValue::from_string("{}".to_string()).expect("valid JSON"))
}

/// `git_info: Optional[List[GitInfo]]`: JSON `null` (the recorded column)
/// renders as `null`; a list validates each entry against the `GitInfo`
/// schema, materializing every optional field with its stored value or an
/// explicit `null`, in the model's declaration order. A stored non-list
/// fails `List[GitInfo]` validation and renders `null` like any other
/// invalid payload.
fn git_info_view(git_info: &crate::auth::UserRow) -> Option<Vec<GitInfoEntry>> {
    git_info
        .git_info
        .0
        .project::<Option<Vec<GitInfoEntry>>>()
        .flatten()
}

/// One stored `git_info` entry, echoed in the `GitInfo` model's field
/// order with every optional field materialized.
#[derive(Debug, Deserialize, serde::Serialize)]
struct GitInfoEntry {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    git_domain: Option<String>,
    #[serde(default)]
    git_token: Option<String>,
    #[serde(rename = "type", default)]
    entry_type: Option<String>,
    #[serde(default)]
    user_name: Option<String>,
    #[serde(default)]
    git_id: Option<String>,
    #[serde(default)]
    git_login: Option<String>,
    #[serde(default)]
    git_email: Option<String>,
    #[serde(default)]
    auth_type: Option<String>,
}

/// pydantic v2 naive `datetime` serialization: `YYYY-MM-DDTHH:MM:SS`
/// (microseconds appended only when non-zero).
fn pydantic_datetime(value: chrono::NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.f").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn user_row(preferences: &str) -> UserRow {
        UserRow {
            id: 1001,
            user_name: "tom".to_string(),
            users_password_hash: "hash".to_string(),
            email: Some("tom@example.invalid".to_string()),
            git_info: brz_mysql::Json(json!(null).into()),
            is_active: 1,
            role: "user".to_string(),
            auth_source: "dingtalk".to_string(),
            preferences: preferences.to_string(),
            created_at: NaiveDate::from_ymd_opt(2025, 12, 24)
                .unwrap()
                .and_hms_opt(17, 42, 56)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 9, 8)
                .unwrap()
                .and_hms_opt(19, 18, 0)
                .unwrap(),
        }
    }

    fn rendered(user: &UserRow) -> String {
        serde_json::to_string(&user_in_db_response(user)).unwrap()
    }

    #[test]
    fn public_response_uses_public_schema() {
        let preferences = r#"{"im_channels": {"90001": {"channel_type": "dingtalk"}}, "company_profile": {"name": "Alice", "employee_id": "10001"}, "mcps": {"dingtalk": {"services": {}}}, "wework_new_chat_model_selection": {"modelName": "openai-gpt-5.5", "modelType": "public", "options": {"reasoning": "high", "weworkCloudModelNamespace": "default", "weworkCloudModelResourceUserId": "0"}}}"#;
        let body = rendered(&user_row(preferences));
        let expected = r#"{"user_name":"tom","email":"tom@example.invalid","is_active":true,"id":1001,"git_info":null,"preferences":{"employee_id":null,"send_key":"enter","search_key":"cmd_k","memory_enabled":false,"chat_status_items":null,"tool_output_guard_enabled":false,"mcp_provider_keys":null,"quick_access":null,"default_execution_target":null,"wework_new_chat_model_selection":{"modelName":"openai-gpt-5.5","modelType":"public","options":{"reasoning":"high","weworkCloudModelNamespace":"default","weworkCloudModelResourceUserId":"0"}},"wework_project_execution_mode":"current_workspace","wework_project_work_preferences":{},"runtime_configs":{}},"role":"user","auth_source":"dingtalk","created_at":"2025-12-24T17:42:56","updated_at":"2026-09-08T19:18:00","admin_setup_completed":null}"#;
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&body).unwrap(),
            serde_json::from_str::<serde_json::Value>(expected).unwrap()
        );
    }

    #[test]
    fn null_preferences_render_null() {
        for raw in ["", "null", "{}", "not json", "[1, 2]"] {
            let body = serde_json::to_value(user_in_db_response(&user_row(raw))).unwrap();
            assert!(body["preferences"].is_null(), "preferences for {raw:?}");
        }
    }

    #[test]
    fn inactive_user_renders_false() {
        let mut row = user_row("{}");
        row.is_active = 0;
        let body = serde_json::to_value(user_in_db_response(&row)).unwrap();
        assert_eq!(body["is_active"], json!(false));
    }

    #[test]
    fn stored_preference_values_win_over_defaults() {
        let preferences = r#"{"employee_id":"10001","send_key":"cmd_enter","search_key":"disabled","memory_enabled":true,"chat_status_items":["a"],"tool_output_guard_enabled":true,"quick_access":{"version":1},"default_execution_target":"cloud","wework_project_execution_mode":"git_worktree","wework_project_work_preferences":{"p":{"executionMode":"git_worktree"}},"runtime_configs":{"r":{"use_user_config":true}}}"#;
        let body = serde_json::to_value(user_in_db_response(&user_row(preferences))).unwrap();
        assert_eq!(body["preferences"]["employee_id"], json!("10001"));
        assert_eq!(body["preferences"]["send_key"], json!("cmd_enter"));
        assert_eq!(body["preferences"]["search_key"], json!("disabled"));
        assert_eq!(body["preferences"]["memory_enabled"], json!(true));
        assert_eq!(body["preferences"]["chat_status_items"], json!(["a"]));
        assert_eq!(
            body["preferences"]["tool_output_guard_enabled"],
            json!(true)
        );
        assert_eq!(
            body["preferences"]["default_execution_target"],
            json!("cloud")
        );
        assert_eq!(
            body["preferences"]["wework_project_execution_mode"],
            json!("git_worktree")
        );
        assert_eq!(
            body["preferences"]["wework_project_work_preferences"]["p"]["executionMode"],
            json!("git_worktree")
        );
        assert_eq!(
            body["preferences"]["runtime_configs"]["r"]["use_user_config"],
            json!(true)
        );
    }

    #[test]
    fn git_info_list_materializes_every_field() {
        let mut row = user_row("{}");
        row.git_info = brz_mysql::Json(
            json!([{"git_domain": "git.example.invalid", "git_token": "***", "type": "gitlab"}])
                .into(),
        );
        let body = serde_json::to_value(user_in_db_response(&row)).unwrap();
        assert_eq!(
            body["git_info"],
            json!([{"id": null, "git_domain": "git.example.invalid", "git_token": "***", "type": "gitlab", "user_name": null, "git_id": null, "git_login": null, "git_email": null, "auth_type": null}])
        );
    }

    #[test]
    fn empty_git_info_list_renders_empty_array() {
        let mut row = user_row("{}");
        row.git_info = brz_mysql::Json(json!([]).into());
        let body = serde_json::to_value(user_in_db_response(&row)).unwrap();
        assert_eq!(body["git_info"], json!([]));
    }

    #[test]
    fn non_list_git_info_renders_null() {
        let mut row = user_row("{}");
        row.git_info = brz_mysql::Json(json!({"git_domain": "x"}).into());
        let body = serde_json::to_value(user_in_db_response(&row)).unwrap();
        assert!(body["git_info"].is_null());
    }

    #[test]
    fn model_selection_without_options_renders_empty_object() {
        let preferences = r#"{"wework_new_chat_model_selection": {"modelName": "m"}}"#;
        let body = serde_json::to_value(user_in_db_response(&user_row(preferences))).unwrap();
        assert_eq!(
            body["preferences"]["wework_new_chat_model_selection"],
            json!({"modelName": "m", "modelType": null, "options": {}})
        );
    }

    #[test]
    fn absent_model_selection_renders_null() {
        let body = serde_json::to_value(user_in_db_response(&user_row("{}"))).unwrap();
        assert!(body["preferences"].is_null());
    }

    #[test]
    fn datetimes_render_pydantic_style() {
        let naive = NaiveDate::from_ymd_opt(2026, 1, 2)
            .unwrap()
            .and_hms_micro_opt(3, 4, 5, 678901)
            .unwrap();
        assert_eq!(pydantic_datetime(naive), "2026-01-02T03:04:05.678901");
        let whole = NaiveDate::from_ymd_opt(2026, 1, 2)
            .unwrap()
            .and_hms_opt(3, 4, 5)
            .unwrap();
        assert_eq!(pydantic_datetime(whole), "2026-01-02T03:04:05");
    }
}
