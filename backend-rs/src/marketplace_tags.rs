// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared marketplace tag catalog read
//! (`app.services.marketplace_tag_service.MarketplaceTagService.get_config`).
//!
//! `GET /api/admin/system-config/marketplace-tags` (`admin_marketplace_tags`)
//! and `GET /api/resource-library/tags` (`resource_library_tags`) render the
//! same versioned catalog, so the read logic lives here. Both callers apply
//! their own authentication and then delegate to [`get_config`]: read the
//! `marketplace_tags` `system_configs` row and render its `items` sorted by
//! `(sort, id)`. An absent row selects the source `DEFAULT_MARKETPLACE_TAGS`
//! catalog with `version = 0`; a stored item that fails `MarketplaceTagItem`
//! validation renders the source `python_exception_handler` 500.
use crate::http_compat::FastApiError;
use crate::json_compat::{JsonProjection, OpaqueJson};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

/// `MARKETPLACE_TAGS_CONFIG_KEY` (`app.services.marketplace_tag_service`).
pub(crate) const MARKETPLACE_TAGS_CONFIG_KEY: &str = "marketplace_tags";

/// `MarketplaceTagItem` field bounds (`app.schemas.marketplace_tags`).
const ID_MAX_CHARS: usize = 50;
const NAME_MAX_CHARS: usize = 100;
const SORT_MAX: i64 = 1_000_000;

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

/// One catalog entry (`MarketplaceTagItem`), in the pydantic model's field
/// order with `enabled` materialized to its `True` default.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct MarketplaceTagItem {
    pub(crate) id: String,
    pub(crate) name_zh: String,
    pub(crate) name_en: String,
    pub(crate) sort: i64,
    pub(crate) enabled: bool,
}

/// `MarketplaceTagsResponse` (`app.schemas.marketplace_tags`), field order
/// preserved.
#[derive(Debug, serde::Serialize)]
pub(crate) struct MarketplaceTagsResponse {
    pub(crate) version: i64,
    pub(crate) items: Vec<MarketplaceTagItem>,
}

/// One stored entry as written by `MarketplaceTagItem.model_dump()`; the
/// constraint checks run afterwards so a violation maps to the source 500.
#[derive(Debug, serde::Deserialize)]
struct StoredItem {
    id: String,
    name_zh: String,
    name_en: String,
    sort: i64,
    #[serde(default = "default_enabled")]
    enabled: bool,
}

/// The pydantic `MarketplaceTagItem.enabled` default (`True`).
fn default_enabled() -> bool {
    true
}

/// The stored `config_value` document (`(config_value or {}).get("items")`).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct MarketplaceTagsDoc {
    items: Option<Vec<JsonProjection<StoredItem>>>,
}

/// `DEFAULT_MARKETPLACE_TAGS` (`app.services.marketplace_tag_service`).
pub(crate) fn default_items() -> Vec<MarketplaceTagItem> {
    let entry = |id: &str, name_zh: &str, name_en: &str, sort| MarketplaceTagItem {
        id: id.to_string(),
        name_zh: name_zh.to_string(),
        name_en: name_en.to_string(),
        sort,
        enabled: true,
    };
    vec![
        entry("product_design", "产品与设计", "Product & Design", 10),
        entry(
            "technical_development",
            "技术开发",
            "Technical Development",
            20,
        ),
        entry(
            "marketing_operations",
            "市场与运营",
            "Marketing & Operations",
            30,
        ),
        entry("content_creation", "内容创作", "Content Creation", 40),
        entry("data_analysis", "数据分析", "Data Analysis", 50),
        entry(
            "sales_customer_service",
            "销售与客服",
            "Sales & Customer Service",
            60,
        ),
        entry("human_resources", "人力资源", "Human Resources", 70),
        entry("finance", "财务管理", "Finance", 80),
        entry("legal_security", "法务与安全", "Legal & Security", 90),
        entry("daily_work", "日常工作", "Daily Work", 100),
    ]
}

/// Source `python_exception_handler` 500 response shape, used for a stored
/// item that fails `MarketplaceTagItem` validation or a read error.
fn internal_error() -> FastApiError {
    FastApiError::unhandled()
}

/// One `strip()`ed text field with a non-empty and maximum code-point length
/// (`Field(min_length=1, max_length=...)`); the pydantic `mode="before"`
/// validator strips before the bounds are measured.
fn bounded_text(text: &str, max_chars: usize) -> Option<String> {
    let trimmed = text.trim();
    let length = trimmed.chars().count();
    (length >= 1 && length <= max_chars).then(|| trimmed.to_string())
}

