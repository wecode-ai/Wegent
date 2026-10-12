// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/system-config/slogan-tips` — the admin chat slogan and tips
//! configuration.
//!
//! Mirrors `app.api.endpoints.admin.system_config.get_slogan_tips_config`:
//! require an authenticated admin (`app.core.security.get_admin_user`), read
//! the `chat_slogan_tips` `system_configs` row, and render its `slogans`/`tips`
//! items. An absent row returns the source `DEFAULT_SLOGAN_TIPS_CONFIG` with
//! `version = 0`. A present row returns its stored `version`, its stored
//! `slogans` (falling back to the default slogan list when the key is absent),
//! and its stored `tips` (falling back to the empty list
//! `config_value.get("tips", [])`). An item that fails `ChatSloganItem` /
//! `ChatTipItem` validation renders the source `python_exception_handler` 500.
use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::json_compat::{JsonProjection, OpaqueJson};
use crate::state::AppState;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Deserialize;

/// `CHAT_SLOGAN_TIPS_CONFIG_KEY` (`app.api.endpoints.admin.system_config`).
const CHAT_SLOGAN_TIPS_CONFIG_KEY: &str = "chat_slogan_tips";

/// One `system_configs` row
/// (`db.query(SystemConfig).filter(SystemConfig.config_key == ...).first()`);
/// only `config_value` and `version` are consumed, but every mapped column is
/// selected to match the recorded exchange.
#[derive(Debug, FromMysqlRow)]
struct SystemConfigRow {
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_config_key: String,
    system_configs_config_value: Json<OpaqueJson>,
    system_configs_version: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_updated_by: Option<i64>,
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_created_at: Option<NaiveDateTime>,
    #[allow(dead_code, reason = "selected to match source column list")]
    system_configs_updated_at: Option<NaiveDateTime>,
}

/// The source `db.query(SystemConfig)` statement for one config key, rendered
/// like the other `system_configs` reads with the key inlined as a literal.
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
enum ItemMode {
    #[serde(rename = "chat")]
    Chat,
    #[serde(rename = "code")]
    Code,
    #[serde(rename = "both")]
    Both,
}

/// One stored `ChatSloganItem`/`ChatTipItem` input (`id`, `zh`, `en` required;
/// `mode` optional). Unknown keys are ignored like pydantic v2.
#[derive(Debug, Clone, Deserialize)]
struct ItemInput {
    id: i64,
    zh: String,
    en: String,
    mode: Option<ItemMode>,
}

/// The stored `config_value` document (`config_value.get("slogans", ...)` /
/// `config_value.get("tips", [])`); an absent list selects its source default.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SloganTipsDoc {
    slogans: Option<Vec<JsonProjection<ItemInput>>>,
    tips: Option<Vec<JsonProjection<ItemInput>>>,
}

/// One serialized slogan/tip item, in the pydantic model's field order with
/// `mode` materialized to its `"both"` default when absent.
#[derive(Debug, PartialEq, serde::Serialize)]
struct SloganTipItem {
    id: i64,
    zh: String,
    en: String,
    mode: ItemMode,
}

impl From<ItemInput> for SloganTipItem {
    fn from(item: ItemInput) -> Self {
        Self {
            id: item.id,
            zh: item.zh,
            en: item.en,
            mode: item.mode.unwrap_or(ItemMode::Both),
        }
    }
}

/// `ChatSloganTipsResponse` (`app.schemas.admin`), field order preserved.
#[derive(Debug, serde::Serialize)]
struct ChatSloganTipsResponse {
    version: i64,
    slogans: Vec<SloganTipItem>,
    tips: Vec<SloganTipItem>,
}

/// `DEFAULT_SLOGAN_TIPS_CONFIG["slogans"]` (two entries).
fn default_slogans() -> Vec<SloganTipItem> {
    vec![
        SloganTipItem {
            id: 1,
            zh: "今天有什么可以帮到你？".to_string(),
            en: "What can I help you with today?".to_string(),
            mode: ItemMode::Chat,
        },
        SloganTipItem {
            id: 2,
            zh: "让我们一起写代码吧".to_string(),
            en: "Let's code together".to_string(),
            mode: ItemMode::Code,
        },
    ]
}

