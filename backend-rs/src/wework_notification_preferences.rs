// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET` / `PUT /api/v1/wework-notifications/preferences` — the account-scoped
//! Wework notification channel preferences.
//!
//! Mirrors `app.api.endpoints.wework_notifications.read_notification_preferences`
//! / `write_notification_preferences` (router prefix `/v1/wework-notifications`,
//! mounted under the app prefix `/api`) and
//! `app.services.wework_notification_preferences`.
//!
//! Both methods authenticate with `Depends(get_current_user)` — the shared
//! bearer-JWT [`SessionUser`] path that also loads the `users` row, so the
//! stored `preferences` JSON column (a `String(4096)`) is already in hand and no
//! further query runs for the read.
//!
//! `GET` renders `NotificationPreferences` from the default channel matrix
//! overlaid with the `wework_notification_preferences` document stored inside
//! `user.preferences`. The overlay is deliberately narrow: a stored boolean
//! replaces a non-null default, a stored `null` replaces a `null` default, and
//! every other stored value is ignored. A stored value can therefore never
//! change a channel whose default is `null`.
//!
//! `PUT` applies one channel toggle (`{category, channel, enabled}`). A channel
//! whose *current* value is `null` is unavailable and rejected with the source's
//! `422 {"detail": ...}`; otherwise the whole preferences document is rewritten
//! into `user.preferences`, an `in_app` disable additionally marks that
//! category's unread inbox rows read, and the request commits.
use brz_http_server::StatusCode;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `PREFERENCE_KEY`: the `user.preferences` document key holding the prefs.
const PREFERENCE_KEY: &str = "wework_notification_preferences";
/// `COLLABORATION_NOTIFICATION_KINDS` (`app/services/notification_copy.py`),
/// rendered inline the way the source's driver inlines the `in_`/`notin_` list.
const COLLABORATION_KIND_IN: &str =
    " AND wework_notifications.kind IN ('assignment', 'human_work')";
const GENERAL_KIND_IN: &str =
    " AND (wework_notifications.kind NOT IN ('assignment', 'human_work'))";

/// The source ORM flush of `db.add(user); db.commit()` after rewriting
/// `user.preferences`: only the changed column plus the model's
/// `onupdate=func.now()` column are written.
const USER_PREFERENCES_UPDATE_SQL: &str =
    "UPDATE users SET preferences=?, updated_at=now() WHERE users.id = ?";

/// `validation_exception_handler` detail line (`app/core/exceptions.py`).
const VALIDATION_FAILED: &str = "Request parameter validation failed";

/// The two inbox categories whose unread rows are marked read when `in_app` is
/// disabled. `tasks` is excluded by the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Category {
    Tasks,
    Collaboration,
    General,
}

impl Category {
    fn as_str(self) -> &'static str {
        match self {
            Self::Tasks => "tasks",
            Self::Collaboration => "collaboration",
            Self::General => "general",
        }
    }
}

/// The three configurable delivery channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Channel {
    InApp,
    System,
    Im,
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Self::InApp => "in_app",
            Self::System => "system",
            Self::Im => "im",
        }
    }
}

/// One `NotificationChannelPreference`. `None` is the JSON `null` the source
/// uses for a channel that is not selectable in that category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
struct ChannelPreference {
    in_app: Option<bool>,
    system: Option<bool>,
    im: Option<bool>,
}

impl ChannelPreference {
    const TASKS: Self = Self {
        in_app: Some(true),
        system: Some(false),
        im: None,
    };
    const COLLABORATION: Self = Self {
        in_app: Some(true),
        system: Some(true),
        im: Some(true),
    };
    const GENERAL: Self = Self {
        in_app: Some(true),
        system: None,
        im: Some(true),
    };

    /// The current value of one channel, where `None` means the JSON `null`.
    fn channel(self, channel: Channel) -> Option<bool> {
        match channel {
            Channel::InApp => self.in_app,
            Channel::System => self.system,
            Channel::Im => self.im,
        }
    }

    fn set_channel(&mut self, channel: Channel, value: bool) {
        match channel {
            Channel::InApp => self.in_app = Some(value),
            Channel::System => self.system = Some(value),
            Channel::Im => self.im = Some(value),
        }
    }
}

