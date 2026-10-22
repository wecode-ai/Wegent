// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge/{knowledge_base_id}/wiki-bindings`
//! (`app.api.endpoints.external_wiki.list_kb_bindings`): the Wiki pages
//! synchronized into a knowledge base, for the management UI.
//!
//! Source pipeline for the caller's `default`-namespace knowledge base:
//!
//! 1. `security.get_current_user` — the user row by `user_name`;
//! 2. `_load_kb` — the KB `Kind` record (SQLAlchemy's `is_(True)` renders
//!    `kinds.is_active IS true`);
//! 3. `_require_kb_read` — `can_directly_access_knowledge_base`: the raw ACL
//!    chain of `resolve_knowledge_base_permission` (the user row by id, the
//!    direct membership, the entity sources) plus
//!    `meets_direct_access_requirement`;
//! 4. `list_kb_wiki_source_documents` — the `knowledge_documents` rows of the
//!    KB with `source_type = 'external'`, the `selectin` external-identity
//!    load for the returned rows (skipped when the page is empty), then the
//!    in-memory filter to Wiki-provider documents with an enabled sync
//!    config;
//! 5. two trailing `ROLLBACK` session cleanups at request end (SQLAlchemy
//!    driver session lifecycle, not re-emitted).
//!
//! `_load_kb` maps a missing record to `404 {"detail": "知识库不存在"}` and
//! `_require_kb_read` a denied caller to `403 {"detail": "无权访问该知识库"}`.
//! The recorded case returns an empty list, so the response body is `[]`.
use std::collections::HashMap;
use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql};
use serde::Serialize;
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::knowledge_documents_content::access;
use crate::knowledge_documents_content::reader::{DOCUMENT_COLUMNS, EXTERNAL_SOURCE_COLUMNS};
use crate::state::AppState;
use brz_json::OpaqueJson;

/// `WIKI_PROVIDER_ID` (`app.services.knowledge.external_document_identity`).
const WIKI_PROVIDER_ID: &str = "wiki";

/// GET /api/knowledge/:knowledge_base_id/wiki-bindings: the external-wiki
/// free function (`app.api.endpoints.external_wiki.list_kb_bindings`),
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/knowledge/:knowledge_base_id/wiki-bindings")]
async fn list_kb_bindings_route(
    #[inject(state)] state: &Arc<AppState>,
    knowledge_base_id: &str,
    #[auth] current_user: crate::auth::SessionUser,
) -> Result<OpaqueJson, FastApiError> {
    // FastAPI validates the path parameter before the endpoint body runs.
    let knowledge_base_id = parse_knowledge_base_id_path(knowledge_base_id)?;
    list_kb_bindings(state, knowledge_base_id, i64::from(current_user.id)).await
}

/// `app.api.endpoints.external_wiki.list_kb_bindings` after authentication.
async fn list_kb_bindings(
    state: &AppState,
    knowledge_base_id: i64,
    user_id: i64,
) -> Result<OpaqueJson, FastApiError> {
    let mysql = &state.mysql;
    let redis = state.redis.as_ref();

    // `_load_kb`: the Kind lookup with SQLAlchemy's `is_(True)` rendering.
    let kb = access::permission_kb_record(mysql, knowledge_base_id)
        .await
        .map_err(|_| FastApiError::unhandled())?;
    let Some(kb) = kb else {
        return Err(FastApiError::detail(StatusCode::NOT_FOUND, "知识库不存在"));
    };

    // `_require_kb_read` -> `can_directly_access_knowledge_base` with the
    // already-loaded record: the raw ACL chain, then the direct-access
    // requirement.
    let has_access =
        access::knowledge_base_access(mysql, redis, &state.entity_resolvers, &kb, user_id)
            .await
            .map_err(|_| FastApiError::unhandled())?;
    if !has_access {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "无权访问该知识库",
        ));
    }

    let documents = wiki_source_documents(mysql, knowledge_base_id).await?;
    Ok(OpaqueJson::from_serializable(
        documents
            .into_iter()
            .map(WikiBoundDocument::from_row)
            .collect::<Vec<_>>(),
    ))
}