/// `DEFAULT_SLOGAN_TIPS_CONFIG["tips"]` (five entries), used only when the
/// config row is absent.
fn default_tips() -> Vec<SloganTipItem> {
    let entry = |id, zh: &str, en: &str, mode| SloganTipItem {
        id,
        zh: zh.to_string(),
        en: en.to_string(),
        mode,
    };
    vec![
        entry(
            1,
            "试试问我：帮我分析这段代码的性能问题",
            "Try asking: Help me analyze the performance issues in this code",
            ItemMode::Code,
        ),
        entry(
            2,
            "你可以上传文件让我帮你处理",
            "You can upload files for me to help you process",
            ItemMode::Both,
        ),
        entry(
            3,
            "我可以帮你生成代码、修复 Bug 或重构现有代码",
            "I can help you generate code, fix bugs, or refactor existing code",
            ItemMode::Code,
        ),
        entry(
            4,
            "试试让我帮你编写单元测试或文档",
            "Try asking me to write unit tests or documentation",
            ItemMode::Code,
        ),
        entry(
            5,
            "我可以解释复杂的代码逻辑，帮助你理解代码库",
            "I can explain complex code logic and help you understand the codebase",
            ItemMode::Code,
        ),
    ]
}

/// Source `python_exception_handler` 500 response shape, used for a stored
/// item that fails validation or a read error.
fn internal_error() -> FastApiError {
    FastApiError::unhandled()
}

/// Render one stored list: an absent list selects its source default; a present
/// list with an invalid item fails validation (pydantic `ValidationError` →
/// the source 500 handler).
fn slogan_tip_items(
    stored: Option<Vec<JsonProjection<ItemInput>>>,
    defaults: Vec<SloganTipItem>,
) -> Result<Vec<SloganTipItem>, FastApiError> {
    match stored {
        None => Ok(defaults),
        Some(items) => items
            .into_iter()
            .map(|item| {
                item.value
                    .map(SloganTipItem::from)
                    .ok_or_else(internal_error)
            })
            .collect(),
    }
}

/// `get_admin_user`: a non-admin role renders
/// `403 {"detail": "Permission denied. Admin access required."}`.
fn require_admin(current_user: &UserRow) -> Result<(), FastApiError> {
    if current_user.role == "admin" {
        Ok(())
    } else {
        Err(FastApiError::forbidden(
            "Permission denied. Admin access required.",
        ))
    }
}