/// `NotificationPreferences` in pydantic field order (`response_model`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
struct NotificationPreferences {
    tasks: ChannelPreference,
    collaboration: ChannelPreference,
    general: ChannelPreference,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            tasks: ChannelPreference::TASKS,
            collaboration: ChannelPreference::COLLABORATION,
            general: ChannelPreference::GENERAL,
        }
    }
}

impl NotificationPreferences {
    fn category(self, category: Category) -> ChannelPreference {
        match category {
            Category::Tasks => self.tasks,
            Category::Collaboration => self.collaboration,
            Category::General => self.general,
        }
    }

    /// The current value of one channel, where `None` means the JSON `null`.
    fn channel(self, category: Category, channel: Channel) -> Option<bool> {
        self.category(category).channel(channel)
    }

    fn set_channel(&mut self, category: Category, channel: Channel, value: bool) {
        match category {
            Category::Tasks => self.tasks.set_channel(channel, value),
            Category::Collaboration => self.collaboration.set_channel(channel, value),
            Category::General => self.general.set_channel(channel, value),
        }
    }
}

/// `_load_user_preferences`: a JSON object maps to a dict; a missing, invalid,
/// or non-object document is empty.
fn load_user_preferences(value: &str) -> Map<String, Value> {
    match serde_json::from_str::<Value>(value) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// `get_notification_preferences(user)`.
fn notification_preferences(preferences_column: &str) -> NotificationPreferences {
    let stored = load_user_preferences(preferences_column);
    let Some(Value::Object(raw)) = stored.get(PREFERENCE_KEY) else {
        return NotificationPreferences::default();
    };
    let defaults = NotificationPreferences::default();
    NotificationPreferences {
        tasks: merge_category(defaults.tasks, raw.get("tasks")),
        collaboration: merge_category(defaults.collaboration, raw.get("collaboration")),
        general: merge_category(defaults.general, raw.get("general")),
    }
}

/// Overlay one stored category. A non-object value keeps every default.
fn merge_category(default: ChannelPreference, raw: Option<&Value>) -> ChannelPreference {
    let Some(Value::Object(channels)) = raw else {
        return default;
    };
    ChannelPreference {
        in_app: merge_channel(default.in_app, channels.get("in_app")),
        system: merge_channel(default.system, channels.get("system")),
        im: merge_channel(default.im, channels.get("im")),
    }
}

/// Overlay one stored channel: a boolean replaces a non-null default, a `null`
/// replaces a `null` default, and any other stored value keeps the default.
fn merge_channel(default: Option<bool>, stored: Option<&Value>) -> Option<bool> {
    match stored {
        Some(Value::Bool(value)) if default.is_some() => Some(*value),
        Some(Value::Null) if default.is_none() => None,
        _ => default,
    }
}

/// Rewrite `user.preferences` with the new preferences document, keeping every
/// other stored key. The value becomes Python's `json.dumps` of
/// `{**stored, PREFERENCE_KEY: preferences.model_dump()}`.
fn merged_preferences_document(
    preferences_column: &str,
    preferences: &NotificationPreferences,
) -> String {
    let mut stored = load_user_preferences(preferences_column);
    stored.insert(
        PREFERENCE_KEY.to_owned(),
        serde_json::to_value(preferences).expect("preferences serialize"),
    );
    serde_json::to_string(&Value::Object(stored)).expect("preference document serializes")
}

/// `datetime.now(timezone.utc).replace(tzinfo=None)`.
fn utc_naive_now() -> chrono::NaiveDateTime {
    chrono::Utc::now().naive_utc()
}

/// The kind predicate for marking unread rows read, only for the two inbox
/// categories and only when the source would touch them. `None` for `tasks`.
fn read_reset_predicate(category: Category) -> Option<&'static str> {
    match category {
        Category::Collaboration => Some(COLLABORATION_KIND_IN),
        Category::General => Some(GENERAL_KIND_IN),
        Category::Tasks => None,
    }
}

/// A dependency failure renders the source's `python_exception_handler` 500.
fn write_failure(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "wework notification preferences write failed");
    FastApiError::unhandled()
}

