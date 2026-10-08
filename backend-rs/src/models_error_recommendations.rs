// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/models/error-recommendations` — model recommendations per error
//! type.
//!
//! Mirrors `app.api.endpoints.adapter.models.get_error_recommendations`: verify
//! the bearer JWT via `get_current_user`, parse the
//! `ERROR_MODEL_RECOMMENDATIONS` setting, and filter each configured model name
//! against the visible public models (`public_model_service.get_models` with
//! `skip=0, limit=1000`).
//!
//! The source returns `{"data": {}}` on any configuration failure (missing or
//! empty setting, invalid JSON, non-dict payload) and never reads the models
//! table in that case. Text like an empty `description` or an unmatched model
//! name is preserved rather than dropped, so the frontend can distinguish an
//! explicitly configured entry from a missing error type.
use std::collections::BTreeMap;

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::json_compat::{JsonProjection, OpaqueJson};
use crate::models_unified::models::{ModelInfo, extract_model_info, is_public_model_visible};
use crate::state::AppState;

/// `settings.ERROR_MODEL_RECOMMENDATIONS` (`app.core.config`).
const ERROR_MODEL_RECOMMENDATIONS_ENV: &str = "ERROR_MODEL_RECOMMENDATIONS";

/// The source `public_model_service.get_models(..., limit=1000)` bound.
const PUBLIC_MODEL_LIMIT: usize = 1000;

/// The source `db.query(Kind)` statement of `PublicModelService.get_models`:
/// every mapped column aliased `kinds_<column>` like SQLAlchemy's labeled
/// rendering, newest first. Only `name` and `json` are decoded.
const PUBLIC_MODELS_SQL: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
     kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at \n\
     FROM kinds \n\
     WHERE kinds.user_id = 0 AND kinds.kind = 'Model' AND kinds.namespace = 'default' \
     AND kinds.is_active = true ORDER BY kinds.created_at DESC";

/// One `kinds` row projected to the columns the recommendation reads.
#[derive(Debug, FromMysqlRow)]
struct PublicModelRow {
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_json")]
    json: Json<OpaqueJson>,
}

/// `entry.get("models", [])`: an absent or non-list value is the empty list,
/// and each element is kept only when it is a JSON string.
type ConfiguredNames = Option<JsonProjection<Vec<JsonProjection<String>>>>;

/// One recommendation entry (`_load_error_recommendations_config` keep + the
/// `description`/`models` reads of `_build_error_recommendation_entry`).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RecommendationEntryInput {
    description: Option<OpaqueJson>,
    models: ConfiguredNames,
}

/// `_public_model_to_recommendation` (`UnifiedModel` shape in the source).
#[derive(Debug, Clone, Serialize)]
struct RecommendedModel {
    name: String,
    #[serde(rename = "type")]
    model_type: &'static str,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    provider: Option<String>,
    #[serde(rename = "modelId")]
    model_id: Option<String>,
    #[serde(rename = "modelCategoryType")]
    model_category_type: String,
    #[serde(rename = "isAdvanced")]
    is_advanced: bool,
}

impl RecommendedModel {
    fn from_info(name: &str, info: ModelInfo) -> Self {
        Self {
            name: name.to_string(),
            model_type: "public",
            display_name: info.display_name,
            provider: info.provider,
            model_id: info.model_id,
            model_category_type: info.model_category_type,
            is_advanced: info.is_advanced,
        }
    }
}

/// One rendered recommendation entry: `description` precedes `models`, and
/// `description` stays whatever the configuration held (default `""`).
#[derive(Debug, Serialize)]
struct RecommendationEntry {
    description: OpaqueJson,
    models: Vec<RecommendedModel>,
}

/// An insertion-ordered JSON object. Python dicts keep their insertion order,
/// so both the parsed configuration and the rendered `data` object preserve it.
#[derive(Debug)]
struct OrderedMap<V>(Vec<(String, V)>);

impl<'de, V: Deserialize<'de>> Deserialize<'de> for OrderedMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedMapVisitor<V>(std::marker::PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for OrderedMapVisitor<V> {
            type Value = OrderedMap<V>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<OrderedMap<V>, A::Error> {
                let mut entries = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, V>()? {
                    entries.push((key, value));
                }
                Ok(OrderedMap(entries))
            }
        }
        deserializer.deserialize_map(OrderedMapVisitor(std::marker::PhantomData))
    }
}