/// `list_kb_wiki_source_documents`: the KB's `external` documents, the
/// `selectin` external-identity load, and the in-memory Wiki filter.
async fn wiki_source_documents<M>(
    mysql: &M,
    knowledge_base_id: i64,
) -> Result<Vec<WikiDocumentRow>, FastApiError>
where
    M: Mysql,
{
    let documents: Vec<WikiDocumentRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {DOCUMENT_COLUMNS} \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.kind_id = {knowledge_base_id} \
                 AND knowledge_documents.source_type = 'external'"
            ),
            (),
        )
        .await
        .map_err(|_| FastApiError::unhandled())?;
    if documents.is_empty() {
        return Ok(documents);
    }

    // The `selectin` load of the `external_source` relationship.
    let ids = documents
        .iter()
        .map(|row| row.knowledge_documents_id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let external_rows: Vec<ExternalSourceRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {EXTERNAL_SOURCE_COLUMNS} \n\
                 FROM knowledge_document_external_sources \n\
                 WHERE knowledge_document_external_sources.document_id IN ({ids})"
            ),
            (),
        )
        .await
        .map_err(|_| FastApiError::unhandled())?;
    let provider_by_document: HashMap<i64, String> = external_rows
        .into_iter()
        .map(|row| {
            (
                row.knowledge_document_external_sources_document_id,
                row.knowledge_document_external_sources_external_provider,
            )
        })
        .collect();

    // The in-memory filter: the Wiki provider identity plus an enabled,
    // dict-shaped sync config (`document.external_provider` is `None`
    // without an identity row).
    Ok(documents
        .into_iter()
        .filter(|row| {
            provider_by_document
                .get(&row.knowledge_documents_id)
                .is_some_and(|provider| provider == WIKI_PROVIDER_ID)
        })
        .filter(|row| {
            row_sync_config(row).is_some_and(|sync| sync.get("enabled").is_some_and(python_truthy))
        })
        .collect())
}

/// One `knowledge_documents` row of the listing (the same labeled projection
/// as the content reader's; only the fields the response reads are modeled).
#[derive(Debug, FromMysqlRow)]
struct WikiDocumentRow {
    knowledge_documents_id: i64,
    knowledge_documents_name: String,
    knowledge_documents_index_status: String,
    knowledge_documents_source_config: Option<Json<Value>>,
}

/// The stored `source_config` value of a row.
fn source_config_value(row: &WikiDocumentRow) -> Option<&Value> {
    row.knowledge_documents_source_config
        .as_ref()
        .map(|config| &config.0)
}

/// A row's `get_document_sync_config` projection.
fn row_sync_config(row: &WikiDocumentRow) -> Option<&serde_json::Map<String, Value>> {
    source_config_value(row).and_then(source_sync_config)
}

/// One row of the `selectin` external-identity load.
#[derive(Debug, FromMysqlRow)]
struct ExternalSourceRow {
    knowledge_document_external_sources_document_id: i64,
    knowledge_document_external_sources_external_provider: String,
}

/// `get_document_sync_config`: `source_config["external"]["sync"]` when it is
/// a dict; every other shape reads as absent.
fn source_sync_config(source_config: &Value) -> Option<&serde_json::Map<String, Value>> {
    source_config
        .as_object()
        .and_then(|config| config.get("external"))
        .and_then(Value::as_object)
        .and_then(|external| external.get("sync"))
        .and_then(Value::as_object)
}

/// `document.external_source_config`: `source_config["external"]` when it is
/// a dict; every other shape reads as empty.
fn source_external_config(source_config: &Value) -> Option<&serde_json::Map<String, Value>> {
    source_config
        .as_object()
        .and_then(|config| config.get("external"))
        .and_then(Value::as_object)
}

/// `WikiBoundDocument` (`app.schemas.external_wiki`). Field order matches the
/// pydantic model, so the serialized item matches the recorded bodies.
#[derive(Debug, Serialize)]
struct WikiBoundDocument {
    id: i64,
    page_id: String,
    name: String,
    path: String,
    locale: String,
    page_updated_at: String,
    resource_url: String,
    status: String,
    connection_id: Option<String>,
    adapter_type: String,
    resource_kind: String,
    project_path: Option<String>,
    branch: Option<String>,
    file_extension: String,
}