/// `update_notification_preferences(db, user=user, values=values)`: reject an
/// unavailable channel, apply the toggle, persist the document, and reset the
/// category's unread rows for an `in_app` disable.
async fn write_preferences<M: brz_mysql::Mysql>(
    mysql: &M,
    user: &SessionUser,
    update: &PreferencesUpdate,
) -> Result<NotificationPreferences, FastApiError> {
    let mut preferences = notification_preferences(&user.preferences);
    if preferences
        .channel(update.category, update.channel)
        .is_none()
    {
        // Source `raise HTTPException(422, str(error))`: the plain FastAPI body.
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "{} notifications are unavailable for {}",
                update.channel.as_str(),
                update.category.as_str()
            ),
        ));
    }
    preferences.set_channel(update.category, update.channel, update.enabled);

    let document = merged_preferences_document(&user.preferences, &preferences);
    let user_id = i64::from(user.id);

    if update.channel == Channel::InApp
        && !update.enabled
        && let Some(predicate) = read_reset_predicate(update.category)
    {
        let sql = format!(
            "UPDATE wework_notifications SET is_read=?, read_status_changed_at=? \
             WHERE wework_notifications.user_id = ? \
             AND wework_notifications.is_read IS false{predicate}"
        );
        mysql
            .execute(sql.as_str(), (true, utc_naive_now(), user_id))
            .await
            .map_err(write_failure)?;
    }

    mysql
        .execute(USER_PREFERENCES_UPDATE_SQL, (document.as_str(), user_id))
        .await
        .map_err(write_failure)?;
    mysql.execute("COMMIT", ()).await.map_err(write_failure)?;

    Ok(preferences)
}

/// GET /api/v1/wework-notifications/preferences: the read free function.
#[brz_http_server::get("/api/v1/wework-notifications/preferences")]
async fn read_notification_preferences(
    #[auth] user: SessionUser,
) -> Result<NotificationPreferences, FastApiError> {
    Ok(notification_preferences(&user.preferences))
}