/// GET /api/admin/system-config/slogan-tips: the slogan/tips free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/admin/system-config/slogan-tips")]
async fn get_slogan_tips_config(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<ChatSloganTipsResponse, FastApiError> {
    slogan_tips_config(&state.mysql, current_user.0).await
}

/// Render a present `chat_slogan_tips` row: `config_value.get("slogans", ...)`
/// falling back to the default slogan list and `config_value.get("tips", [])`
/// falling back to the empty list.
fn stored_response(
    version: i64,
    document: &OpaqueJson,
) -> Result<ChatSloganTipsResponse, FastApiError> {
    let doc = document.project::<SloganTipsDoc>();
    let slogans = slogan_tip_items(
        doc.as_ref().and_then(|doc| doc.slogans.clone()),
        default_slogans(),
    )?;
    // `config_value.get("tips", [])`: a present row with an absent `tips` key
    // renders the empty list, not the default tips.
    let tips = slogan_tip_items(doc.and_then(|doc| doc.tips), Vec::new())?;
    Ok(ChatSloganTipsResponse {
        version,
        slogans,
        tips,
    })
}

/// Handler body for `GET /api/admin/system-config/slogan-tips`.
async fn slogan_tips_config<M>(
    mysql: &M,
    current_user: UserRow,
) -> Result<ChatSloganTipsResponse, FastApiError>
where
    M: Mysql,
{
    require_admin(&current_user)?;
    let config = system_config(mysql, CHAT_SLOGAN_TIPS_CONFIG_KEY)
        .await
        .map_err(|_| internal_error())?;
    match config {
        // An absent row returns the full default configuration with version 0.
        None => Ok(ChatSloganTipsResponse {
            version: 0,
            slogans: default_slogans(),
            tips: default_tips(),
        }),
        Some(row) => stored_response(
            row.system_configs_version,
            &row.system_configs_config_value.0,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;
    use chrono::NaiveDate;

    fn document(value: impl serde::Serialize) -> OpaqueJson {
        OpaqueJson::from_serializable(value)
    }

    fn user(role: &str) -> UserRow {
        UserRow {
            id: 1001,
            user_name: "example-user".to_string(),
            users_password_hash: "hash".to_string(),
            email: Some("example-user@example.invalid".to_string()),
            git_info: Json(OpaqueJson::from_serializable(())),
            is_active: 1,
            role: role.to_string(),
            auth_source: "dingtalk".to_string(),
            preferences: "{}".to_string(),
            created_at: NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
        }
    }

    #[test]
    fn config_key_matches_source_constant() {
        assert_eq!(CHAT_SLOGAN_TIPS_CONFIG_KEY, "chat_slogan_tips");
    }

    #[test]
    fn default_slogans_match_source_constants() {
        let slogans = default_slogans();
        assert_eq!(slogans.len(), 2);
        assert_eq!(slogans[0].id, 1);
        assert_eq!(slogans[0].zh, "今天有什么可以帮到你？");
        assert_eq!(slogans[0].mode, ItemMode::Chat);
        assert_eq!(slogans[1].id, 2);
        assert_eq!(slogans[1].mode, ItemMode::Code);
    }

    #[test]
    fn default_tips_match_source_constants() {
        let tips = default_tips();
        assert_eq!(tips.len(), 5);
        assert_eq!(tips[0].zh, "试试问我：帮我分析这段代码的性能问题");
        assert_eq!(tips[0].mode, ItemMode::Code);
        assert_eq!(tips[1].zh, "你可以上传文件让我帮你处理");
        assert_eq!(tips[1].mode, ItemMode::Both);
        assert_eq!(tips[4].id, 5);
        assert_eq!(tips[4].mode, ItemMode::Code);
    }

    #[test]
    fn stored_items_render_with_materialized_mode() {
        #[derive(serde::Serialize)]
        struct StoredItem<'a> {
            id: i64,
            zh: &'a str,
            en: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            mode: Option<&'a str>,
        }
        #[derive(serde::Serialize)]
        struct StoredDoc<'a> {
            slogans: Vec<StoredItem<'a>>,
            tips: Vec<StoredItem<'a>>,
        }
        let doc = document(StoredDoc {
            slogans: vec![
                StoredItem {
                    id: 1,
                    zh: "你好",
                    en: "Hi",
                    mode: Some("chat"),
                },
                StoredItem {
                    id: 2,
                    zh: "写码",
                    en: "Code",
                    mode: None,
                },
            ],
            tips: vec![StoredItem {
                id: 1,
                zh: "提示",
                en: "Tip",
                mode: Some("both"),
            }],
        });
        let projected = doc.project::<SloganTipsDoc>().unwrap();
        let slogans = slogan_tip_items(projected.slogans.clone(), default_slogans()).unwrap();
        assert_eq!(slogans.len(), 2);
        assert_eq!(slogans[0].mode, ItemMode::Chat);
        // An absent `mode` takes the pydantic default `"both"`.
        assert_eq!(slogans[1].mode, ItemMode::Both);
        assert_eq!(slogans[1].zh, "写码");

        // A present `tips` list renders its own items.
        let tips = slogan_tip_items(projected.tips, Vec::new()).unwrap();
        assert_eq!(tips.len(), 1);
        assert_eq!(tips[0].mode, ItemMode::Both);
        assert_eq!(tips[0].zh, "提示");
    }

    /// `config_value = {"slogans": [...]}` with no `tips` key: the slogans are
    /// the stored list and the tips fall back to the empty list (not the
    /// source default tips), while the row's `version` is preserved.
    #[test]
    fn stored_row_defaults_tips_to_empty_list() {
        #[derive(serde::Serialize)]
        struct Item<'a> {
            id: i64,
            zh: &'a str,
            en: &'a str,
        }
        #[derive(serde::Serialize)]
        struct Doc<'a> {
            slogans: Vec<Item<'a>>,
        }
        let response = stored_response(
            68,
            &document(Doc {
                slogans: vec![Item {
                    id: 7,
                    zh: "你好",
                    en: "Hi",
                }],
            }),
        )
        .unwrap();
        assert_eq!(response.version, 68);
        assert_eq!(response.slogans.len(), 1);
        assert_eq!(response.slogans[0].id, 7);
        assert_eq!(response.slogans[0].mode, ItemMode::Both);
        assert!(response.tips.is_empty());

        // An absent `slogans` key falls back to the source default list.
        #[derive(serde::Serialize)]
        struct Empty {}
        let response = stored_response(3, &document(Empty {})).unwrap();
        assert_eq!(response.version, 3);
        assert_eq!(response.slogans, default_slogans());
        assert!(response.tips.is_empty());
    }

    #[test]
    fn invalid_item_is_an_internal_error() {
        // `mode` outside the literal and a missing required field both fail
        // pydantic validation in the source and map to the 500 handler.
        #[derive(serde::Serialize)]
        struct BadItem<'a> {
            id: i64,
            zh: &'a str,
            en: &'a str,
            mode: &'a str,
        }
        #[derive(serde::Serialize)]
        struct BadDoc<'a> {
            slogans: Vec<BadItem<'a>>,
        }
        let bad = document(BadDoc {
            slogans: vec![BadItem {
                id: 1,
                zh: "a",
                en: "b",
                mode: "weird",
            }],
        });
        let projected = bad.project::<SloganTipsDoc>().unwrap();
        let error = slogan_tip_items(projected.slogans.clone(), default_slogans()).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );

        #[derive(serde::Serialize)]
        struct Missing<'a> {
            id: i64,
            zh: &'a str,
        }
        #[derive(serde::Serialize)]
        struct MissingDoc<'a> {
            tips: Vec<Missing<'a>>,
        }
        let missing = document(MissingDoc {
            tips: vec![Missing { id: 1, zh: "a" }],
        });
        let projected = missing.project::<SloganTipsDoc>().unwrap();
        assert!(slogan_tip_items(projected.tips.clone(), Vec::new()).is_err());
    }

    #[test]
    fn unknown_item_keys_are_ignored() {
        #[derive(serde::Serialize)]
        struct Item<'a> {
            id: i64,
            zh: &'a str,
            en: &'a str,
            extra: bool,
        }
        #[derive(serde::Serialize)]
        struct Doc<'a> {
            slogans: Vec<Item<'a>>,
        }
        let doc = document(Doc {
            slogans: vec![Item {
                id: 1,
                zh: "a",
                en: "b",
                extra: true,
            }],
        });
        let projected = doc.project::<SloganTipsDoc>().unwrap();
        let slogans = slogan_tip_items(projected.slogans.clone(), default_slogans()).unwrap();
        assert_eq!(slogans.len(), 1);
        assert_eq!(slogans[0].mode, ItemMode::Both);
    }

    #[tokio::test]
    async fn absent_row_selects_defaults_with_version_zero() {
        let mysql = KindQueryCapture::default();
        let response = slogan_tips_config(&mysql, user("admin")).await.unwrap();
        assert_eq!(response.version, 0);
        assert_eq!(response.slogans, default_slogans());
        assert_eq!(response.tips, default_tips());

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM system_configs"));
        assert!(
            queries[0]
                .sql
                .contains("WHERE system_configs.config_key = 'chat_slogan_tips'")
        );
        assert_eq!(queries[0].args, 0);
    }

    #[tokio::test]
    async fn non_admin_is_forbidden_without_a_read() {
        let mysql = KindQueryCapture::default();
        let error = slogan_tips_config(&mysql, user("user")).await.unwrap_err();
        assert_eq!(error.status(), brz_http_server::StatusCode::FORBIDDEN);
        assert_eq!(
            error.validation_detail(),
            "\"Permission denied. Admin access required.\""
        );
        assert!(mysql.queries().is_empty());
    }

    #[test]
    fn response_serializes_in_pydantic_field_order() {
        let response = ChatSloganTipsResponse {
            version: 68,
            slogans: default_slogans(),
            tips: default_tips(),
        };
        let rendered = crate::json_contract_tests::serialized(response).unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["version", "slogans", "tips"]);
        let item_keys: Vec<&str> = rendered["slogans"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(item_keys, ["id", "zh", "en", "mode"]);
        // FastAPI renders UTF-8 raw (`ensure_ascii=False`).
        assert_eq!(rendered["slogans"][0]["zh"], "今天有什么可以帮到你？");
        assert_eq!(rendered["slogans"][0]["mode"], "chat");
    }
}
