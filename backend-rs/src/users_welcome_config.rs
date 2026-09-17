// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/welcome-config` — chat-page slogans and tips.
//!
//! Mirrors `app.api.endpoints.users.get_welcome_config`: authenticate the
//! bearer token, read the `chat_slogan_tips` `system_configs` row, and render
//! its `slogans`/`tips` items (falling back to the source
//! `DEFAULT_SLOGAN_TIPS_CONFIG` constants when the row or a list is absent).
//! Admin users additionally read the `admin_setup_completed` config;
//! everyone else serializes `admin_setup_completed: null`.
use crate::auth::{AuthFailure, UserRow, get_current_user};
use crate::http_compat::FastApiError;
use crate::json_compat::{JsonProjection, OpaqueJson};
use crate::state::AppState;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Deserialize;

/// `CHAT_SLOGAN_TIPS_CONFIG_KEY` (`app.api.endpoints.users`).
const CHAT_SLOGAN_TIPS_CONFIG_KEY: &str = "chat_slogan_tips";

/// `ADMIN_SETUP_CONFIG_KEY` (`app.api.endpoints.users`).
const ADMIN_SETUP_CONFIG_KEY: &str = "admin_setup_completed";

/// One `system_configs` row
/// (`db.query(SystemConfig).filter(SystemConfig.config_key == ...)`);
/// only `config_value` is consumed.
#[derive(Debug, FromMysqlRow)]
struct SystemConfigRow {
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_config_key: String,
    system_configs_config_value: Json<OpaqueJson>,
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_version: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_updated_by: Option<i64>,
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_created_at: Option<NaiveDateTime>,
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_updated_at: Option<NaiveDateTime>,
}

/// The source `db.query(SystemConfig)` statement for the welcome config,
/// rendered like the other `system_configs` reads with the config key
/// inlined as a text literal.
async fn system_config<M>(mysql: &M, config_key: &str) -> MysqlResult<Option<SystemConfigRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            format!(
                "SELECT system_configs.id AS system_configs_id, \
                 system_configs.config_key AS system_configs_config_key, \
                 system_configs.config_value AS system_configs_config_value, \
                 system_configs.version AS system_configs_version, \
                 system_configs.updated_by AS system_configs_updated_by, \
                 system_configs.created_at AS system_configs_created_at, \
                 system_configs.updated_at AS system_configs_updated_at \n\
                 FROM system_configs \n\
                 WHERE system_configs.config_key = '{config_key}' \n LIMIT 1"
            )
            .as_str(),
            (),
        )
        .await
}

/// The stored `mode` literal (`Literal["chat", "code", "both"]`); an
/// unrecognized value fails item validation like pydantic's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, serde::Serialize)]
enum WelcomeMode {
    #[serde(rename = "chat")]
    Chat,
    #[serde(rename = "code")]
    Code,
    #[serde(rename = "both")]
    Both,
}

/// One stored `ChatSloganItem`/`ChatTipItem` input (`id`, `zh`, `en`
/// required; `mode` optional). Unknown keys are ignored like pydantic v2.
#[derive(Debug, Clone, Deserialize)]
struct ItemInput {
    id: i64,
    zh: String,
    en: String,
    mode: Option<WelcomeMode>,
}

/// The stored `config_value` document; an absent list selects the source
/// default list (`config_value.get("slogans", DEFAULT[...])`).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct WelcomeConfigDoc {
    slogans: Option<Vec<JsonProjection<ItemInput>>>,
    tips: Option<Vec<JsonProjection<ItemInput>>>,
}

/// The `admin_setup_completed` config document (`completed` flag).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct AdminSetupDoc {
    completed: Option<bool>,
}

/// One serialized slogan/tip item, in the pydantic model's field order with
/// `mode` materialized to its `"both"` default when absent.
#[derive(Debug, PartialEq, serde::Serialize)]
struct WelcomeItem {
    id: i64,
    zh: String,
    en: String,
    mode: WelcomeMode,
}

impl From<ItemInput> for WelcomeItem {
    fn from(item: ItemInput) -> Self {
        Self {
            id: item.id,
            zh: item.zh,
            en: item.en,
            mode: item.mode.unwrap_or(WelcomeMode::Both),
        }
    }
}

/// `WelcomeConfigResponse` (`app.schemas.admin`), field order preserved.
#[derive(serde::Serialize)]
struct WelcomeConfigResponse {
    slogans: Vec<WelcomeItem>,
    tips: Vec<WelcomeItem>,
    admin_setup_completed: Option<bool>,
}

/// `DEFAULT_SLOGAN_TIPS_CONFIG["slogans"]` (two entries).
fn default_slogans() -> Vec<WelcomeItem> {
    vec![
        WelcomeItem {
            id: 1,
            zh: "今天有什么可以帮到你？".to_string(),
            en: "What can I help you with today?".to_string(),
            mode: WelcomeMode::Chat,
        },
        WelcomeItem {
            id: 2,
            zh: "让我们一起写代码吧".to_string(),
            en: "Let's code together".to_string(),
            mode: WelcomeMode::Code,
        },
    ]
}