impl WikiBoundDocument {
    /// `_bound_document`: project one filtered row through the response
    /// model.
    fn from_row(row: WikiDocumentRow) -> Self {
        let WikiDocumentRow {
            knowledge_documents_id,
            knowledge_documents_name,
            knowledge_documents_index_status,
            knowledge_documents_source_config,
        } = row;
        let source_config = knowledge_documents_source_config
            .as_ref()
            .map(|config| &config.0);
        let sync = source_config.and_then(source_sync_config);
        let external = source_config.and_then(source_external_config);
        let sync_value = |key: &str| sync.and_then(|sync| sync.get(key));
        Self {
            id: knowledge_documents_id,
            page_id: str_or_empty(sync_value("resource_id")),
            name: knowledge_documents_name,
            path: str_or_empty(sync_value("path")),
            locale: str_or_empty(sync_value("locale")),
            page_updated_at: str_or_empty(sync_value("observed_version")),
            resource_url: str_or_empty(external.and_then(|external| external.get("url"))),
            // `str(index_status)`: the type decorator exposes the stored enum
            // value, so the raw column text is already `str(...)`.
            status: knowledge_documents_index_status,
            connection_id: str_or_none(sync_value("connection_id")),
            adapter_type: str_or_default(sync_value("adapter_type"), "wikijs"),
            resource_kind: str_or_default(sync_value("resource_kind"), "page"),
            project_path: str_or_none(sync_value("project_path")),
            branch: str_or_none(sync_value("branch")),
            file_extension: str_or_empty(sync_value("file_extension")),
        }
    }
}

/// `str(value or "")`: a Python-falsy value (or an absent key) reads as the
/// empty string, any other value renders through `str()`.
fn str_or_empty(value: Option<&Value>) -> String {
    match value.filter(|value| python_truthy(value)) {
        Some(value) => python_str(value),
        None => String::new(),
    }
}

/// `str(value or "") or None`: an empty rendering stays `None` like the
/// model's `Optional[str]` normalization.
fn str_or_none(value: Option<&Value>) -> Option<String> {
    let text = str_or_empty(value);
    (!text.is_empty()).then_some(text)
}

/// `str(value or default)`: a Python-falsy value (or an absent key) falls
/// back to the model default.
fn str_or_default(value: Option<&Value>, default: &str) -> String {
    match value.filter(|value| python_truthy(value)) {
        Some(value) => python_str(value),
        None => default.to_string(),
    }
}

/// Python truthiness of a decoded JSON value.
fn python_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_none_or(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(object) => !object.is_empty(),
    }
}