/// `MarketplaceTagItem.model_validate(item)`; `None` is a validation failure.
fn valid_item(stored: StoredItem) -> Option<MarketplaceTagItem> {
    let id = bounded_text(&stored.id, ID_MAX_CHARS)?;
    if !id
        .bytes()
        .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_'))
    {
        return None;
    }
    if !(0..=SORT_MAX).contains(&stored.sort) {
        return None;
    }
    Some(MarketplaceTagItem {
        id,
        name_zh: bounded_text(&stored.name_zh, NAME_MAX_CHARS)?,
        name_en: bounded_text(&stored.name_en, NAME_MAX_CHARS)?,
        sort: stored.sort,
        enabled: stored.enabled,
    })
}

/// `(config.config_value or {}).get("items", [])` followed by
/// `[MarketplaceTagItem.model_validate(item) for item in raw_items]`.
///
/// A non-object document is read as `{}` (an absent/falsy value) and an empty
/// `items` list means no tags; a document whose `items` cannot be projected,
/// or a stored item that fails validation, maps to the source 500.
fn config_items(document: &OpaqueJson) -> Result<Vec<MarketplaceTagItem>, FastApiError> {
    let stored = match document.project::<MarketplaceTagsDoc>() {
        Some(doc) => doc.items,
        None if document.is_nonempty_object() => return Err(internal_error()),
        None => None,
    };
    match stored {
        None => Ok(Vec::new()),
        Some(items) => items
            .into_iter()
            .map(|item| item.value.and_then(valid_item).ok_or_else(internal_error))
            .collect(),
    }
}

/// `MarketplaceTagService._sorted_items`: `(sort, id)` ascending.
pub(crate) fn sorted_items(mut items: Vec<MarketplaceTagItem>) -> Vec<MarketplaceTagItem> {
    items.sort_by(|left, right| (left.sort, &left.id).cmp(&(right.sort, &right.id)));
    items
}