/// `DEFAULT_SLOGAN_TIPS_CONFIG["tips"]` (eight entries).
fn default_tips() -> Vec<WelcomeItem> {
    let entry = |id, zh: &str, en: &str, mode| WelcomeItem {
        id,
        zh: zh.to_string(),
        en: en.to_string(),
        mode,
    };
    vec![
        entry(
            1,
            "试试问我任何问题，我会尽力帮助你",
            "Try asking me any question, I'll do my best to help",
            WelcomeMode::Chat,
        ),
        entry(
            2,
            "你可以上传文件让我帮你分析和处理",
            "You can upload files for me to analyze and process",
            WelcomeMode::Chat,
        ),
        entry(
            3,
            "我可以帮你总结文档、翻译内容或回答问题",
            "I can help you summarize documents, translate content, or answer questions",
            WelcomeMode::Chat,
        ),
        entry(
            4,
            "试试问我：帮我分析这段代码的性能问题",
            "Try asking: Help me analyze the performance issues in this code",
            WelcomeMode::Code,
        ),
        entry(
            5,
            "我可以帮你生成代码、修复 Bug 或重构现有代码",
            "I can help you generate code, fix bugs, or refactor existing code",
            WelcomeMode::Code,
        ),
        entry(
            6,
            "试试让我帮你编写单元测试或文档",
            "Try asking me to write unit tests or documentation",
            WelcomeMode::Code,
        ),
        entry(
            7,
            "我可以解释复杂的代码逻辑，帮助你理解代码库",
            "I can explain complex code logic and help you understand the codebase",
            WelcomeMode::Code,
        ),
        entry(
            8,
            "选择合适的智能体团队可以获得更好的回答",
            "Choosing the right agent team can get you better answers",
            WelcomeMode::Both,
        ),
    ]
}

/// Source `python_exception_handler` 500 response shape.
fn internal_error() -> FastApiError {
    FastApiError::json_body(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        serde_json::json!({"error_code": 500, "detail": "Internal server error"}),
    )
}

/// Render one stored list: an absent list selects the defaults; a present
/// list with an invalid item fails validation (pydantic `ValidationError` →
/// the source 500 handler).
fn welcome_items(
    stored: Option<Vec<JsonProjection<ItemInput>>>,
    defaults: Vec<WelcomeItem>,
) -> Result<Vec<WelcomeItem>, FastApiError> {
    match stored {
        None => Ok(defaults),
        Some(items) => items
            .into_iter()
            .map(|item| item.value.map(WelcomeItem::from).ok_or_else(internal_error))
            .collect(),
    }
}

/// `admin_setup_completed` for an admin user: the stored `completed` flag
/// when the config row holds a non-empty object, otherwise `false`.
async fn admin_setup_completed<M>(mysql: &M) -> Result<Option<bool>, FastApiError>
where
    M: Mysql,
{
    let setup = system_config(mysql, ADMIN_SETUP_CONFIG_KEY)
        .await
        .map_err(|_| internal_error())?;
    Ok(match setup {
        Some(row) if row.system_configs_config_value.0.is_nonempty_object() => row
            .system_configs_config_value
            .0
            .project::<AdminSetupDoc>()
            .and_then(|doc| doc.completed),
        _ => None,
    })
}

/// GET /api/users/welcome-config: the welcome-config free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/users/welcome-config")]
async fn get_welcome_config(
    #[inject(state)] state: &AppState,
    #[header] authorization: Option<&str>,
) -> Result<WelcomeConfigResponse, FastApiError> {
    welcome_config(state, authorization).await
}

