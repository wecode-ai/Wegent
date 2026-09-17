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
    // The source stores `datetime.now(timezone.utc).isoformat()` output;
    // accept both the offset and the naive forms.
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|datetime| datetime.naive_local())
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S"))
        .ok()
        .map(|datetime| datetime.format("%Y-%m-%dT%H:%M:%S%.f").to_string())
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
        assert_eq!(body["weibo_bound_at"], json!("2026-09-08T11:18:00.125454"));
        // The weibo_binding preference stays inside preferences too,
        // echoed verbatim (including its untrimmed uid).
        assert_eq!(
            body["preferences"]["weibo_binding"]["uid"],
            json!(" 12345 ")
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
        let expected = r#"{"user_name":"qinyong","email":"qinyong@example.invalid","is_active":true,"id":2067,"git_info":null,"preferences":{"employee_id":null,"send_key":"enter","search_key":"cmd_k","memory_enabled":false,"chat_status_items":null,"tool_output_guard_enabled":false,"mcp_provider_keys":null,"quick_access":null,"default_execution_target":null,"wework_new_chat_model_selection":{"modelName":"openai-gpt-5.5(海外)","modelType":"public","options":{"reasoning":"high","weworkCloudModelNamespace":"default","weworkCloudModelResourceUserId":"0"}},"wework_project_execution_mode":"current_workspace","sina_mail":null,"weibo_binding":null,"wework_project_work_preferences":{},"runtime_configs":{}},"role":"user","auth_source":"dingtalk","weibo_uid":null,"weibo_screen_name":null,"weibo_avatar_url":null,"weibo_bound_at":null,"created_at":"2025-12-24T17:42:56","updated_at":"2026-09-08T19:18:00","admin_setup_completed":null}"#;
        assert_eq!(body, expected);
    }
}