/// `MarketplaceTagService.get_config`: the persisted catalog, or the default
/// catalog with `version = 0` when no `marketplace_tags` row exists.
pub(crate) async fn get_config<M>(mysql: &M) -> Result<MarketplaceTagsResponse, FastApiError>
where
    M: Mysql,
{
    let config = system_config(mysql, MARKETPLACE_TAGS_CONFIG_KEY)
        .await
        .map_err(|_| internal_error())?;
    let (version, items) = match config {
        None => (0, sorted_items(default_items())),
        Some(row) => (
            row.system_configs_version,
            sorted_items(config_items(&row.system_configs_config_value.0)?),
        ),
    };
    Ok(MarketplaceTagsResponse { version, items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    /// A stored catalog entry serialized exactly as `model_dump()` writes it.
    #[derive(serde::Serialize)]
    struct StoredItemJson<'a> {
        id: &'a str,
        name_zh: &'a str,
        name_en: &'a str,
        sort: i64,
        enabled: bool,
    }

    #[derive(serde::Serialize)]
    struct StoredDocJson<'a> {
        items: Vec<StoredItemJson<'a>>,
    }

    fn document(value: impl serde::Serialize) -> OpaqueJson {
        OpaqueJson::from_serializable(value)
    }

    #[test]
    fn config_key_matches_source_constant() {
        assert_eq!(MARKETPLACE_TAGS_CONFIG_KEY, "marketplace_tags");
    }

    #[test]
    fn default_catalog_matches_source() {
        let items = default_items();
        assert_eq!(items.len(), 10);
        assert_eq!(items[0].id, "product_design");
        assert_eq!(items[0].name_zh, "产品与设计");
        assert_eq!(items[0].name_en, "Product & Design");
        assert_eq!(items[0].sort, 10);
        assert!(items.iter().all(|item| item.enabled));
        assert_eq!(items[9].id, "daily_work");
        assert_eq!(items[9].sort, 100);
        // The defaults are already in `(sort, id)` order.
        assert_eq!(sorted_items(default_items()), items);
    }

    #[test]
    fn valid_item_is_stripped_and_defaults_enabled() {
        let items = config_items(&document(StoredDocJson {
            items: vec![StoredItemJson {
                id: "product_design",
                name_zh: " 产品与设计 ",
                name_en: "Product & Design",
                sort: 10,
                enabled: true,
            }],
        }))
        .unwrap();
        assert_eq!(
            items,
            vec![MarketplaceTagItem {
                id: "product_design".to_string(),
                name_zh: "产品与设计".to_string(),
                name_en: "Product & Design".to_string(),
                sort: 10,
                enabled: true,
            }]
        );
    }

    /// An item stored without `enabled` takes the pydantic `True` default.
    #[test]
    fn stored_item_without_enabled_defaults_true() {
        #[derive(serde::Serialize)]
        struct Item<'a> {
            id: &'a str,
            name_zh: &'a str,
            name_en: &'a str,
            sort: i64,
        }
        #[derive(serde::Serialize)]
        struct Doc<'a> {
            items: Vec<Item<'a>>,
        }
        let items = config_items(&document(Doc {
            items: vec![Item {
                id: "product_design",
                name_zh: "产品与设计",
                name_en: "Product & Design",
                sort: 10,
            }],
        }))
        .unwrap();
        assert!(items[0].enabled);
    }

    #[test]
    fn config_items_reads_and_orders_stored_list() {
        let items = config_items(&document(StoredDocJson {
            items: vec![
                StoredItemJson {
                    id: "b",
                    name_zh: "乙",
                    name_en: "B",
                    sort: 10,
                    enabled: false,
                },
                StoredItemJson {
                    id: "a",
                    name_zh: "甲",
                    name_en: "A",
                    sort: 10,
                    enabled: true,
                },
                StoredItemJson {
                    id: "c",
                    name_zh: "丙",
                    name_en: "C",
                    sort: 5,
                    enabled: true,
                },
            ],
        }))
        .unwrap();
        let ordered = sorted_items(items);
        let ids: Vec<&str> = ordered.iter().map(|item| item.id.as_str()).collect();
        // `(sort, id)`: (5, c), (10, a), (10, b).
        assert_eq!(ids, ["c", "a", "b"]);
        assert!(!ordered[2].enabled);
    }

    #[test]
    fn absent_or_empty_documents_have_no_items() {
        #[derive(serde::Serialize)]
        struct Empty {}
        // `{}`, `null` and an empty list all read as no tags.
        assert!(config_items(&document(Empty {})).unwrap().is_empty());
        assert!(
            config_items(&document(Option::<u8>::None))
                .unwrap()
                .is_empty()
        );
        assert!(
            config_items(&document(Vec::<u8>::new()))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn invalid_stored_items_are_internal_errors() {
        let bad_doc = |item: StoredItemJson<'_>| {
            config_items(&document(StoredDocJson { items: vec![item] })).unwrap_err()
        };
        // Uppercase / hyphen / whitespace-only / over-long ids violate the
        // `^[a-z0-9_]+$` pattern or the length bound.
        for id in ["Product", "a-b", "   ", &"x".repeat(51)] {
            let error = bad_doc(StoredItemJson {
                id,
                name_zh: "甲",
                name_en: "A",
                sort: 10,
                enabled: true,
            });
            assert_eq!(
                error.status(),
                brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
            );
        }
        // Empty and over-long names fail the length bounds.
        let error = bad_doc(StoredItemJson {
            id: "a",
            name_zh: "",
            name_en: "A",
            sort: 10,
            enabled: true,
        });
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
        // `sort` outside `0..=1_000_000`.
        let error = bad_doc(StoredItemJson {
            id: "a",
            name_zh: "甲",
            name_en: "A",
            sort: 1_000_001,
            enabled: true,
        });
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    /// `{"items": 7}` fails `Vec` projection on a non-empty object.
    #[test]
    fn non_array_items_is_an_internal_error() {
        #[derive(serde::Serialize)]
        struct Doc {
            items: i64,
        }
        let error = config_items(&document(Doc { items: 7 })).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    /// A stored item missing a required field fails projection.
    #[test]
    fn item_missing_required_field_is_an_internal_error() {
        #[derive(serde::Serialize)]
        struct Item<'a> {
            id: &'a str,
        }
        #[derive(serde::Serialize)]
        struct Doc<'a> {
            items: Vec<Item<'a>>,
        }
        let error = config_items(&document(Doc {
            items: vec![Item {
                id: "product_design",
            }],
        }))
        .unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[tokio::test]
    async fn absent_row_selects_defaults_with_version_zero() {
        let mysql = KindQueryCapture::default();
        let response = get_config(&mysql).await.unwrap();
        assert_eq!(response.version, 0);
        assert_eq!(response.items, default_items());

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM system_configs"));
        assert!(
            queries[0]
                .sql
                .contains("WHERE system_configs.config_key = 'marketplace_tags'")
        );
        assert_eq!(queries[0].args, 0);
    }

    #[test]
    fn response_serializes_in_pydantic_field_order() {
        let response = MarketplaceTagsResponse {
            version: 3,
            items: vec![MarketplaceTagItem {
                id: "product_design".to_string(),
                name_zh: "产品与设计".to_string(),
                name_en: "Product & Design".to_string(),
                sort: 10,
                enabled: true,
            }],
        };
        let rendered = crate::json_contract_tests::serialized(response).unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["version", "items"]);
        let item_keys: Vec<&str> = rendered["items"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(item_keys, ["id", "name_zh", "name_en", "sort", "enabled"]);
        // FastAPI renders UTF-8 raw (`ensure_ascii=False`).
        assert_eq!(rendered["items"][0]["name_zh"], "产品与设计");
    }
}