/// Handler body for `GET /api/users/welcome-config`.
async fn welcome_config(
    state: &AppState,
    authorization: Option<&str>,
) -> Result<WelcomeConfigResponse, FastApiError> {
    let current_user: UserRow =
        match get_current_user(&state.auth, &state.mysql, authorization).await {
            Ok(user) => user,
            Err(AuthFailure::InvalidCredentials) => {
                return Err(FastApiError::unauthorized("Could not validate credentials"));
            }
            Err(AuthFailure::UserNotActivated) => {
                return Err(FastApiError::unauthorized("User not activated"));
            }
        };

    let config = system_config(&state.mysql, CHAT_SLOGAN_TIPS_CONFIG_KEY)
        .await
        .map_err(|_| internal_error())?;

    // An absent row (or a non-object document, which the source reads as an
    // empty dict) selects both default lists.
    let doc = config
        .map(|row| row.system_configs_config_value.0)
        .and_then(|value| value.project::<WelcomeConfigDoc>());

    let slogans = welcome_items(
        doc.as_ref().and_then(|doc| doc.slogans.clone()),
        default_slogans(),
    )?;
    let tips = welcome_items(
        doc.as_ref().and_then(|doc| doc.tips.clone()),
        default_tips(),
    )?;

    // Admin users get the setup-wizard status; everyone else keeps `null`.
    let admin_setup_completed = if current_user.role == "admin" {
        admin_setup_completed(&state.mysql).await?
    } else {
        None
    };

    Ok(WelcomeConfigResponse {
        slogans,
        tips,
        admin_setup_completed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse_doc(raw: &str) -> Option<WelcomeConfigDoc> {
        OpaqueJson::from(serde_json::from_str::<serde_json::Value>(raw).unwrap()).project()
    }

    #[test]
    fn config_keys_match_source_constants() {
        assert_eq!(CHAT_SLOGAN_TIPS_CONFIG_KEY, "chat_slogan_tips");
        assert_eq!(ADMIN_SETUP_CONFIG_KEY, "admin_setup_completed");
    }

    #[test]
    fn defaults_match_source_constants() {
        let slogans = default_slogans();
        assert_eq!(slogans.len(), 2);
        assert_eq!(slogans[0].id, 1);
        assert_eq!(slogans[0].mode, WelcomeMode::Chat);
        assert_eq!(slogans[1].mode, WelcomeMode::Code);

        let tips = default_tips();
        assert_eq!(tips.len(), 8);
        assert_eq!(tips[0].mode, WelcomeMode::Chat);
        assert_eq!(tips[7].id, 8);
        assert_eq!(tips[7].mode, WelcomeMode::Both);
    }

    #[test]
    fn stored_items_render_with_materialized_mode() {
        let doc = parse_doc(
            r#"{"slogans": [{"id": 1, "zh": "你好", "en": "Hi", "mode": "chat"},
                            {"id": 2, "zh": "写码", "en": "Code"}],
                "tips": [{"id": 1, "zh": "提示", "en": "Tip", "mode": "both"}]}"#,
        )
        .unwrap();
        let slogans = welcome_items(doc.slogans.clone(), default_slogans()).unwrap();
        assert_eq!(slogans.len(), 2);
        assert_eq!(slogans[0].mode, WelcomeMode::Chat);
        // Absent `mode` takes the pydantic default `"both"`.
        assert_eq!(slogans[1].mode, WelcomeMode::Both);
        assert_eq!(slogans[1].zh, "写码");

        let tips = welcome_items(doc.tips.clone(), default_tips()).unwrap();
        assert_eq!(tips.len(), 1);
        assert_eq!(tips[0].mode, WelcomeMode::Both);
    }

    #[test]
    fn absent_lists_select_defaults() {
        let doc = parse_doc("{}").unwrap();
        let slogans = welcome_items(doc.slogans.clone(), default_slogans()).unwrap();
        let tips = welcome_items(doc.tips.clone(), default_tips()).unwrap();
        assert_eq!(slogans, default_slogans());
        assert_eq!(tips, default_tips());
    }

    #[test]
    fn invalid_item_is_an_internal_error() {
        // `mode` outside the literal and a missing required field both fail
        // pydantic validation in the source and map to the 500 handler.
        let invalid_slogans =
            parse_doc(r#"{"slogans": [{"id": 1, "zh": "a", "en": "b", "mode": "weird"}]}"#)
                .unwrap();
        let error = welcome_items(invalid_slogans.slogans.clone(), default_slogans()).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );

        let invalid_tips = parse_doc(r#"{"tips": [{"id": 1, "zh": "a"}]}"#).unwrap();
        assert!(welcome_items(invalid_tips.tips.clone(), default_tips()).is_err());
    }

    #[test]
    fn unknown_item_keys_are_ignored() {
        let doc =
            parse_doc(r#"{"slogans": [{"id": 1, "zh": "a", "en": "b", "extra": true}]}"#).unwrap();
        let slogans = welcome_items(doc.slogans.clone(), default_slogans()).unwrap();
        assert_eq!(slogans.len(), 1);
        assert_eq!(slogans[0].mode, WelcomeMode::Both);
    }

    #[test]
    fn admin_setup_reads_completed_flag() {
        let setup = OpaqueJson::from(json!({"completed": true}));
        assert_eq!(
            setup
                .project::<AdminSetupDoc>()
                .and_then(|doc| doc.completed),
            Some(true)
        );
        // Missing flag defaults to `false` (`get("completed", False)`).
        assert_eq!(
            OpaqueJson::from(json!({"other": 1}))
                .project::<AdminSetupDoc>()
                .and_then(|doc| doc.completed),
            None
        );
    }

    #[test]
    fn response_field_order_matches_model() {
        let body = WelcomeConfigResponse {
            slogans: default_slogans(),
            tips: default_tips(),
            admin_setup_completed: None,
        };
        let value = crate::json_contract_tests::serialized(body).unwrap();
        let keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["slogans", "tips", "admin_setup_completed"]);
        assert_eq!(value["admin_setup_completed"], json!(null));
    }
}