impl<V: Serialize> Serialize for OrderedMap<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_map(self.0.iter().map(|(key, value)| (key.as_str(), value)))
    }
}

/// `{"data": {...}}` (`get_error_recommendations`).
#[derive(Debug, Serialize)]
struct ErrorRecommendationsResponse {
    data: OrderedMap<RecommendationEntry>,
}

impl ErrorRecommendationsResponse {
    fn empty() -> Self {
        Self {
            data: OrderedMap(Vec::new()),
        }
    }
}

/// GET /api/models/error-recommendations: the error-recommendations free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/models/error-recommendations")]
async fn get_error_recommendations(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<ErrorRecommendationsResponse, FastApiError> {
    let raw = crate::config::env_or_dotenv(ERROR_MODEL_RECOMMENDATIONS_ENV);
    error_recommendations(&state.mysql, &current_user.0, raw.as_deref()).await
}

/// Handler body for `GET /api/models/error-recommendations`.
async fn error_recommendations<M>(
    mysql: &M,
    current_user: &UserRow,
    raw_config: Option<&str>,
) -> Result<ErrorRecommendationsResponse, FastApiError>
where
    M: Mysql,
{
    let config = load_config(raw_config);
    // `if not config: return {"data": {}}` runs before the models read.
    if config.is_empty() {
        return Ok(ErrorRecommendationsResponse::empty());
    }
    let public_by_name = public_models_by_name(mysql, Some(current_user.user_name.as_str()))
        .await
        .map_err(|error| {
            tracing::error!(%error, "error-recommendations database dependency failure");
            FastApiError::unhandled()
        })?;
    Ok(ErrorRecommendationsResponse {
        data: build_response(config, &public_by_name),
    })
}

/// `_load_error_recommendations_config`: parse the setting into its ordered
/// `(error_type, entry)` list, keeping only object-valued entries. An empty,
/// invalid, or non-object payload yields no entries.
fn load_config(raw: Option<&str>) -> Vec<(String, RecommendationEntryInput)> {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let Some(document) = OpaqueJson::from_json_text(raw) else {
        tracing::warn!("ERROR_MODEL_RECOMMENDATIONS is not valid JSON");
        return Vec::new();
    };
    document
        .project::<OrderedMap<JsonProjection<RecommendationEntryInput>>>()
        .map(|entries| {
            entries
                .0
                .into_iter()
                .filter_map(|(error_type, entry)| entry.value.map(|entry| (error_type, entry)))
                .collect()
        })
        .unwrap_or_default()
}

/// `_build_error_recommendations_response`: render one entry per error type,
/// each filtering its configured model names against the public models.
fn build_response(
    config: Vec<(String, RecommendationEntryInput)>,
    public_by_name: &BTreeMap<String, RecommendedModel>,
) -> OrderedMap<RecommendationEntry> {
    let entries = config
        .into_iter()
        .map(|(error_type, input)| {
            let description = input
                .description
                .unwrap_or_else(|| OpaqueJson::from_serializable(""));
            let models = input
                .models
                .and_then(|names| names.value)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|name| name.value)
                .filter_map(|name| public_by_name.get(&name).cloned())
                .collect();
            (
                error_type,
                RecommendationEntry {
                    description,
                    models,
                },
            )
        })
        .collect();
    OrderedMap(entries)
}

/// `PublicModelService.get_models`: visible, active public models ordered
/// `created_at DESC`, keyed by name (a later duplicate wins, like the source
/// dict comprehension), then truncated to the source `limit`.
async fn public_models_by_name<M>(
    mysql: &M,
    user_name: Option<&str>,
) -> MysqlResult<BTreeMap<String, RecommendedModel>>
where
    M: Mysql,
{
    let rows: Vec<PublicModelRow> = mysql.fetch_all(PUBLIC_MODELS_SQL, ()).await?;
    let selected = rows
        .into_iter()
        .filter(|row| is_visible_and_allowed(row, user_name))
        .take(PUBLIC_MODEL_LIMIT);
    let mut by_name = BTreeMap::new();
    for row in selected {
        let value = row.json.0.to_value();
        let info = extract_model_info(&value);
        by_name.insert(
            row.name.clone(),
            RecommendedModel::from_info(&row.name, info),
        );
    }
    Ok(by_name)
}

