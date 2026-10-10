// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/market/subscriptions` — browse market subscriptions.
//!
//! Mirrors
//! `app.api.endpoints.adapter.subscription_market.discover_market_subscriptions`
//! (route `"/subscriptions"`, router prefix `/market`, under `/api`) and
//! `SubscriptionMarketService.discover_market_subscriptions`
//! (`app.services.subscription.market_service`).
//!
//! Source pipeline:
//! 1. FastAPI validates the query (`skip >= 0`, `1 <= limit <= 100`);
//!    `sort_by` and `search` stay free optional strings.
//! 2. `security.get_current_user` — JWT session decode plus the labeled
//!    `users` lookup (`auth::SessionUser`).
//! 3. Load every active Subscription `kinds` row
//!    (`kind = 'Subscription' AND is_active = true`), then keep the rows whose
//!    `spec.visibility` is `market` and whose whitelist admits the current user
//!    (`can_view_market_subscription`).
//! 4. Optional case-insensitive `search` over `displayName`/`description`.
//! 5. One additional query loads the current user's own active subscriptions to
//!    compute the rented source ids (`_get_user_rented_source_ids`).
//! 6. One `users` lookup per remaining item for `owner_username`.
//! 7. Stable sort by `rental_count` desc, else `updated_at` desc; `total` is
//!    the pre-pagination length; the page is `items[skip : skip + limit]`.
//!
//! The response model `MarketSubscriptionsListResponse` serializes `total`
//! then `items`; each `MarketSubscriptionDetail` keeps pydantic declaration
//! order (`id, name, display_name, description, task_type, trigger_type,
//! trigger_description, owner_user_id, owner_username, rental_count,
//! is_rented, created_at, updated_at`).
use std::collections::HashSet;

use brz_mysql::Mysql;
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::UserRow;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::subscriptions_list::KindRow;
use crate::subscriptions_list::convert::{
    internal_flag, internal_i64, internal_object, internal_string, market_whitelist_list,
    pydantic_datetime, validated_trigger_config,
};
use crate::user_reader::USER_BY_ID_QUERY;

/// Query parameters of the market discovery endpoint.
#[derive(Debug, Default, Deserialize)]
pub struct MarketListQuery {
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub skip: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
}

/// Validated discovery parameters.
#[derive(Debug)]
struct MarketListParams {
    sort_by: String,
    search: Option<String>,
    skip: i64,
    limit: i64,
}

impl MarketListQuery {
    /// Validate the FastAPI query contract: `skip >= 0`, `1 <= limit <= 100`.
    /// `sort_by` defaults to `rental_count`; an empty `search` is falsy like
    /// the source `if search:` and therefore filters nothing.
    fn validated(self) -> Result<MarketListParams, FastApiError> {
        let sort_by = self.sort_by.unwrap_or_else(|| "rental_count".to_string());
        let search = self.search.filter(|value| !value.is_empty());
        let skip = parse_i64(self.skip.as_deref(), "skip", 0, 0, i64::MAX)?;
        let limit = parse_i64(self.limit.as_deref(), "limit", 20, 1, 100)?;
        Ok(MarketListParams {
            sort_by,
            search,
            skip,
            limit,
        })
    }
}

/// Parse an optional integer query parameter with FastAPI-compatible
/// validation. The default is used when the parameter is absent.
fn parse_i64(
    raw: Option<&str>,
    field: &str,
    default: i64,
    min: i64,
    max: i64,
) -> Result<i64, FastApiError> {
    match raw {
        None => Ok(default),
        Some(value) => match value.parse::<i64>() {
            Ok(parsed) if parsed >= min && parsed <= max => Ok(parsed),
            Ok(_) => Err(validation_error(
                field,
                "greater_than_equal",
                "Input should be in the valid range",
                value,
            )),
            Err(_) => Err(validation_error(
                field,
                "int_parsing",
                "Input should be a valid integer, unable to parse string as an integer",
                value,
            )),
        },
    }
}

