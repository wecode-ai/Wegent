//! Weibo account fields added to the shared user response.
use serde_json::value::RawValue;
#[cfg(test)]
use serde_json::{Value, json};
use wegent_backend_rs::{
    auth::UserRow,
    user_profile::{UserViewExt, UserViewExtension},
};

#[derive(Default, serde::Deserialize)]
struct BindingPreference {
    uid: Option<String>,
    screen_name: Option<String>,
    avatar_url: Option<String>,
    bound_at: Option<String>,
}

#[derive(serde::Serialize)]
struct BindingStatus {
    weibo_uid: Option<String>,
    weibo_screen_name: Option<String>,
    weibo_avatar_url: Option<String>,
    weibo_bound_at: Option<String>,
}

#[derive(serde::Serialize)]
struct PrivatePreferences {
    sina_mail: Option<Box<RawValue>>,
    weibo_binding: Option<Box<RawValue>>,
}

#[derive(Default, serde::Deserialize)]
struct PrivatePreferenceInput {
    #[serde(default)]
    sina_mail: Option<Box<RawValue>>,
    #[serde(default)]
    weibo_binding: Option<Box<RawValue>>,
}

pub struct WecodeUserProfile;
impl UserViewExtension for WecodeUserProfile {
    fn current_user_ext(&self, user: &UserRow) -> UserViewExt {
        let mut stored = private_preferences(&user.preferences);
        let binding = stored
            .weibo_binding
            .as_ref()
            .and_then(|value| serde_json::from_str::<BindingPreference>(value.get()).ok())
            .unwrap_or_default();
        let field = |value: &Option<String>| {
            value
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        UserViewExt::new(
            BindingStatus {
                weibo_uid: field(&binding.uid),
                weibo_screen_name: field(&binding.screen_name),
                weibo_avatar_url: field(&binding.avatar_url),
                weibo_bound_at: binding.bound_at.as_deref().and_then(parse_bound_at),
            },
            PrivatePreferences {
                sina_mail: stored.sina_mail.take(),
                weibo_binding: stored.weibo_binding.take(),
            },
        )
    }

    fn cached_user_ext(&self, preferences: Option<&str>) -> UserViewExt {
        let mut stored = private_preferences(preferences.unwrap_or_default());
        UserViewExt::new(
            BindingStatus {
                weibo_uid: None,
                weibo_screen_name: None,
                weibo_avatar_url: None,
                weibo_bound_at: None,
            },
            PrivatePreferences {
                sina_mail: stored.sina_mail.take(),
                weibo_binding: stored.weibo_binding.take(),
            },
        )
    }
}

fn private_preferences(raw: &str) -> PrivatePreferenceInput {
    serde_json::from_str(raw).unwrap_or_default()
}

fn parse_bound_at(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    // The source stores `datetime.now(timezone.utc).isoformat()` output and
    // reads it back with `datetime.fromisoformat`, so the response field is a
    // pydantic `datetime`: an offset-aware value keeps its offset (`Z` for a
    // zero offset) and a naive value keeps its suffix-free form.
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|datetime| {
            render_datetime(
                datetime.naive_local(),
                Some(datetime.offset().local_minus_utc()),
            )
        })
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S"))
                .map(|datetime| render_datetime(datetime, None))
        })
        .ok()
}