/// PUT /api/v1/wework-notifications/preferences: the write free function,
/// injecting the process-lifetime application state.
#[brz_http_server::put("/api/v1/wework-notifications/preferences")]
async fn write_notification_preferences(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<NotificationPreferences, FastApiError> {
    let update = PreferencesUpdate::from_value(body)?;
    write_preferences(&state.mysql, &user, &update).await
}

/// `NotificationPreferencesUpdate` (`extra="forbid"`) decoded from the body.
#[derive(Debug)]
struct PreferencesUpdate {
    category: Category,
    channel: Channel,
    enabled: bool,
}

impl PreferencesUpdate {
    /// Validate a decoded JSON body against `NotificationPreferencesUpdate`.
    fn from_value(value: Value) -> Result<Self, FastApiError> {
        let Value::Object(object) = value else {
            return Err(validation_error(
                vec!["body"],
                "model_attributes_type",
                "Input should be a valid dictionary or object to extract fields from",
                value,
            ));
        };
        let category = parse_category(&object)?;
        let channel = parse_channel(&object)?;
        let enabled = parse_enabled(&object)?;
        if let Some(key) = first_unknown_key(&object) {
            return Err(validation_error(
                vec!["body", key],
                "extra_forbidden",
                "Extra inputs are not permitted",
                object[key].clone(),
            ));
        }
        Ok(Self {
            category,
            channel,
            enabled,
        })
    }
}

/// `category: Literal["tasks", "collaboration", "general"]`.
fn parse_category(object: &Map<String, Value>) -> Result<Category, FastApiError> {
    const MESSAGE: &str = "Input should be 'tasks', 'collaboration' or 'general'";
    match object.get("category") {
        Some(Value::String(text)) => match text.as_str() {
            "tasks" => Ok(Category::Tasks),
            "collaboration" => Ok(Category::Collaboration),
            "general" => Ok(Category::General),
            _ => Err(literal_error("category", MESSAGE, object)),
        },
        Some(other) => Err(validation_error(
            vec!["body", "category"],
            "literal_error",
            MESSAGE,
            other.clone(),
        )),
        None => Err(missing_error("category")),
    }
}

/// `channel: Literal["in_app", "system", "im"]`.
fn parse_channel(object: &Map<String, Value>) -> Result<Channel, FastApiError> {
    const MESSAGE: &str = "Input should be 'in_app', 'system' or 'im'";
    match object.get("channel") {
        Some(Value::String(text)) => match text.as_str() {
            "in_app" => Ok(Channel::InApp),
            "system" => Ok(Channel::System),
            "im" => Ok(Channel::Im),
            _ => Err(literal_error("channel", MESSAGE, object)),
        },
        Some(other) => Err(validation_error(
            vec!["body", "channel"],
            "literal_error",
            MESSAGE,
            other.clone(),
        )),
        None => Err(missing_error("channel")),
    }
}

/// `enabled: bool`.
fn parse_enabled(object: &Map<String, Value>) -> Result<bool, FastApiError> {
    match object.get("enabled") {
        Some(Value::Bool(value)) => Ok(*value),
        Some(other) => Err(validation_error(
            vec!["body", "enabled"],
            "bool_type",
            "Input should be a valid boolean",
            other.clone(),
        )),
        None => Err(missing_error("enabled")),
    }
}

/// The first key outside the model's declared fields, in document order.
fn first_unknown_key(object: &Map<String, Value>) -> Option<&str> {
    object
        .keys()
        .find(|key| !matches!(key.as_str(), "category" | "channel" | "enabled"))
        .map(String::as_str)
}

/// A `literal_error` whose `input` is the offending field value.
fn literal_error(field: &str, message: &str, object: &Map<String, Value>) -> FastApiError {
    let input = object.get(field).cloned().unwrap_or(Value::Null);
    validation_error(vec!["body", field], "literal_error", message, input)
}

/// A required field that is absent from the body.
fn missing_error(field: &str) -> FastApiError {
    validation_error(
        vec!["body", field],
        "missing",
        "Field required",
        Value::Null,
    )
}

/// `{"error_code":422,"detail":"Request parameter validation failed","errors":[...]}`
/// — the source `validation_exception_handler` body.
fn validation_error(location: Vec<&str>, kind: &str, message: &str, input: Value) -> FastApiError {
    FastApiError::json_body(
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({
            "error_code": 422,
            "detail": VALIDATION_FAILED,
            "errors": [
                {"type": kind, "loc": location, "msg": message, "input": input},
            ],
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The recorded `GET` body for a user with no stored preferences.
    const RECORDED_DEFAULT_BODY: &str = "{\"tasks\":{\"in_app\":true,\"system\":false,\
        \"im\":null},\"collaboration\":{\"in_app\":true,\"system\":true,\"im\":true},\
        \"general\":{\"in_app\":true,\"system\":null,\"im\":true}}";

    fn user(preferences: &str) -> SessionUser {
        SessionUser(crate::auth::UserRow {
            id: 2671,
            user_name: "haochuan".to_string(),
            users_password_hash: String::new(),
            email: None,
            git_info: brz_mysql::Json(brz_json::OpaqueJson::from(json!({}))),
            is_active: 1,
            role: "user".to_string(),
            auth_source: "password".to_string(),
            preferences: preferences.to_string(),
            created_at: chrono::NaiveDate::from_ymd_opt(2026, 9, 10)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            updated_at: chrono::NaiveDate::from_ymd_opt(2026, 9, 10)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
        })
    }

    fn rendered(preferences: NotificationPreferences) -> String {
        serde_json::to_string(&preferences).unwrap()
    }

    #[test]
    fn empty_or_non_object_stored_value_renders_the_defaults() {
        for column in ["{}", "", "not-json", "null", "42", "\"text\"", "[]"] {
            assert_eq!(
                rendered(notification_preferences(column)),
                RECORDED_DEFAULT_BODY,
                "column={column:?}"
            );
        }
        // A present key with a non-object value is also ignored.
        assert_eq!(
            rendered(notification_preferences(
                r#"{"wework_notification_preferences": 7}"#
            )),
            RECORDED_DEFAULT_BODY
        );
    }

    #[test]
    fn recorded_preferences_column_renders_the_recorded_body() {
        // The representative user's real `preferences` document has no
        // `wework_notification_preferences` key, so the defaults are returned.
        let column = r#"{"legacy_mail": {"token": "x"}, "company_profile": {"name": "n"}}"#;
        assert_eq!(
            rendered(notification_preferences(column)),
            RECORDED_DEFAULT_BODY
        );
    }

    #[test]
    fn stored_boolean_overrides_a_non_null_default() {
        let column = r#"{"wework_notification_preferences":
            {"collaboration": {"system": false}}}"#;
        let value = notification_preferences(column);
        assert_eq!(value.collaboration.system, Some(false));
        // Untouched channels keep their defaults.
        assert_eq!(value.collaboration.in_app, Some(true));
        assert_eq!(value.collaboration.im, Some(true));
        assert_eq!(value.tasks, ChannelPreference::TASKS);
    }

    #[test]
    fn stored_null_only_overrides_a_null_default() {
        // `tasks.im` defaults to null: a stored null is kept, a stored boolean
        // is dropped (the source cannot change a null-default channel).
        assert_eq!(
            notification_preferences(
                r#"{"wework_notification_preferences": {"tasks": {"im": null}}}"#
            )
            .tasks
            .im,
            None
        );
        assert_eq!(
            notification_preferences(
                r#"{"wework_notification_preferences": {"tasks": {"im": true}}}"#
            )
            .tasks
            .im,
            None
        );
        // `general.system` is the other null-default channel.
        assert_eq!(
            notification_preferences(
                r#"{"wework_notification_preferences": {"general": {"system": true}}}"#
            )
            .general
            .system,
            None
        );
    }

    #[test]
    fn wrong_typed_and_unknown_channels_are_ignored() {
        let column = r#"{"wework_notification_preferences":
            {"tasks": {"in_app": "no", "system": 1, "extra": true},
             "unknown_category": {"in_app": false}}}"#;
        assert_eq!(
            rendered(notification_preferences(column)),
            RECORDED_DEFAULT_BODY
        );
        // A non-object category keeps its defaults.
        assert_eq!(
            rendered(notification_preferences(
                r#"{"wework_notification_preferences": {"tasks": []}}"#
            )),
            RECORDED_DEFAULT_BODY
        );
    }

    #[test]
    fn update_requires_the_three_fields() {
        assert!(PreferencesUpdate::from_value(json!({})).is_err());
        assert!(PreferencesUpdate::from_value(json!([])).is_err());
        assert!(
            PreferencesUpdate::from_value(json!({"category": "tasks", "channel": "in_app"}))
                .is_err()
        );
    }

    #[test]
    fn update_rejects_unknown_literals_and_types() {
        assert!(
            PreferencesUpdate::from_value(
                json!({"category": "other", "channel": "im", "enabled": true})
            )
            .is_err()
        );
        assert!(
            PreferencesUpdate::from_value(json!({"category": 1, "channel": "im", "enabled": true}))
                .is_err()
        );
        assert!(
            PreferencesUpdate::from_value(
                json!({"category": "tasks", "channel": "sms", "enabled": true})
            )
            .is_err()
        );
        assert!(
            PreferencesUpdate::from_value(
                json!({"category": "tasks", "channel": "im", "enabled": "yes"})
            )
            .is_err()
        );
    }

    #[test]
    fn update_forbids_unknown_keys() {
        let value = json!({
            "category": "tasks",
            "channel": "im",
            "enabled": true,
            "extra": 1,
        });
        let object = value.as_object().unwrap();
        assert_eq!(first_unknown_key(object), Some("extra"));

        let error = PreferencesUpdate::from_value(value).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            error.validation_detail(),
            "\"Request parameter validation failed\""
        );
    }

    #[test]
    fn update_accepts_a_valid_body() {
        let update = PreferencesUpdate::from_value(json!({
            "category": "collaboration",
            "channel": "system",
            "enabled": false,
        }))
        .unwrap();
        assert_eq!(update.category, Category::Collaboration);
        assert_eq!(update.channel, Channel::System);
        assert!(!update.enabled);
    }

    #[test]
    fn merging_back_the_new_document_round_trips() {
        // Applying a toggle then re-reading the persisted document reproduces
        // the in-memory preferences (the source's `db.refresh` re-read).
        let user = user("{}");
        let update = PreferencesUpdate {
            category: Category::Collaboration,
            channel: Channel::System,
            enabled: false,
        };
        let mut preferences = notification_preferences(&user.preferences);
        preferences.set_channel(update.category, update.channel, update.enabled);
        let document = merged_preferences_document(&user.preferences, &preferences);
        assert_eq!(notification_preferences(&document), preferences);
    }

    #[test]
    fn document_rewrite_preserves_other_keys() {
        let user = user(r#"{"send_key": "enter"}"#);
        let preferences = notification_preferences(&user.preferences);
        let document = merged_preferences_document(&user.preferences, &preferences);
        let stored: Value = serde_json::from_str(&document).unwrap();
        assert_eq!(stored["send_key"], json!("enter"));
        assert!(stored[PREFERENCE_KEY].is_object());
    }

    #[tokio::test]
    async fn unavailable_channel_is_rejected_before_any_write() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let user = user("{}");
        // `tasks.im` defaults to null, so it can never be toggled.
        let update = PreferencesUpdate {
            category: Category::Tasks,
            channel: Channel::Im,
            enabled: true,
        };
        let error = write_preferences(&mysql, &user, &update).await.unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            error.validation_detail(),
            "\"im notifications are unavailable for tasks\""
        );
        assert!(mysql.writes().is_empty(), "no write on rejection");
    }

    #[tokio::test]
    async fn toggling_a_selectable_channel_writes_the_document() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let user = user("{}");
        let update = PreferencesUpdate {
            category: Category::Collaboration,
            channel: Channel::System,
            enabled: false,
        };
        let preferences = write_preferences(&mysql, &user, &update).await.unwrap();
        assert_eq!(preferences.collaboration.system, Some(false));

        let writes = mysql.writes();
        let statements: Vec<&str> = writes.iter().map(|write| write.sql.as_str()).collect();
        // No `in_app` disable, so only the user row update and the commit.
        assert_eq!(
            statements,
            vec![
                "UPDATE users SET preferences=?, updated_at=now() WHERE users.id = ?",
                "COMMIT",
            ]
        );
        assert_eq!(writes[0].args, 2);
        // The first bound value is the preferences text document, not an id.
        assert_eq!(writes[0].first_integer, None);
    }

    #[tokio::test]
    async fn in_app_disable_marks_the_category_unread_rows_read() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let user = user("{}");
        let update = PreferencesUpdate {
            category: Category::General,
            channel: Channel::InApp,
            enabled: false,
        };
        write_preferences(&mysql, &user, &update).await.unwrap();

        let writes = mysql.writes();
        assert_eq!(writes.len(), 3, "{:?}", writes.iter().map(|w| &w.sql));
        assert_eq!(
            writes[0].sql,
            "UPDATE wework_notifications SET is_read=?, read_status_changed_at=? \
             WHERE wework_notifications.user_id = ? \
             AND wework_notifications.is_read IS false AND \
             (wework_notifications.kind NOT IN ('assignment', 'human_work'))"
        );
        assert_eq!(writes[0].args, 3);
        assert_eq!(writes[1].sql, USER_PREFERENCES_UPDATE_SQL);
        assert_eq!(writes[2].sql, "COMMIT");
    }

    #[tokio::test]
    async fn in_app_enable_and_tasks_disable_do_not_touch_the_inbox() {
        for update in [
            PreferencesUpdate {
                category: Category::Collaboration,
                channel: Channel::InApp,
                enabled: true,
            },
            PreferencesUpdate {
                category: Category::Tasks,
                channel: Channel::InApp,
                enabled: false,
            },
        ] {
            let mysql = crate::sql_test_support::KindQueryCapture::writing();
            let user = user("{}");
            write_preferences(&mysql, &user, &update).await.unwrap();
            let writes = mysql.writes();
            assert_eq!(writes.len(), 2, "{:?}", writes.iter().map(|w| &w.sql));
            assert_eq!(writes[0].sql, USER_PREFERENCES_UPDATE_SQL);
        }
    }

    #[test]
    fn read_reset_predicates_match_the_source_kind_sets() {
        assert_eq!(
            read_reset_predicate(Category::Collaboration),
            Some(" AND wework_notifications.kind IN ('assignment', 'human_work')")
        );
        assert_eq!(
            read_reset_predicate(Category::General),
            Some(" AND (wework_notifications.kind NOT IN ('assignment', 'human_work'))")
        );
        assert_eq!(read_reset_predicate(Category::Tasks), None);
    }

    #[tokio::test]
    async fn collaboration_disable_scopes_to_collaboration_kinds() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let user = user("{}");
        let update = PreferencesUpdate {
            category: Category::Collaboration,
            channel: Channel::InApp,
            enabled: false,
        };
        write_preferences(&mysql, &user, &update).await.unwrap();
        assert_eq!(
            mysql.writes()[0].sql,
            "UPDATE wework_notifications SET is_read=?, read_status_changed_at=? \
             WHERE wework_notifications.user_id = ? \
             AND wework_notifications.is_read IS false AND \
             wework_notifications.kind IN ('assignment', 'human_work')"
        );
    }
}