/// `str(value)` for the JSON scalars the sync config stores (the same
/// coercions as the attachment context store's resolver).
fn python_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => if *flag { "True" } else { "False" }.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Null => "None".to_string(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// FastAPI-style 422 validation error body for the `knowledge_base_id` path
/// parameter.
fn parse_knowledge_base_id_path(value: &str) -> Result<i64, FastApiError> {
    value.parse().map_err(|_| {
        FastApiError::validation(serde_json::json!([
            {
                "type": "int_parsing",
                "loc": ["path", "knowledge_base_id"],
                "msg": "Input should be a valid integer, unable to parse string as an integer",
                "input": value,
            }
        ]))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wiki_document(source_config: Value) -> WikiDocumentRow {
        WikiDocumentRow {
            knowledge_documents_id: 43199,
            knowledge_documents_name: "营销号判定标准".to_string(),
            knowledge_documents_index_status: "success".to_string(),
            knowledge_documents_source_config: Some(Json(source_config)),
        }
    }

    fn stored_sync_config() -> Value {
        json!({
            "kind_id": 1884840,
            "external": {
                "provider": "wiki",
                "url": "https://wiki.example/a/page",
                "sync": {
                    "enabled": true,
                    "connection_id": "conn-1",
                    "resource_id": "42",
                    "adapter_type": "wikijs",
                    "resource_kind": "page",
                    "path": "/a/page",
                    "locale": "zh-CN",
                    "observed_version": "20261016",
                    "file_extension": "md"
                }
            }
        })
    }

    #[test]
    fn sync_config_requires_an_external_sync_dict() {
        let sync_of =
            row_sync_config as fn(&WikiDocumentRow) -> Option<&serde_json::Map<String, Value>>;
        fn external_of(row: &WikiDocumentRow) -> Option<&serde_json::Map<String, Value>> {
            source_config_value(row).and_then(source_external_config)
        }

        let row = wiki_document(stored_sync_config());
        assert!(sync_of(&row).is_some());
        assert!(external_of(&row).is_some());

        let not_a_dict = wiki_document(json!({"external": {"sync": "off"}}));
        assert!(sync_of(&not_a_dict).is_none());

        let no_external = wiki_document(json!({}));
        assert!(sync_of(&no_external).is_none());
        assert!(external_of(&no_external).is_none());

        let null_config = wiki_document(Value::Null);
        assert!(sync_of(&null_config).is_none());
        assert!(external_of(&null_config).is_none());
    }

    #[test]
    fn bound_document_field_order_matches_the_model() {
        let body = serde_json::to_string(&WikiBoundDocument::from_row(wiki_document(
            stored_sync_config(),
        )))
        .unwrap();
        assert_eq!(
            body,
            r#"{"id":43199,"page_id":"42","name":"营销号判定标准","path":"/a/page","locale":"zh-CN","page_updated_at":"20261016","resource_url":"https://wiki.example/a/page","status":"success","connection_id":"conn-1","adapter_type":"wikijs","resource_kind":"page","project_path":null,"branch":null,"file_extension":"md"}"#
        );
    }

    #[test]
    fn bound_document_defaults_and_none_normalization_match_the_source() {
        // The sync config carries only `enabled`; every other member falls
        // back to the model default, and empty strings normalize to null for
        // the optional members.
        let row = wiki_document(json!({"external": {
            "sync": {"enabled": true, "connection_id": "", "branch": ""}
        }}));
        let document = WikiBoundDocument::from_row(row);
        assert_eq!(document.page_id, "");
        assert_eq!(document.adapter_type, "wikijs");
        assert_eq!(document.resource_kind, "page");
        assert_eq!(document.connection_id, None);
        assert_eq!(document.project_path, None);
        assert_eq!(document.branch, None);
        assert_eq!(document.resource_url, "");
    }

    #[test]
    fn enabled_gate_follows_python_truthiness() {
        let sync_of =
            row_sync_config as fn(&WikiDocumentRow) -> Option<&serde_json::Map<String, Value>>;
        for enabled in [json!(false), json!(0), json!(""), json!(null), json!([])] {
            let row = wiki_document(json!({"external": {"sync": {"enabled": enabled}}}));
            assert!(
                !sync_of(&row).is_some_and(|sync: &serde_json::Map<String, Value>| {
                    sync.get("enabled").is_some_and(python_truthy)
                }),
                "enabled {enabled} must stay excluded"
            );
        }
        for enabled in [json!(true), json!(1), json!("on"), json!({"v": 1})] {
            let row = wiki_document(json!({"external": {"sync": {"enabled": enabled}}}));
            let sync = sync_of(&row).expect("sync config decodes");
            assert!(sync.get("enabled").is_some_and(python_truthy));
        }
    }

    #[test]
    fn str_coercions_follow_python_semantics() {
        assert_eq!(str_or_empty(Some(&json!("x"))), "x");
        assert_eq!(str_or_empty(Some(&json!(0))), "");
        assert_eq!(str_or_empty(Some(&json!(null))), "");
        assert_eq!(str_or_empty(None), "");
        assert_eq!(str_or_empty(Some(&json!(7))), "7");
        assert_eq!(str_or_empty(Some(&json!(true))), "True");
        assert_eq!(str_or_default(None, "page"), "page");
        assert_eq!(str_or_default(Some(&json!("")), "page"), "page");
        assert_eq!(str_or_none(Some(&json!("conn"))), Some("conn".to_string()));
        assert_eq!(str_or_none(Some(&json!(""))), None);
        assert_eq!(str_or_none(None), None);
    }

    #[test]
    fn path_parameter_validates_like_fastapi() {
        assert_eq!(parse_knowledge_base_id_path("1884840").unwrap(), 1884840);
        let error = parse_knowledge_base_id_path("abc").unwrap_err();
        assert_eq!(
            error.validation_detail(),
            r#"[{"type":"int_parsing","loc":["path","knowledge_base_id"],"msg":"Input should be a valid integer, unable to parse string as an integer","input":"abc"}]"#
        );
    }

    #[test]
    fn empty_binding_list_renders_the_recorded_body() {
        let empty: Vec<WikiBoundDocument> = Vec::new();
        let body = OpaqueJson::from_serializable(empty)
            .as_raw()
            .get()
            .to_owned();
        assert_eq!(body, "[]");
    }

    #[test]
    fn registered_route_keeps_python_ownership() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
        assert!(!table.matches(&http::Method::GET, "/api/knowledge/1884840/wiki-bindings"));
        // Inspect emitted registrations from the collection used by
        // Application; GET is bit 1<<1 of the method mask.
        let methods: Vec<_> =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .filter(|route| route.path == "/api/knowledge/:knowledge_base_id/wiki-bindings")
                .map(|route| route.methods)
                .collect();
        assert_eq!(methods, vec![1 << 1]);
    }
}
