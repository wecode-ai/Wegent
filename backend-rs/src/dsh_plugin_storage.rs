// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/dsh-plugin-storage/units/{unit}/load` — the authenticated
//! generic DSH-plugin KV-storage snapshot reader.
//!
//! Source: `app/api/endpoints/dsh_plugin_storage.py::load_unit` ->
//! `app/services/dsh_plugin_storage.py::DshPluginStorageService.load_unit`.
//! The endpoint validates the package/unit identity and the descriptor, loads
//! the caller's active `DshPluginData` `kinds` row for
//! `(namespace=package, name=unit)`, rejects a stored document whose declared
//! version/tables/global do not match the descriptor with `409`, and otherwise
//! returns the public snapshot (`version`, `tables`, `global`).
use std::collections::HashSet;

use brz_mysql::{FromMysqlRow, Mysql};
use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `app/services/dsh_plugin_storage.py::DSH_PLUGIN_DATA_KIND`.
const DSH_PLUGIN_DATA_KIND: &str = "DshPluginData";

/// SQLAlchemy renders `db.query(Kind)` with every mapped column labeled
/// `kinds_<column>`; the source `_resource` lookup selects all of them, so the
/// target statement keeps the same projection for replay compatibility.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// One active `kinds` row; only the stored document is consumed.
#[derive(Debug, FromMysqlRow)]
struct KindRow {
    #[mysql(rename = "kinds_json")]
    json: Value,
}

/// `DshStorageDescriptor` (`app/schemas/dsh_plugin_storage.py`): the storage
/// descriptor carried in the request body. `tables` defaults to empty and
/// `has_global` defaults to false, matching the pydantic model.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Descriptor {
    version: i64,
    tables: Vec<String>,
    has_global: bool,
}

/// `DshPluginStorageService.load_unit`: validate, then read the snapshot.
#[brz_http_server::post("/api/v1/dsh-plugin-storage/units/:unit/load")]
async fn load_unit(
    #[inject(state)] state: &AppState,
    #[auth] user: crate::auth::SessionUser,
    unit: String,
    package: Option<String>,
    body: Value,
) -> Result<Value, FastApiError> {
    // FastAPI binds the required `package` query parameter before the endpoint
    // body runs; a missing value is a 422 without dependency traffic.
    let package = package.ok_or_else(|| query_missing("package"))?;
    let descriptor = parse_descriptor(&body)?;
    validate_identity(&package, &unit)?;
    validate_descriptor(&descriptor)?;
    load_snapshot(
        &state.mysql,
        i64::from(user.id),
        &package,
        &unit,
        &descriptor,
    )
    .await
}

/// The post-validation load: fetch the stored document and project the public
/// snapshot, or an empty snapshot when the caller has no stored unit yet.
async fn load_snapshot<M: Mysql>(
    mysql: &M,
    user_id: i64,
    package: &str,
    unit: &str,
    descriptor: &Descriptor,
) -> Result<Value, FastApiError> {
    let row: Option<KindRow> = mysql
        .fetch_optional(resource_sql(user_id, package, unit), ())
        .await
        .map_err(internal_error)?;
    let Some(row) = row else {
        return public_snapshot(&new_document(descriptor));
    };
    // `_document`: a stored non-object document is a 409, not a 500.
    if !row.json.is_object() {
        return Err(malformed_document());
    }
    require_compatible(&row.json, descriptor)?;
    public_snapshot(&row.json)
}

/// `_resource`: the newest active `DshPluginData` row for the identity.
///
/// The source renders the SQLAlchemy filter with literal values. The package
/// and unit names are already validated against the source's ASCII-only
/// `PACKAGE_NAME_RE`/`UNIT_NAME_RE`, so inlining them cannot break out of the
/// quoted literal, and the bound `user_id` is numeric.
fn resource_sql(user_id: i64, package: &str, unit: &str) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = {user_id} \
         AND kinds.kind = '{DSH_PLUGIN_DATA_KIND}' AND kinds.namespace = '{package}' \
         AND kinds.name = '{unit}' AND kinds.is_active = true \
         ORDER BY kinds.id DESC \n LIMIT 1"
    )
}

