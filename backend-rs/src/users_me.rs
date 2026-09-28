// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Current-user response with public preference defaults and an optional
//! application-supplied profile extension. Missing credentials return 401.
use serde::Deserialize;
#[cfg(test)]
use serde_json::json;

use crate::auth::{AppAuthenticator, UserRow, get_current_user};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// GET /api/users/me: the users-me free function, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/users/me")]
async fn read_current_user(
    #[inject(state)] state: &AppState,
    #[auth] user: UsersMeUser,
) -> Result<UserView, FastApiError> {
    users_me(state, user.0).await
}

/// The users-me endpoint deliberately collapses every authentication failure
/// to its own "Missing authentication credentials" response.
struct UsersMeUser(UserRow);

impl brz_http_server::Authenticator<UsersMeUser> for AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<UsersMeUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        get_current_user(&self.state().auth, &self.state().mysql, authorization)
            .await
            .map(UsersMeUser)
            .map_err(|_| brz_http_server::AuthFailure::invalid_credentials("Bearer"))
    }

    fn api_log_id<'a>(&'a self, principal: &'a UsersMeUser) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        _failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;

        missing_credentials().into_http_error(arena)
    }
}

/// Handler body for `GET /api/users/me`. The source declares
/// `response_model=UserInDB`, so FastAPI renders the model as
/// `application/json`; returning the serializable view keeps that content
/// type instead of the raw-bytes `application/octet-stream` default.
async fn users_me(state: &AppState, user: UserRow) -> Result<UserView, FastApiError> {
    // The application resolves the current user's stored Git credentials
    // before the response is rendered; the public default renders the stored
    // column and reads no external service.
    let git_info = state.user_git_info.resolved_git_info(&user).await;

    // `admin_setup_completed` is only read for the initial `admin` user
    // (`current_user.user_name == "admin"`); every other user keeps the
    // model default `None`.
    Ok(current_user_response(
        &user,
        state.user_profile.current_user_ext(&user),
        git_info,
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
    current_user_response(
        user,
        crate::user_profile::UserViewExt::empty(),
        stored_git_info(user),
    )
}

pub(crate) fn user_in_db_response_with_extra(
    user: &UserRow,
    extra: crate::user_profile::UserViewExt,
) -> UserView {
    current_user_response(user, extra, stored_git_info(user))
}

/// `_build_user_response` + pydantic `UserInDB` serialization with the
/// application-resolved `git_info` list.
pub(crate) fn current_user_response(
    user: &UserRow,
    extra: crate::user_profile::UserViewExt,
    git_info: Option<Vec<GitInfoEntry>>,
) -> UserView {
    let (top_level_extra, preference_extra) = extra.into_parts();
    UserView {
        user_name: user.user_name.clone(),
        email: user.email.clone(),
        is_active: user.is_active != 0,
        id: user.id,
        git_info,
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
/// Dynamic-keyed objects (`wework_project_work_preferences`,
/// `runtime_configs`, `options`) echo their stored JSON verbatim through
/// [`RawEcho`].
#[derive(Debug, Default, Deserialize)]
struct EchoedPreferences {
    #[serde(default)]
    employee_id: Option<String>,
    #[serde(default)]
    send_key: Option<String>,
    #[serde(default)]
    follow_up_behavior: Option<String>,
    #[serde(default)]
    search_key: Option<String>,
    #[serde(default)]
    memory_enabled: Option<bool>,
    #[serde(default)]
    chat_status_items: Option<Vec<String>>,
    #[serde(default)]
    tool_output_guard_enabled: Option<bool>,
    #[serde(default)]
    quick_access: Option<QuickAccessPreference>,
    #[serde(default)]
    composer_quick_phrases: Option<Vec<ComposerQuickPhrase>>,
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

/// `QuickAccessPreference`: both fields re-materialize their schema default
/// (`version` as `null`, `teams` as `[]`) and unknown keys are dropped, so a
/// stored document is never echoed verbatim.
#[derive(Debug, Default, Deserialize)]
struct QuickAccessPreference {
    #[serde(default)]
    version: Option<i64>,
    #[serde(default)]
    teams: Vec<i64>,
}

/// `QuickAccessPreference`'s serialized shape: the model's declaration order
/// with both fields always materialized.
#[derive(serde::Serialize)]
struct QuickAccessResponse {
    version: Option<i64>,
    teams: Vec<i64>,
}

impl From<QuickAccessPreference> for QuickAccessResponse {
    fn from(value: QuickAccessPreference) -> Self {
        Self {
            version: value.version,
            teams: value.teams,
        }
    }
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

/// `ComposerQuickPhrase`: `id`, `title`, `content` and `mode` are required;
/// `attachmentPaths` and `createdAt` are optional. The model validator then
/// strips the three string fields, drops blank attachment paths, and
/// rejects a phrase whose stripped content and attachments are both empty.
/// A phrase that violates that validator makes the stored document
/// unparseable here, where the source raises a validation error instead.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComposerQuickPhrase {
    id: String,
    title: String,
    content: String,
    mode: String,
    #[serde(default)]
    attachment_paths: Option<Vec<String>>,
    #[serde(default)]
    created_at: Option<f64>,
}

/// `ComposerQuickPhrase`'s serialized shape: the model's declaration order
/// with both optional fields materialized.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerQuickPhraseResponse {
    id: String,
    title: String,
    content: String,
    mode: String,
    attachment_paths: Option<Vec<String>>,
    created_at: Option<f64>,
}

impl ComposerQuickPhrase {
    /// Applies the model validator's normalization; `None` means the stored
    /// phrase violates the `ComposerQuickPhrase` schema.
    fn into_response(self) -> Option<ComposerQuickPhraseResponse> {
        let id = self.id.trim().to_string();
        let title = self.title.trim().to_string();
        let content = self.content.trim().to_string();
        let attachment_paths = self.attachment_paths.map(|paths| {
            paths
                .into_iter()
                .filter_map(|path| {
                    let path = path.trim().to_string();
                    (!path.is_empty()).then_some(path)
                })
                .collect::<Vec<String>>()
        });
        let has_attachments = attachment_paths
            .as_ref()
            .is_some_and(|paths| !paths.is_empty());
        if id.is_empty() || title.is_empty() || (content.is_empty() && !has_attachments) {
            return None;
        }
        Some(ComposerQuickPhraseResponse {
            id,
            title,
            content,
            mode: self.mode,
            attachment_paths,
            created_at: self.created_at,
        })
    }
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
    follow_up_behavior: String,
    search_key: String,
    memory_enabled: bool,
    chat_status_items: Option<Vec<String>>,
    tool_output_guard_enabled: bool,
    mcp_provider_keys: Option<RawEcho>,
    quick_access: Option<QuickAccessResponse>,
    composer_quick_phrases: Option<Vec<ComposerQuickPhraseResponse>>,
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
    let composer_quick_phrases = match source.composer_quick_phrases {
        Some(phrases) => Some(
            phrases
                .into_iter()
                .map(ComposerQuickPhrase::into_response)
                .collect::<Option<Vec<_>>>()?,
        ),
        None => None,
    };
    Some(PreferencesResponse {
        employee_id: source.employee_id,
        send_key: source.send_key.unwrap_or_else(|| "enter".to_string()),
        follow_up_behavior: source
            .follow_up_behavior
            .unwrap_or_else(|| "queue".to_string()),
        search_key: source.search_key.unwrap_or_else(|| "cmd_k".to_string()),
        memory_enabled: source.memory_enabled.unwrap_or(false),
        chat_status_items: source.chat_status_items,
        tool_output_guard_enabled: source.tool_output_guard_enabled.unwrap_or(false),
        mcp_provider_keys: None,
        quick_access: source.quick_access.map(QuickAccessResponse::from),
        composer_quick_phrases,
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
pub fn stored_git_info(user: &UserRow) -> Option<Vec<GitInfoEntry>> {
    user.git_info
        .0
        .project::<Option<Vec<GitInfoEntry>>>()
        .flatten()
}

/// One stored `git_info` entry, echoed in the `GitInfo` model's field
/// order with every optional field materialized.
#[derive(Debug, Deserialize, PartialEq, serde::Serialize)]
pub struct GitInfoEntry {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub git_domain: Option<String>,
    #[serde(default)]
    pub git_token: Option<String>,
    #[serde(rename = "type", default)]
    pub entry_type: Option<String>,
    #[serde(default)]
    pub user_name: Option<String>,
    #[serde(default)]
    pub git_id: Option<String>,
    #[serde(default)]
    pub git_login: Option<String>,
    #[serde(default)]
    pub git_email: Option<String>,
    #[serde(default)]
    pub auth_type: Option<String>,
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
    use crate::user_profile::UserGitInfoProvider as _;
    use chrono::NaiveDate;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated test group (separate from the crate's real `http_apis`
    // group) so the probe's `/api/users/me` route does not collide with the
    // real handler's registration.
    mod probe {
        brz_http_server::registry!(group = users_me_probe, dependencies());
    }

    /// Renders the users-me success value through the route macro over a real
    /// socket. The source declares `response_model=UserInDB`, so the response
    /// must answer `application/json`; returning raw `Binary` bytes would
    /// answer `application/octet-stream`.
    #[brz_http_server::get("/api/users/me", group = probe::users_me_probe, access = public)]
    async fn users_me_probe() -> Result<UserView, FastApiError> {
        Ok(current_user_response(
            &user_row("{}"),
            crate::user_profile::UserViewExt::empty(),
            None,
        ))
    }

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

    /// Serves the probe route on a real socket so status, headers, and body
    /// are asserted exactly as the runtime renders them.
    async fn serve_users_me() -> String {
        let handler =
            brz_http_server::handlers!(; group = probe::users_me_probe).expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client
            .write_all(
                b"GET /api/users/me HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("send request");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read response");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    #[tokio::test]
    async fn users_me_answers_application_json() {
        let raw = serve_users_me().await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        let content_type = raw
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("content-type:"))
            .expect("content-type header");
        assert_eq!(
            content_type["content-type:".len()..].trim(),
            "application/json",
            "{raw}"
        );
        let body = raw.split_once("\r\n\r\n").map_or("", |(_, body)| body);
        assert_eq!(body, rendered(&user_row("{}")), "{raw}");
    }

    #[test]
    fn resolved_git_info_replaces_the_stored_rendering() {
        let mut row = user_row("{}");
        row.git_info = brz_mysql::Json(
            json!([{"git_domain": "git.example.invalid", "git_token": "***", "type": "gitlab"}])
                .into(),
        );
        let resolved = vec![GitInfoEntry {
            id: None,
            git_domain: Some("git.example.invalid".to_string()),
            git_token: Some("real".to_string()),
            entry_type: Some("gitlab".to_string()),
            user_name: None,
            git_id: None,
            git_login: None,
            git_email: None,
            auth_type: None,
        }];
        let body = serde_json::to_value(current_user_response(
            &row,
            crate::user_profile::UserViewExt::empty(),
            Some(resolved),
        ))
        .unwrap();
        assert_eq!(body["git_info"][0]["git_token"], json!("real"));
    }

    #[tokio::test]
    async fn the_default_provider_renders_the_stored_column() {
        let row = user_row("{}");
        let provider = crate::user_profile::StoredGitInfo;
        let resolved = provider.resolved_git_info(&row).await;
        assert_eq!(resolved, stored_git_info(&row));
    }

    #[test]
    fn public_response_uses_public_schema() {
        let preferences = r#"{"im_channels": {"90001": {"channel_type": "dingtalk"}}, "company_profile": {"name": "Alice", "employee_id": "10001"}, "mcps": {"dingtalk": {"services": {}}}, "wework_new_chat_model_selection": {"modelName": "openai-gpt-5.5", "modelType": "public", "options": {"reasoning": "high", "weworkCloudModelNamespace": "default", "weworkCloudModelResourceUserId": "0"}}}"#;
        let body = rendered(&user_row(preferences));
        let expected = r#"{"user_name":"tom","email":"tom@example.invalid","is_active":true,"id":1001,"git_info":null,"preferences":{"employee_id":null,"send_key":"enter","follow_up_behavior":"queue","search_key":"cmd_k","memory_enabled":false,"chat_status_items":null,"tool_output_guard_enabled":false,"mcp_provider_keys":null,"quick_access":null,"composer_quick_phrases":null,"default_execution_target":null,"wework_new_chat_model_selection":{"modelName":"openai-gpt-5.5","modelType":"public","options":{"reasoning":"high","weworkCloudModelNamespace":"default","weworkCloudModelResourceUserId":"0"}},"wework_project_execution_mode":"current_workspace","wework_project_work_preferences":{},"runtime_configs":{}},"role":"user","auth_source":"dingtalk","created_at":"2025-12-24T17:42:56","updated_at":"2026-09-08T19:18:00","admin_setup_completed":null}"#;
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
        let preferences = r#"{"employee_id":"10001","send_key":"cmd_enter","follow_up_behavior":"guide","search_key":"disabled","memory_enabled":true,"chat_status_items":["a"],"tool_output_guard_enabled":true,"quick_access":{"version":1},"composer_quick_phrases":[{"id":"p1","title":"Review","content":"review this","mode":"plan"}],"default_execution_target":"cloud","wework_project_execution_mode":"git_worktree","wework_project_work_preferences":{"p":{"executionMode":"git_worktree"}},"runtime_configs":{"r":{"use_user_config":true}}}"#;
        let body = serde_json::to_value(user_in_db_response(&user_row(preferences))).unwrap();
        assert_eq!(body["preferences"]["employee_id"], json!("10001"));
        assert_eq!(body["preferences"]["send_key"], json!("cmd_enter"));
        assert_eq!(body["preferences"]["follow_up_behavior"], json!("guide"));
        assert_eq!(body["preferences"]["search_key"], json!("disabled"));
        assert_eq!(body["preferences"]["memory_enabled"], json!(true));
        assert_eq!(body["preferences"]["chat_status_items"], json!(["a"]));
        assert_eq!(
            body["preferences"]["composer_quick_phrases"],
            json!([{"id": "p1", "title": "Review", "content": "review this", "mode": "plan", "attachmentPaths": null, "createdAt": null}])
        );
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
    fn quick_access_materializes_schema_defaults_and_drops_unknown_keys() {
        // A stored document without `version` still renders the model's
        // `None` default, and the model drops keys it does not declare.
        let preferences = r#"{"quick_access":{"teams":[205983],"unknown":true}}"#;
        let body = serde_json::to_value(user_in_db_response(&user_row(preferences))).unwrap();
        assert_eq!(
            body["preferences"]["quick_access"],
            json!({"version": null, "teams": [205983]})
        );

        // An absent `teams` list renders the model's empty default.
        let preferences = r#"{"quick_access":{"version":3}}"#;
        let body = serde_json::to_value(user_in_db_response(&user_row(preferences))).unwrap();
        assert_eq!(
            body["preferences"]["quick_access"],
            json!({"version": 3, "teams": []})
        );
    }

    #[test]
    fn absent_model_selection_renders_null() {
        let body = serde_json::to_value(user_in_db_response(&user_row("{}"))).unwrap();
        assert!(body["preferences"].is_null());
    }

    #[test]
    fn absent_composer_quick_phrases_and_follow_up_behavior_use_defaults() {
        let body = serde_json::to_value(user_in_db_response(&user_row(
            r#"{"send_key": "cmd_enter"}"#,
        )))
        .unwrap();
        assert!(body["preferences"]["composer_quick_phrases"].is_null());
        assert_eq!(body["preferences"]["follow_up_behavior"], json!("queue"));
    }

    #[test]
    fn composer_quick_phrases_strip_and_materialize_fields() {
        let preferences = r#"{"composer_quick_phrases":[{"id":" p1 ","title":" Review ","content":"","mode":"normal","attachmentPaths":[" /tmp/a.png ",""," "],"createdAt":1730000000}]}"#;
        let body = serde_json::to_value(user_in_db_response(&user_row(preferences))).unwrap();
        assert_eq!(
            body["preferences"]["composer_quick_phrases"],
            json!([{"id": "p1", "title": "Review", "content": "", "mode": "normal", "attachmentPaths": ["/tmp/a.png"], "createdAt": 1730000000.0}])
        );
    }

    #[test]
    fn invalid_composer_quick_phrase_renders_null_preferences() {
        // The source raises a validation error for a phrase without content
        // and attachments; no partial preference document is rendered here.
        let preferences = r#"{"employee_id":"10001","composer_quick_phrases":[{"id":"p1","title":"Review","content":"","mode":"normal"}]}"#;
        let body = serde_json::to_value(user_in_db_response(&user_row(preferences))).unwrap();
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