/// One FastAPI query-validation error entry (`detail[]`).
#[derive(Debug, Serialize)]
struct ValidationEntry<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: &'a str,
}

/// FastAPI-style 422 validation error body for one query parameter.
fn validation_error(field: &str, kind: &str, message: &str, input: &str) -> FastApiError {
    FastApiError::validation([ValidationEntry {
        kind,
        loc: ["query", field],
        msg: message,
        input,
    }])
}

/// `MarketSubscriptionsListResponse` — the top-level JSON body.
#[derive(Debug, Serialize)]
struct MarketSubscriptionsListResponse {
    total: usize,
    items: Vec<MarketSubscriptionItem>,
}

/// One `MarketSubscriptionDetail` item in pydantic field declaration order.
#[derive(Debug, Serialize)]
struct MarketSubscriptionItem {
    id: i32,
    name: String,
    display_name: String,
    description: Option<String>,
    task_type: String,
    trigger_type: String,
    trigger_description: String,
    owner_user_id: i32,
    owner_username: String,
    rental_count: i64,
    is_rented: bool,
    created_at: String,
    updated_at: String,
}

/// One built item together with the sort key that is not part of the response.
struct BuiltItem {
    item: MarketSubscriptionItem,
    updated_at: NaiveDateTime,
}

/// Inputs needed to project one market item (grouped to keep the projector's
/// argument list small).
struct ItemParts<'a> {
    json: &'a Value,
    id: i32,
    name: &'a str,
    owner_user_id: i32,
    owner_username: String,
    is_rented: bool,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

/// GET /api/market/subscriptions: the discover free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/market/subscriptions")]
async fn discover_market_subscriptions(
    #[inject(state)] state: &AppState,
    #[auth] current_user: crate::auth::SessionUser,
    query: brz_http_server::Query<MarketListQuery>,
) -> Result<MarketSubscriptionsListResponse, FastApiError> {
    market_subscriptions(state, &current_user, &query).await
}

/// Handler body for `GET /api/market/subscriptions`.
async fn market_subscriptions(
    state: &AppState,
    current_user: &crate::auth::SessionUser,
    query: &MarketListQuery,
) -> Result<MarketSubscriptionsListResponse, FastApiError> {
    let params = MarketListQuery {
        sort_by: query.sort_by.clone(),
        search: query.search.clone(),
        skip: query.skip.clone(),
        limit: query.limit.clone(),
    }
    .validated()?;

    let user_id = current_user.id;

    let rows = fetch_active_subscriptions(&state.mysql)
        .await
        .map_err(internal_error)?;

    // Keep subscriptions whose market visibility and whitelist admit the user.
    let mut market_rows: Vec<KindRow> = rows
        .into_iter()
        .filter(|row| is_market_visible(&row.json.0, row.user_id, user_id))
        .collect();

    // Apply the case-insensitive search over display name and description.
    if let Some(search) = params.search.as_deref() {
        let needle = search.to_lowercase();
        market_rows.retain(|row| matches_search(&row.json.0, &needle));
    }

    // `_get_user_rented_source_ids`: the current user's own rentals.
    let rented_source_ids = fetch_rented_source_ids(&state.mysql, user_id)
        .await
        .map_err(internal_error)?;

    // Build every item in query order, resolving each owner username.
    let mut built: Vec<BuiltItem> = Vec::with_capacity(market_rows.len());
    for row in &market_rows {
        let owner = fetch_owner(&state.mysql, row.user_id)
            .await
            .map_err(internal_error)?;
        let owner_username = owner
            .map(|user| user.user_name)
            .unwrap_or_else(|| "Unknown".to_string());
        let item = item_from_parts(ItemParts {
            json: &row.json.0,
            id: row.id,
            name: &row.name,
            owner_user_id: row.user_id,
            owner_username,
            is_rented: rented_source_ids.contains(&i64::from(row.id)),
            created_at: row.created_at,
            updated_at: row.updated_at,
        });
        built.push(BuiltItem {
            item,
            updated_at: row.updated_at,
        });
    }

    sort_items(&mut built, &params.sort_by);
    let total = built.len();
    let items = paginate(built, params.skip, params.limit);
    Ok(MarketSubscriptionsListResponse { total, items })
}