/// `_new_document`: the empty document for a descriptor with no stored row.
fn new_document(descriptor: &Descriptor) -> Value {
    let mut tables = Map::new();
    for table in &descriptor.tables {
        tables.insert(table.clone(), Value::Object(Map::new()));
    }
    json!({
        "version": descriptor.version,
        "table_names": descriptor.tables,
        "has_global": descriptor.has_global,
        "tables": tables,
        "global": Value::Null,
    })
}

/// `_public_snapshot`: `version`, the per-table `{key: value}` maps (non-object
/// entries are dropped), and the stored `global` value.
fn public_snapshot(document: &Value) -> Result<Value, FastApiError> {
    // `document["version"]`: the source indexes the key directly, so a stored
    // document without a version propagates to the app's 500 handler.
    let Some(version) = document.get("version").cloned() else {
        return Err(FastApiError::unhandled());
    };
    let mut tables = Map::new();
    if let Some(entries) = document.get("tables").and_then(Value::as_object) {
        for (table, entries) in entries {
            let Some(entries) = entries.as_object() else {
                continue;
            };
            let mut values = Map::new();
            for (key, entry) in entries {
                let Some(entry) = entry.as_object() else {
                    continue;
                };
                values.insert(
                    key.clone(),
                    entry.get("value").cloned().unwrap_or(Value::Null),
                );
            }
            tables.insert(table.clone(), Value::Object(values));
        }
    }
    Ok(json!({
        "version": version,
        "tables": tables,
        "global": document.get("global").cloned().unwrap_or(Value::Null),
    }))
}

/// `_require_compatible`: reject a stored document whose version, table list,
/// or global declaration differs from the request descriptor.
fn require_compatible(document: &Value, descriptor: &Descriptor) -> Result<(), FastApiError> {
    if document.get("version") != Some(&json!(descriptor.version)) {
        return Err(conflict("Storage unit version does not match"));
    }
    let expected_tables: Value = descriptor
        .tables
        .iter()
        .map(|table| Value::String(table.clone()))
        .collect();
    if document.get("table_names") != Some(&expected_tables) {
        return Err(conflict("Storage unit tables do not match"));
    }
    if document.get("has_global") != Some(&json!(descriptor.has_global)) {
        return Err(conflict("Storage unit global declaration does not match"));
    }
    Ok(())
}

/// `validate_identity`: the source package regex then the unit-name check.
fn validate_identity(package: &str, unit: &str) -> Result<(), FastApiError> {
    if package.len() > 100 || !matches_package_name(package) {
        return Err(bad_request("Invalid DSH package name"));
    }
    validate_name(unit, "unit")
}

/// `validate_descriptor`: duplicate tables first, then every table name.
fn validate_descriptor(descriptor: &Descriptor) -> Result<(), FastApiError> {
    let unique: HashSet<&String> = descriptor.tables.iter().collect();
    if unique.len() != descriptor.tables.len() {
        return Err(bad_request("Storage descriptor contains duplicate tables"));
    }
    for table in &descriptor.tables {
        validate_name(table, "table")?;
    }
    Ok(())
}

/// `_validate_name`: `len <= 100` and the source `UNIT_NAME_RE` charset.
fn validate_name(value: &str, label: &str) -> Result<(), FastApiError> {
    if value.len() > 100 || !matches_unit_name(value) {
        return Err(bad_request(&format!("Invalid storage {label} name")));
    }
    Ok(())
}