/// The source `get_models` filter: `is_public_model_visible` then
/// `is_public_model_allowed_for_user` against the request user's name.
fn is_visible_and_allowed(row: &PublicModelRow, user_name: Option<&str>) -> bool {
    let value = row.json.0.to_value();
    is_public_model_visible(&value)
        && crate::teams::public_model_access::allowed_for_user_name(&row.json.0, user_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;
    use chrono::NaiveDate;

    fn user() -> UserRow {
        let timestamp = NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        UserRow {
            id: 157,
            user_name: "example-user".to_string(),
            users_password_hash: "hash".to_string(),
            email: Some("example-user@example.invalid".to_string()),
            git_info: Json(OpaqueJson::from_serializable(())),
            is_active: 1,
            role: "user".to_string(),
            auth_source: "dingtalk".to_string(),
            preferences: "{}".to_string(),
            created_at: timestamp,
            updated_at: timestamp,
        }
    }

    fn row(name: &str, json: serde_json::Value) -> PublicModelRow {
        PublicModelRow {
            name: name.to_string(),
            json: Json(OpaqueJson::from_serializable(json)),
        }
    }

    fn model_json(display_name: Option<&str>, provider: &str, model_id: &str) -> serde_json::Value {
        let mut metadata = serde_json::Map::new();
        metadata.insert("name".to_string(), serde_json::Value::from("m"));
        if let Some(display_name) = display_name {
            metadata.insert(
                "displayName".to_string(),
                serde_json::Value::from(display_name),
            );
        }
        serde_json::json!({
            "metadata": metadata,
            "spec": {
                "modelConfig": {"env": {"model": provider, "model_id": model_id}},
                "isAdvanced": false,
            },
        })
    }

    #[test]
    fn config_keeps_object_entries_in_order() {
        let raw = "{\"b\":5,\"a\":{\"models\":[\"x\"]},\"c\":{\"description\":\"d\",\
                    \"models\":[\"y\",\"z\"]}}";
        let config = load_config(Some(raw));
        let keys: Vec<&str> = config.iter().map(|(key, _)| key.as_str()).collect();
        // The non-dict `b` entry is dropped; the rest keep source order.
        assert_eq!(keys, ["a", "c"]);
        // An absent `description` defaults to the empty string.
        assert!(config[0].1.description.is_none());
        let names = config[1]
            .1
            .models
            .as_ref()
            .and_then(|names| names.value.as_ref())
            .map(|names| {
                names
                    .iter()
                    .filter_map(|name| name.value.clone())
                    .collect::<Vec<_>>()
            });
        assert_eq!(names, Some(vec!["y".to_string(), "z".to_string()]));
    }

    #[test]
    fn missing_invalid_or_non_object_config_yields_no_entries() {
        for raw in [
            None,
            Some(""),
            Some("   "),
            Some("{"),
            Some("[]"),
            Some("null"),
            Some("5"),
            Some("{}"),
        ] {
            assert!(load_config(raw).is_empty(), "{raw:?} must load no entries");
        }
    }

    #[test]
    fn a_present_but_non_list_models_field_is_empty() {
        let config = load_config(Some("{\"e\":{\"description\":\"d\",\"models\":\"x\"}}"));
        assert_eq!(config.len(), 1);
        let entry = &config[0].1;
        assert!(
            entry
                .models
                .as_ref()
                .and_then(|names| names.value.as_ref())
                .is_none()
        );
        assert!(entry.description.is_some());
    }

    #[test]
    fn non_string_model_names_are_skipped() {
        let public = BTreeMap::new();
        let config = load_config(Some("{\"e\":{\"models\":[\"x\",5,true,null,\"x\"]}}"));
        // `x` is absent from the public models, so it renders nothing; the
        // non-string elements have already been dropped by the projection.
        let data = build_response(config, &public);
        let (_, entry) = &data.0[0];
        assert!(entry.models.is_empty());
        assert_eq!(entry.description.to_value(), serde_json::json!(""));
    }

    #[test]
    fn recommendation_renders_the_source_field_set() {
        let model = RecommendedModel::from_info(
            "m",
            extract_model_info(&model_json(Some("Display"), "claude", "model-id")),
        );
        let rendered = crate::json_contract_tests::serialized(model).unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "name",
                "type",
                "displayName",
                "provider",
                "modelId",
                "modelCategoryType",
                "isAdvanced"
            ]
        );
        assert_eq!(rendered["type"], "public");
        assert_eq!(rendered["provider"], "claude");
        assert_eq!(rendered["modelId"], "model-id");
        // `model_category_type` defaults to `llm` when the CRD omits `modelType`.
        assert_eq!(rendered["modelCategoryType"], "llm");
        assert_eq!(rendered["isAdvanced"], false);
    }

    #[test]
    fn absent_optional_fields_render_as_null() {
        let metadata_json = serde_json::json!({
            "metadata": {"name": "m"},
            "spec": {"modelConfig": {"env": {}}},
        });
        let model = RecommendedModel::from_info("m", extract_model_info(&metadata_json));
        let rendered = crate::json_contract_tests::serialized(model).unwrap();
        assert!(rendered["displayName"].is_null());
        assert!(rendered["provider"].is_null());
        assert!(rendered["modelId"].is_null());
        assert_eq!(rendered["modelCategoryType"], "llm");
        assert_eq!(rendered["isAdvanced"], false);
    }

    #[test]
    fn build_response_filters_and_orders_models_by_configured_names() {
        let mut public = BTreeMap::new();
        for name in ["a", "b", "c"] {
            public.insert(
                name.to_string(),
                RecommendedModel::from_info(
                    name,
                    extract_model_info(&model_json(None, "claude", "id")),
                ),
            );
        }
        let config = load_config(Some(
            "{\"e\":{\"description\":\"d\",\"models\":[\"c\",\"missing\",\"a\"]}}",
        ));
        let data = build_response(config, &public);
        let (error_type, entry) = &data.0[0];
        assert_eq!(error_type, "e");
        assert_eq!(entry.description.to_value(), serde_json::json!("d"));
        // The unmatched name is dropped; the matched names keep config order.
        let names: Vec<&str> = entry.models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["c", "a"]);
    }

    #[test]
    fn empty_response_serializes_as_an_empty_data_object() {
        let rendered =
            crate::json_contract_tests::serialized(ErrorRecommendationsResponse::empty()).unwrap();
        assert_eq!(rendered, serde_json::json!({"data": {}}));
    }

    /// The recorded statement inlines the bound values; the target binds them
    /// as parameters. The SQL must stay token-identical after whitespace
    /// normalization.
    #[test]
    fn public_models_statement_matches_recorded_exchange() {
        let recorded = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
             kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
             kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at \n\
             FROM kinds \n\
             WHERE kinds.user_id = 0 AND kinds.kind = 'Model' AND kinds.namespace = 'default' \
             AND kinds.is_active = true ORDER BY kinds.created_at DESC";
        let tokens = |sql: &str| sql.split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(tokens(PUBLIC_MODELS_SQL), tokens(recorded));
    }

    #[tokio::test]
    async fn empty_config_returns_empty_data_without_a_read() {
        let mysql = KindQueryCapture::default();
        for raw in [None, Some(""), Some("not json")] {
            let response = error_recommendations(&mysql, &user(), raw).await.unwrap();
            assert!(response.data.0.is_empty());
        }
        assert!(
            mysql.queries().is_empty(),
            "an empty configuration must not read the models table"
        );
    }

    #[tokio::test]
    async fn a_configured_entry_reads_the_public_models() {
        let mysql = KindQueryCapture::default();
        let response = error_recommendations(
            &mysql,
            &user(),
            Some("{\"e\":{\"description\":\"d\",\"models\":[\"m\"]}}"),
        )
        .await
        .unwrap();
        assert_eq!(response.data.0.len(), 1);
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM kinds"));
        assert!(queries[0].sql.contains("kinds.user_id = 0"));
        assert!(queries[0].sql.contains("ORDER BY kinds.created_at DESC"));
        assert_eq!(queries[0].args, 0);
    }

    #[test]
    fn visibility_and_whitelist_filter_public_models() {
        let hidden = row(
            "hidden",
            serde_json::json!({"metadata": {"name": "hidden"}, "spec": {"isVisible": false}}),
        );
        assert!(!is_visible_and_allowed(&hidden, Some("example-user")));

        let gated = row(
            "gated",
            serde_json::json!({
                "metadata": {"name": "gated"},
                "spec": {"allowedUsersEnabled": true, "allowedUsers": ["other"]},
            }),
        );
        assert!(!is_visible_and_allowed(&gated, Some("example-user")));
        assert!(is_visible_and_allowed(&gated, None).eq(&false));

        let open = row(
            "open",
            serde_json::json!({"metadata": {"name": "open"}, "spec": {}}),
        );
        assert!(is_visible_and_allowed(&open, Some("example-user")));
    }
}