/// The source `db.query(Kind).filter(kind='Subscription', is_active=true)
/// .all()` rendering (SQLAlchemy labels every column `kinds_<name>`).
async fn fetch_active_subscriptions<M: Mysql>(
    mysql: &M,
) -> Result<Vec<KindRow>, brz_mysql::MysqlError> {
    let sql = format!(
        "SELECT {} \nFROM kinds \nWHERE kinds.kind = 'Subscription' AND kinds.is_active = true",
        KindRow::COLUMNS
    );
    mysql.fetch_all(sql, ()).await
}

/// The source `db.query(Kind).filter(user_id, kind='Subscription',
/// is_active=true).all()` rendering used by `_get_user_rented_source_ids`.
async fn fetch_rented_source_ids<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> Result<HashSet<i64>, brz_mysql::MysqlError> {
    let sql = format!(
        "SELECT {} \nFROM kinds \nWHERE kinds.user_id = ? AND kinds.kind = 'Subscription' \
         AND kinds.is_active = true",
        KindRow::COLUMNS
    );
    let rows: Vec<KindRow> = mysql.fetch_all(sql, (user_id,)).await?;
    let mut source_ids = HashSet::new();
    for row in rows {
        let internal = internal_object(&row.json.0);
        if internal_flag(&internal, "is_rental", false)
            && let Some(source_id) = internal_i64(&internal, "source_subscription_id")
            && source_id != 0
        {
            source_ids.insert(source_id);
        }
    }
    Ok(source_ids)
}

/// `db.query(User).filter(User.id == user_id).first()` for the item owner.
async fn fetch_owner<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> Result<Option<UserRow>, brz_mysql::MysqlError> {
    mysql.fetch_optional(USER_BY_ID_QUERY, (user_id,)).await
}

/// `can_view_market_subscription`: only `market` visibility is visible; the
/// owner always sees it; an empty whitelist admits everyone; otherwise the
/// current user must be listed.
fn is_market_visible(json: &Value, owner_user_id: i32, current_user_id: i32) -> bool {
    if spec_string(json, "visibility").unwrap_or("private") != "market" {
        return false;
    }
    if current_user_id == owner_user_id {
        return true;
    }
    let whitelist = market_whitelist_list(&internal_object(json));
    if whitelist.is_empty() {
        return true;
    }
    whitelist.contains(&i64::from(current_user_id))
}

/// The source `if search:` filter over the lowercased display name and
/// description (`search_lower in display_name or search_lower in description`).
fn matches_search(json: &Value, needle: &str) -> bool {
    let display_name = spec_string(json, "displayName").unwrap_or("");
    let description = spec_string(json, "description").unwrap_or("");
    display_name.to_lowercase().contains(needle) || description.to_lowercase().contains(needle)
}

/// Read one string field of the subscription `spec`.
fn spec_string<'a>(json: &'a Value, key: &str) -> Option<&'a str> {
    json.get("spec")
        .and_then(|spec| spec.get(key))
        .and_then(Value::as_str)
}