/// `UNIT_NAME_RE = ^[a-z][a-z0-9_]*$`.
fn matches_unit_name(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// `PACKAGE_NAME_RE = ^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`.
fn matches_package_name(value: &str) -> bool {
    match value.strip_prefix('@') {
        Some(scoped) => scoped.split_once('/').is_some_and(|(scope, name)| {
            matches_package_segment(scope) && matches_package_segment(name)
        }),
        None => matches_package_segment(value),
    }
}

/// One `[a-z0-9][a-z0-9._-]*` package segment.
fn matches_package_segment(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-')
}

/// `DshStorageDescriptor` body validation with FastAPI's 422 error shapes.
///
/// Pydantic ignores unknown keys, requires an integer `version >= 0`, defaults
/// `tables` to an empty list (`max_length=64`, string items), and defaults
/// `has_global` to false.
fn parse_descriptor(body: &Value) -> Result<Descriptor, FastApiError> {
    let Some(object) = body.as_object() else {
        return Err(FastApiError::validation(json!([
            {
                "type": "model_attributes_type",
                "loc": ["body"],
                "msg": "Input should be a valid dictionary or object to extract fields from",
                "input": body,
            }
        ])));
    };
    let version = match object.get("version") {
        None => {
            return Err(body_error(
                "missing",
                "body.version",
                "Field required",
                body,
            ));
        }
        Some(value) => match value.as_i64() {
            Some(number) if number >= 0 => number,
            Some(_) => {
                return Err(body_error(
                    "greater_than_equal",
                    "body.version",
                    "Input should be greater than or equal to 0",
                    value,
                ));
            }
            None => {
                return Err(body_error(
                    "int_parsing",
                    "body.version",
                    "Input should be a valid integer, unable to parse string as an integer",
                    value,
                ));
            }
        },
    };
    let tables = match object.get("tables") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > 64 {
                return Err(body_error(
                    "too_long",
                    "body.tables",
                    "List should have at most 64 items after validation, not more",
                    object.get("tables").expect("table list present"),
                ));
            }
            let mut names = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                match item.as_str() {
                    Some(name) => names.push(name.to_string()),
                    None => {
                        return Err(FastApiError::validation(json!([
                            {
                                "type": "string_type",
                                "loc": ["body", "tables", index],
                                "msg": "Input should be a valid string",
                                "input": item,
                            }
                        ])));
                    }
                }
            }
            names
        }
        Some(other) => {
            return Err(body_error(
                "list_type",
                "body.tables",
                "Input should be a valid list",
                other,
            ));
        }
    };
    let has_global = match object.get("has_global") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(other) => {
            return Err(body_error(
                "bool_parsing",
                "body.has_global",
                "Input should be a valid boolean, unable to interpret input",
                other,
            ));
        }
    };
    Ok(Descriptor {
        version,
        tables,
        has_global,
    })
}

/// One FastAPI body-validation error entry. `field` is the dotted tail of the
/// `loc` array (`version`, `tables`, `has_global`).
fn body_error(kind: &str, field: &str, message: &str, input: &Value) -> FastApiError {
    let loc: Vec<&str> = std::iter::once("body").chain(field.split('.')).collect();
    FastApiError::validation(json!([
        {
            "type": kind,
            "loc": loc,
            "msg": message,
            "input": input,
        }
    ]))
}

/// A missing required query parameter (`package`).
fn query_missing(field: &str) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": "missing",
            "loc": ["query", field],
            "msg": "Field required",
            "input": brz_json::JsonNull,
        }
    ]))
}

fn bad_request(message: &str) -> FastApiError {
    FastApiError::detail(brz_http_server::StatusCode::BAD_REQUEST, message)
}

fn conflict(message: &str) -> FastApiError {
    FastApiError::detail(brz_http_server::StatusCode::CONFLICT, message)
}

fn malformed_document() -> FastApiError {
    conflict("Stored DSH plugin data is malformed")
}

fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "dsh plugin storage dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    fn descriptor() -> Descriptor {
        Descriptor {
            version: 1,
            tables: Vec::new(),
            has_global: true,
        }
    }

    #[test]
    fn resource_sql_matches_the_recorded_source_statement() {
        let sql = resource_sql(373, "@wegent/dsh-transcript-sync", "portable_preferences");
        // The replay matcher collapses whitespace, but the projection, predicate
        // order, and ordering must match the recorded SQLAlchemy exchange.
        let normalized = sql.split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(
            normalized,
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at FROM kinds WHERE kinds.user_id = 373 \
             AND kinds.kind = 'DshPluginData' AND kinds.namespace = '@wegent/dsh-transcript-sync' \
             AND kinds.name = 'portable_preferences' AND kinds.is_active = true \
             ORDER BY kinds.id DESC LIMIT 1"
        );
    }

    #[tokio::test]
    async fn missing_stored_unit_returns_the_empty_snapshot() {
        let mysql = KindQueryCapture::default();
        let body = load_snapshot(
            &mysql,
            373,
            "@wegent/dsh-transcript-sync",
            "portable_preferences",
            &descriptor(),
        )
        .await
        .expect("empty snapshot");
        assert_eq!(body, json!({"version": 1, "tables": {}, "global": null}));
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM kinds"));
        assert_eq!(queries[0].args, 0);
    }

    #[test]
    fn empty_descriptor_lists_every_declared_table() {
        let descriptor = Descriptor {
            version: 3,
            tables: vec!["alpha".to_string(), "beta".to_string()],
            has_global: false,
        };
        let snapshot = public_snapshot(&new_document(&descriptor)).expect("snapshot");
        assert_eq!(
            snapshot,
            json!({
                "version": 3,
                "tables": {"alpha": {}, "beta": {}},
                "global": null,
            })
        );
    }

    #[test]
    fn public_snapshot_projects_only_object_entries() {
        let document = json!({
            "version": 1,
            "table_names": ["t"],
            "has_global": true,
            "tables": {"t": {"k": {"value": 7, "shared": true}, "bad": 4}},
            "global": {"language": "zh-CN"},
        });
        let snapshot = public_snapshot(&document).expect("snapshot");
        assert_eq!(
            snapshot,
            json!({
                "version": 1,
                "tables": {"t": {"k": 7}},
                "global": {"language": "zh-CN"},
            })
        );
    }

    #[test]
    fn missing_entry_value_becomes_null() {
        let document = json!({
            "version": 1,
            "tables": {"t": {"k": {"shared": true}}},
        });
        let snapshot = public_snapshot(&document).expect("snapshot");
        assert_eq!(snapshot["tables"], json!({"t": {"k": null}}));
        assert_eq!(snapshot["global"], Value::Null);
    }

    #[test]
    fn require_compatible_rejects_each_mismatch() {
        let document = json!({
            "version": 1,
            "table_names": [],
            "has_global": true,
        });
        assert!(require_compatible(&document, &descriptor()).is_ok());
        let other_version = json!({"version": 2, "table_names": [], "has_global": true});
        assert_eq!(
            require_compatible(&other_version, &descriptor())
                .err()
                .and_then(|error| error.detail_message().map(str::to_string))
                .as_deref(),
            Some("Storage unit version does not match")
        );
        let other_tables = json!({"version": 1, "table_names": ["x"], "has_global": true});
        assert_eq!(
            require_compatible(&other_tables, &descriptor())
                .err()
                .and_then(|error| error.detail_message().map(str::to_string))
                .as_deref(),
            Some("Storage unit tables do not match")
        );
        let other_global = json!({"version": 1, "table_names": [], "has_global": false});
        assert_eq!(
            require_compatible(&other_global, &descriptor())
                .err()
                .and_then(|error| error.detail_message().map(str::to_string))
                .as_deref(),
            Some("Storage unit global declaration does not match")
        );
    }

    #[test]
    fn package_and_unit_name_rules_match_the_source_regexes() {
        assert!(matches_unit_name("portable_preferences"));
        assert!(matches_unit_name("a1"));
        for bad in ["1abc", "Abc", "a-b", "", "a b"] {
            assert!(!matches_unit_name(bad), "{bad:?} must be rejected");
        }
        assert!(matches_package_name("@wegent/dsh-transcript-sync"));
        assert!(matches_package_name("plain"));
        assert!(matches_package_name("@scope/name"));
        for bad in ["@wegent", "@/name", "@scope/", "@Scope/name", "/name", ""] {
            assert!(!matches_package_name(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn descriptor_validation_matches_pydantic_defaults() {
        let parsed = parse_descriptor(&json!({"version": 1})).expect("valid");
        assert_eq!(
            parsed,
            Descriptor {
                version: 1,
                tables: Vec::new(),
                has_global: false,
            }
        );
        assert!(parse_descriptor(&json!({"version": -1})).is_err());
        assert!(parse_descriptor(&json!({"version": "x"})).is_err());
        assert!(parse_descriptor(&json!({})).is_err());
        assert!(parse_descriptor(&json!({"version": 1, "tables": "x"})).is_err());
        assert!(parse_descriptor(&json!({"version": 1, "tables": [1]})).is_err());
        // Unknown keys are ignored, like pydantic's default extra behavior.
        assert!(parse_descriptor(&json!({"version": 1, "extra": true})).is_ok());
    }
}