/// pydantic v2 `datetime` serialization: `YYYY-MM-DDTHH:MM:SS` with six
/// fractional digits only when the value has a sub-second part, followed by
/// `Z` for a zero offset or `+HH:MM`/`-HH:MM` otherwise. A naive value has no
/// suffix.
fn render_datetime(datetime: chrono::NaiveDateTime, offset_seconds: Option<i32>) -> String {
    let mut rendered = datetime.format("%Y-%m-%dT%H:%M:%S").to_string();
    let nanosecond = datetime.and_utc().timestamp_subsec_nanos();
    if nanosecond != 0 {
        rendered.push_str(&format!(".{:06}", nanosecond / 1_000));
    }
    if let Some(offset) = offset_seconds {
        if offset == 0 {
            rendered.push('Z');
        } else {
            let minutes = offset / 60;
            rendered.push_str(&format!(
                "{}{:02}:{:02}",
                if minutes < 0 { '-' } else { '+' },
                minutes.abs() / 60,
                minutes.abs() % 60
            ));
        }
    }
    rendered
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    fn user_row(preferences: &str) -> UserRow {
        UserRow {
            id: 2067,
            user_name: "qinyong".to_string(),
            users_password_hash: "hash".to_string(),
            email: Some("qinyong@example.invalid".to_string()),
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

    fn user_in_db_response(user: &UserRow) -> Value {
        let extra = WecodeUserProfile.current_user_ext(user);
        serde_json::to_value(wegent_backend_rs::user_profile::render_user_with_extra(
            user, extra,
        ))
        .unwrap()
    }
    #[test]
    fn weibo_binding_fields_render_from_preferences() {
        let preferences = r#"{"weibo_binding": {"uid": " 12345 ", "screen_name": "wei", "avatar_url": "", "bound_at": "2026-09-08T11:18:00.125454+00:00"}}"#;
        let body = serde_json::to_value(user_in_db_response(&user_row(preferences))).unwrap();
        assert_eq!(body["weibo_uid"], json!("12345"));
        assert_eq!(body["weibo_screen_name"], json!("wei"));
        assert_eq!(body["weibo_avatar_url"], json!(null));
        // `_parse_bound_at` returns an offset-aware `datetime`, which pydantic
        // renders with its offset (`Z` for UTC).
        assert_eq!(body["weibo_bound_at"], json!("2026-09-08T11:18:00.125454Z"));
        // The weibo_binding preference stays inside preferences too,
        // echoed verbatim (including its untrimmed uid).
        assert_eq!(
            body["preferences"]["weibo_binding"]["uid"],
            json!(" 12345 ")
        );
    }

    #[test]
    fn bound_at_keeps_the_stored_offset() {
        // The stored document always comes from
        // `datetime.now(timezone.utc).isoformat()`, but the field is a plain
        // `datetime` in the schema, so any offset the document carries is
        // preserved and a naive value stays suffix-free.
        let render = |bound_at: &str| {
            let preferences =
                format!(r#"{{"weibo_binding": {{"uid": "1", "bound_at": "{bound_at}"}}}}"#);
            let body = user_in_db_response(&user_row(&preferences));
            body["weibo_bound_at"].clone()
        };
        assert_eq!(
            render("2026-06-04T15:59:37.451126+00:00"),
            json!("2026-06-04T15:59:37.451126Z")
        );
        assert_eq!(
            render("2026-06-04T15:59:37.451126Z"),
            json!("2026-06-04T15:59:37.451126Z")
        );
        assert_eq!(
            render("2026-06-04T23:59:37.451126+08:00"),
            json!("2026-06-04T23:59:37.451126+08:00")
        );
        assert_eq!(render("2026-06-04T15:59:37"), json!("2026-06-04T15:59:37"));
        assert_eq!(
            render("2026-06-04T15:59:37.451126"),
            json!("2026-06-04T15:59:37.451126")
        );
    }

    #[test]
    fn non_dict_weibo_binding_renders_nulls() {
        for preferences in [r#"{"weibo_binding": "oops"}"#, r#"{}"#] {
            let body = serde_json::to_value(user_in_db_response(&user_row(preferences))).unwrap();
            assert!(body["weibo_uid"].is_null());
            assert!(body["weibo_bound_at"].is_null());
        }
    }
    #[test]
    fn malformed_binding_defaults_all_status_fields() {
        let body = user_in_db_response(&user_row(
            r#"{"weibo_binding":{"uid":123,"screen_name":"value"}}"#,
        ));
        assert!(body["weibo_uid"].is_null());
        assert!(body["weibo_screen_name"].is_null());
    }
    #[test]
    fn private_cached_preferences_keep_null_and_empty_distinct() {
        let missing = private_preferences("{}");
        assert!(missing.sina_mail.is_none());
        let explicit_null = private_preferences(r#"{"sina_mail":null}"#);
        assert!(explicit_null.sina_mail.is_none());
        let empty = private_preferences(r#"{"sina_mail":""}"#);
        assert_eq!(empty.sina_mail.unwrap().get(), "\"\"");
    }
    #[test]
    fn response_matches_recorded_body() {
        let preferences = r#"{"im_channels": {"122459": {"channel_type": "dingtalk"}}, "company_profile": {"name": "秦勇", "employee_id": "220642"}, "mcps": {"dingtalk": {"services": {}}}, "wework_new_chat_model_selection": {"modelName": "openai-gpt-5.5(海外)", "modelType": "public", "options": {"reasoning": "high", "weworkCloudModelNamespace": "default", "weworkCloudModelResourceUserId": "0"}}}"#;
        let body = serde_json::to_string(&user_in_db_response(&user_row(preferences))).unwrap();
        let expected = r#"{"user_name":"qinyong","email":"qinyong@example.invalid","is_active":true,"id":2067,"git_info":null,"preferences":{"employee_id":null,"send_key":"enter","follow_up_behavior":"queue","search_key":"cmd_k","memory_enabled":false,"chat_status_items":null,"tool_output_guard_enabled":false,"mcp_provider_keys":null,"quick_access":null,"composer_quick_phrases":null,"default_execution_target":null,"wework_new_chat_model_selection":{"modelName":"openai-gpt-5.5(海外)","modelType":"public","options":{"reasoning":"high","weworkCloudModelNamespace":"default","weworkCloudModelResourceUserId":"0"}},"wework_project_execution_mode":"current_workspace","sina_mail":null,"weibo_binding":null,"wework_project_work_preferences":{},"runtime_configs":{}},"role":"user","auth_source":"dingtalk","weibo_uid":null,"weibo_screen_name":null,"weibo_avatar_url":null,"weibo_bound_at":null,"created_at":"2025-12-24T17:42:56","updated_at":"2026-09-08T19:18:00","admin_setup_completed":null}"#;
        assert_eq!(body, expected);
    }
}