/// `_get_trigger_description`: the human-readable trigger description for the
/// item's `trigger_type` and extracted trigger config.
fn describe_trigger(trigger_type: &str, config: &Value) -> String {
    match trigger_type {
        "cron" => format!(
            "Cron: {} ({})",
            config
                .get("expression")
                .and_then(Value::as_str)
                .unwrap_or(""),
            config
                .get("timezone")
                .and_then(Value::as_str)
                .unwrap_or("UTC"),
        ),
        "interval" => format!(
            "Every {} {}",
            config.get("value").and_then(Value::as_i64).unwrap_or(1),
            config
                .get("unit")
                .and_then(Value::as_str)
                .unwrap_or("hours"),
        ),
        "one_time" => format!(
            "One time at {}",
            config
                .get("execute_at")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        "event" => format!(
            "Event: {}",
            config
                .get("event_type")
                .and_then(Value::as_str)
                .unwrap_or("webhook"),
        ),
        _ => "Unknown trigger".to_string(),
    }
}

/// Project one `MarketSubscriptionDetail` from its parts.
fn item_from_parts(parts: ItemParts<'_>) -> MarketSubscriptionItem {
    let json = parts.json;
    let internal = internal_object(json);
    let trigger = json
        .get("spec")
        .and_then(|spec| spec.get("trigger"))
        .cloned();
    let (trigger_config, _, _) = validated_trigger_config(&trigger);
    let trigger_type = internal_string(&internal, "trigger_type").unwrap_or_else(|| "cron".into());

    MarketSubscriptionItem {
        id: parts.id,
        name: parts.name.to_string(),
        display_name: spec_string(json, "displayName").unwrap_or("").to_string(),
        description: spec_string(json, "description").map(str::to_string),
        task_type: spec_string(json, "taskType")
            .unwrap_or("collection")
            .to_string(),
        trigger_type: trigger_type.clone(),
        trigger_description: describe_trigger(&trigger_type, &trigger_config),
        owner_user_id: parts.owner_user_id,
        owner_username: parts.owner_username,
        rental_count: internal_i64(&internal, "rental_count").unwrap_or(0),
        is_rented: parts.is_rented,
        created_at: pydantic_datetime(parts.created_at),
        updated_at: pydantic_datetime(parts.updated_at),
    }
}

/// Sort the built items (Python `list.sort` is stable): `rental_count` desc by
/// default, otherwise `updated_at` desc.
fn sort_items(built: &mut [BuiltItem], sort_by: &str) {
    if sort_by == "rental_count" {
        built.sort_by_key(|a| std::cmp::Reverse(a.item.rental_count));
    } else {
        built.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
    }
}

/// `items[skip : skip + limit]` with Python slice semantics.
fn paginate(built: Vec<BuiltItem>, skip: i64, limit: i64) -> Vec<MarketSubscriptionItem> {
    let mut items: Vec<MarketSubscriptionItem> =
        built.into_iter().map(|entry| entry.item).collect();
    let Ok(start) = usize::try_from(skip) else {
        return Vec::new();
    };
    if start >= items.len() {
        return Vec::new();
    }
    let Ok(limit) = usize::try_from(limit) else {
        return items.drain(start..).collect();
    };
    let end = start.saturating_add(limit).min(items.len());
    items.drain(start..end).collect()
}

/// Source `python_exception_handler` 500 response body
/// (`{"error_code": 500, "detail": "Internal server error"}`).
fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "market subscriptions database dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;
    use brz_http_server::StatusCode;
    use chrono::NaiveDate;
    use serde_json::json;

    fn dt(day: u32, hour: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, day)
            .unwrap()
            .and_hms_opt(hour, 0, 0)
            .unwrap()
    }

    fn market_json(visibility: &str) -> Value {
        json!({
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Subscription",
            "metadata": {"name": "sub", "namespace": "default"},
            "spec": {
                "displayName": "Display",
                "description": "Desc",
                "taskType": "collection",
                "visibility": visibility,
                "trigger": {
                    "type": "cron",
                    "cron": {"expression": "0 9 * * *", "timezone": "Asia/Shanghai"}
                }
            },
            "_internal": {"trigger_type": "cron", "rental_count": 7}
        })
    }

    fn parts(json: &Value) -> ItemParts<'_> {
        ItemParts {
            json,
            id: 42,
            name: "sub",
            owner_user_id: 100,
            owner_username: "owner".to_string(),
            is_rented: false,
            created_at: dt(1, 2),
            updated_at: dt(3, 4),
        }
    }

    #[test]
    fn default_query_matches_source_defaults() {
        let parsed = MarketListQuery::default().validated().unwrap();
        assert_eq!(parsed.sort_by, "rental_count");
        assert_eq!(parsed.skip, 0);
        assert_eq!(parsed.limit, 20);
        assert_eq!(parsed.search, None);
    }

    #[test]
    fn explicit_query_parses() {
        let parsed = MarketListQuery {
            sort_by: Some("recent".to_string()),
            search: Some("hot".to_string()),
            skip: Some("5".to_string()),
            limit: Some("50".to_string()),
        }
        .validated()
        .unwrap();
        assert_eq!(parsed.sort_by, "recent");
        assert_eq!(parsed.search.as_deref(), Some("hot"));
        assert_eq!(parsed.skip, 5);
        assert_eq!(parsed.limit, 50);
    }

    #[test]
    fn empty_search_is_falsy() {
        let parsed = MarketListQuery {
            search: Some(String::new()),
            ..Default::default()
        }
        .validated()
        .unwrap();
        assert_eq!(parsed.search, None);
    }

    #[test]
    fn rejects_out_of_range_params() {
        for query in [
            MarketListQuery {
                skip: Some("-1".to_string()),
                ..Default::default()
            },
            MarketListQuery {
                limit: Some("0".to_string()),
                ..Default::default()
            },
            MarketListQuery {
                limit: Some("101".to_string()),
                ..Default::default()
            },
        ] {
            let error = query.validated().unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
    }

    #[test]
    fn rejects_non_integer_params() {
        let error = MarketListQuery {
            skip: Some("abc".to_string()),
            ..Default::default()
        }
        .validated()
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(error.validation_detail().contains("int_parsing"));
    }

    #[test]
    fn visibility_rules_follow_can_view() {
        // Private visibility is never visible.
        assert!(!is_market_visible(&market_json("private"), 100, 1));
        // Market with an empty whitelist is visible to everyone.
        assert!(is_market_visible(&market_json("market"), 100, 1));
        // The owner always sees their own market subscription.
        assert!(is_market_visible(&market_json("market"), 100, 100));

        let mut restricted = market_json("market");
        restricted["_internal"]["market_whitelist_user_ids"] = json!([1, 3, 3, 0, -2]);
        assert!(is_market_visible(&restricted, 100, 1));
        assert!(!is_market_visible(&restricted, 100, 2));
    }

    #[test]
    fn search_matches_name_and_description_case_insensitively() {
        let json = market_json("market");
        assert!(matches_search(&json, "display"));
        assert!(matches_search(&json, "desc"));
        assert!(!matches_search(&json, "missing"));
    }

    #[test]
    fn describe_trigger_variants() {
        assert_eq!(
            describe_trigger(
                "cron",
                &json!({"expression": "0 9 * * *", "timezone": "Asia/Shanghai"})
            ),
            "Cron: 0 9 * * * (Asia/Shanghai)"
        );
        assert_eq!(
            describe_trigger("interval", &json!({"value": 4, "unit": "hours"})),
            "Every 4 hours"
        );
        assert_eq!(
            describe_trigger("one_time", &json!({"execute_at": "2026-01-01T00:00:00"})),
            "One time at 2026-01-01T00:00:00"
        );
        assert_eq!(
            describe_trigger("event", &json!({"event_type": "git_push"})),
            "Event: git_push"
        );
        assert_eq!(describe_trigger("mystery", &json!({})), "Unknown trigger");
    }

    #[test]
    fn item_uses_defaults_and_renders_datetimes() {
        let mut json = market_json("market");
        json["spec"].as_object_mut().unwrap().remove("displayName");
        json["spec"]["taskType"] = json!(null);
        let item = item_from_parts(parts(&json));
        assert_eq!(item.display_name, "");
        assert_eq!(item.task_type, "collection");
        assert_eq!(item.description.as_deref(), Some("Desc"));
        assert_eq!(item.rental_count, 7);
        assert_eq!(item.created_at, "2026-10-01T02:00:00");
        assert_eq!(item.updated_at, "2026-10-03T04:00:00");
    }

    #[test]
    fn item_keeps_pydantic_field_order() {
        let item = item_from_parts(parts(&market_json("market")));
        let rendered = crate::json_contract_tests::serialized(item).unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "id",
                "name",
                "display_name",
                "description",
                "task_type",
                "trigger_type",
                "trigger_description",
                "owner_user_id",
                "owner_username",
                "rental_count",
                "is_rented",
                "created_at",
                "updated_at",
            ]
        );
    }

    fn built(rental_count: i64, updated_at: NaiveDateTime) -> BuiltItem {
        BuiltItem {
            item: MarketSubscriptionItem {
                id: 0,
                name: String::new(),
                display_name: String::new(),
                description: None,
                task_type: String::new(),
                trigger_type: String::new(),
                trigger_description: String::new(),
                owner_user_id: 0,
                owner_username: String::new(),
                rental_count,
                is_rented: false,
                created_at: String::new(),
                updated_at: String::new(),
            },
            updated_at,
        }
    }

    #[test]
    fn rental_count_sort_is_descending_and_stable() {
        let mut items = vec![
            built(1, dt(1, 0)),
            built(5, dt(2, 0)),
            built(5, dt(3, 0)),
            built(3, dt(4, 0)),
        ];
        sort_items(&mut items, "rental_count");
        let ids: Vec<i64> = items.iter().map(|entry| entry.item.rental_count).collect();
        assert_eq!(ids, vec![5, 5, 3, 1]);
        // Ties preserve the original order (stable): the dt(2) row before dt(3).
        assert_eq!(items[0].updated_at, dt(2, 0));
        assert_eq!(items[1].updated_at, dt(3, 0));
    }

    #[test]
    fn recent_sort_is_descending_by_updated_at() {
        let mut items = vec![built(1, dt(1, 0)), built(9, dt(5, 0)), built(2, dt(3, 0))];
        sort_items(&mut items, "recent");
        let order: Vec<NaiveDateTime> = items.iter().map(|entry| entry.updated_at).collect();
        assert_eq!(order, vec![dt(5, 0), dt(3, 0), dt(1, 0)]);
    }

    #[test]
    fn paginate_matches_python_slice_semantics() {
        let make = |count: usize| {
            (0..count)
                .map(|index| built(index as i64, dt(1, 0)))
                .collect::<Vec<_>>()
        };
        assert_eq!(paginate(make(3), 0, 20).len(), 3);
        assert_eq!(paginate(make(3), 2, 20).len(), 1);
        assert_eq!(paginate(make(3), 5, 20).len(), 0);
        assert_eq!(paginate(make(5), 1, 2).len(), 2);
    }

    #[tokio::test]
    async fn active_subscription_query_matches_recorded_shape() {
        let mysql = KindQueryCapture::default();
        let _ = fetch_active_subscriptions(&mysql).await.unwrap();
        let captured = mysql.queries();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].args, 0);
        assert!(
            captured[0].sql.contains(
                "FROM kinds WHERE kinds.kind = 'Subscription' AND kinds.is_active = true"
            )
        );
    }

    #[tokio::test]
    async fn rented_source_query_binds_the_user_id() {
        let mysql = KindQueryCapture::default();
        let ids = fetch_rented_source_ids(&mysql, 157).await.unwrap();
        assert!(ids.is_empty());
        let captured = mysql.queries();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].args, 1);
        assert_eq!(captured[0].first_integer, Some(157));
        assert!(captured[0].sql.contains(
            "FROM kinds WHERE kinds.user_id = ? AND kinds.kind = 'Subscription' \
             AND kinds.is_active = true"
        ));
    }

    #[tokio::test]
    async fn owner_query_uses_the_by_id_projection() {
        let mysql = KindQueryCapture::default();
        let owner = fetch_owner(&mysql, 775).await.unwrap();
        assert!(owner.is_none());
        let captured = mysql.queries();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].first_integer, Some(775));
        assert!(
            captured[0]
                .sql
                .contains("FROM users WHERE users.id = ? LIMIT 1")
        );
    }
}
