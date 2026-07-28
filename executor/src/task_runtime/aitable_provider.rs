// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Local DingTalk AI Table schema, field, and record operations.
//!
//! Owns DingTalk access for both backend-catalogued and local projects through
//! an isolated DWS session. Records are patched cell-by-cell; raw payloads are
//! preserved so unknown field types round-trip without loss.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use super::{LoopItem, TaskProviderKind, TaskRuntimeError};
use super::{TaskCreate, TaskUpdate};

#[derive(Clone)]
pub(crate) struct AITableProvider {
    dws_binary: PathBuf,
    dws_home: PathBuf,
    dws_config_dir: PathBuf,
}

struct AITableConfig {
    base_id: String,
    table_id: String,
    mapping: Map<String, Value>,
    status_mode: String,
    status_mapping: Map<String, Value>,
}

impl AITableProvider {
    pub(crate) fn new(database_path: PathBuf) -> Result<Self, TaskRuntimeError> {
        let executor_home = database_path.parent().unwrap_or_else(|| Path::new("."));
        Ok(Self {
            dws_binary: resolve_dws_binary(),
            dws_home: executor_home.join("dws-home"),
            dws_config_dir: executor_home.join("dws-home").join(".dws"),
        })
    }

    pub(crate) async fn auth_status(&self) -> Result<Value, TaskRuntimeError> {
        self.run(&["auth", "status"]).await
    }

    pub(crate) async fn auth_login(&self) -> Result<Value, TaskRuntimeError> {
        self.run(&["auth", "login"]).await?;
        self.auth_status().await
    }

    pub(crate) async fn auth_logout(&self) -> Result<(), TaskRuntimeError> {
        self.run(&["auth", "logout", "--yes"]).await?;
        Ok(())
    }

    pub(crate) async fn describe(&self, project: &LoopItem) -> Result<Value, TaskRuntimeError> {
        let config = self.config(project)?;
        let base = self
            .run(&["aitable", "base", "get", "--base-id", &config.base_id])
            .await?;
        let table = self
            .run(&[
                "aitable",
                "table",
                "get",
                "--base-id",
                &config.base_id,
                "--table-ids",
                &config.table_id,
            ])
            .await?;
        let fields = self
            .run(&[
                "aitable",
                "field",
                "get",
                "--base-id",
                &config.base_id,
                "--table-id",
                &config.table_id,
            ])
            .await?;
        let tables = list_from(&table, &["tables", "sheets", "items", "data"]);
        let active_table = tables
            .iter()
            .find(|table| {
                table
                    .get("id")
                    .or_else(|| table.get("tableId"))
                    .and_then(Value::as_str)
                    == Some(config.table_id.as_str())
            })
            .cloned()
            .unwrap_or(Value::Null);
        Ok(json!({
            "base": base,
            "tables": tables,
            "active_table": active_table,
            "fields": list_from(&fields, &["fields", "items", "data", "results"])
                .iter()
                .map(normalize_field)
                .collect::<Vec<_>>(),
        }))
    }

    pub(crate) async fn list_records(
        &self,
        project: &LoopItem,
        query: Option<&str>,
        limit: i64,
        cursor: Option<&str>,
    ) -> Result<Value, TaskRuntimeError> {
        let config = self.config(project)?;
        let page_limit = limit.clamp(1, 100) as usize;
        let limit_value = page_limit.to_string();
        let mut args = vec![
            "aitable",
            "record",
            "query",
            "--base-id",
            &config.base_id,
            "--table-id",
            &config.table_id,
            "--limit",
            &limit_value,
        ];
        if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
            args.extend(["--query", query]);
        }
        if let Some(cursor) = cursor.filter(|value| !value.trim().is_empty()) {
            args.extend(["--cursor", cursor]);
        }
        let response = self.run(&args).await?;
        let items = list_from(&response, &["records", "items", "data", "results"])
            .iter()
            .map(normalize_record)
            .collect::<Vec<_>>();
        // DWS returns the last record cursor even when the result is shorter
        // than the requested page. Only continue when a full page was read.
        let next = string_field(
            &response,
            &["nextToken", "next_token", "nextCursor", "cursor"],
        )
        .filter(|_| items.len() >= page_limit);
        Ok(json!({
            "items": items,
            "cursor": next.clone(),
            "has_more": next.is_some(),
        }))
    }

    pub(crate) async fn get_record(
        &self,
        project: &LoopItem,
        record_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let config = self.config(project)?;
        let response = self
            .run(&[
                "aitable",
                "record",
                "query",
                "--base-id",
                &config.base_id,
                "--table-id",
                &config.table_id,
                "--record-ids",
                record_id,
            ])
            .await?;
        list_from(&response, &["records", "items", "data", "results"])
            .first()
            .map(normalize_record)
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub(crate) async fn create_record(
        &self,
        project: &LoopItem,
        cells: Map<String, Value>,
    ) -> Result<Value, TaskRuntimeError> {
        if cells.is_empty() {
            return Err(invalid("cells must not be empty"));
        }
        let config = self.config(project)?;
        let records = serde_json::to_string(&json!([{"cells": cells}]))
            .map_err(|error| invalid(error.to_string()))?;
        let response = self
            .run(&[
                "aitable",
                "record",
                "create",
                "--base-id",
                &config.base_id,
                "--table-id",
                &config.table_id,
                "--records",
                &records,
            ])
            .await?;
        Ok(normalize_write_record(response, None, &records))
    }

    pub(crate) async fn update_record(
        &self,
        project: &LoopItem,
        record_id: &str,
        cells: Map<String, Value>,
    ) -> Result<Value, TaskRuntimeError> {
        if cells.is_empty() {
            return Err(invalid("cells must not be empty"));
        }
        let config = self.config(project)?;
        let records = serde_json::to_string(&json!([{"recordId": record_id, "cells": cells}]))
            .map_err(|error| invalid(error.to_string()))?;
        let response = self
            .run(&[
                "aitable",
                "record",
                "update",
                "--base-id",
                &config.base_id,
                "--table-id",
                &config.table_id,
                "--records",
                &records,
            ])
            .await?;
        Ok(normalize_write_record(response, Some(record_id), &records))
    }

    pub(crate) async fn delete_record(
        &self,
        project: &LoopItem,
        record_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        let config = self.config(project)?;
        self.run(&[
            "aitable",
            "record",
            "delete",
            "--base-id",
            &config.base_id,
            "--table-id",
            &config.table_id,
            "--record-ids",
            record_id,
            "--yes",
        ])
        .await?;
        Ok(())
    }

    pub(crate) async fn create_field(
        &self,
        project: &LoopItem,
        name: &str,
        field_type: &str,
        property: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let config = self.config(project)?;
        let property = serde_json::to_string(&property).map_err(|e| invalid(e.to_string()))?;
        let response = self
            .run(&[
                "aitable",
                "field",
                "create",
                "--base-id",
                &config.base_id,
                "--table-id",
                &config.table_id,
                "--name",
                name,
                "--type",
                field_type,
                "--config",
                &property,
            ])
            .await?;
        Ok(normalize_field(&unwrap(response)))
    }

    pub(crate) async fn update_field(
        &self,
        project: &LoopItem,
        field_id: &str,
        payload: Map<String, Value>,
    ) -> Result<Value, TaskRuntimeError> {
        let config = self.config(project)?;
        let mut args = vec![
            "aitable",
            "field",
            "update",
            "--base-id",
            &config.base_id,
            "--table-id",
            &config.table_id,
            "--field-id",
            field_id,
        ];
        let name = payload.get("name").and_then(Value::as_str);
        let config_json = payload
            .get("config")
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| invalid(e.to_string()))?;
        if let Some(name) = name {
            args.extend(["--name", name]);
        }
        if let Some(value) = config_json.as_deref() {
            args.extend(["--config", value]);
        }
        let response = self.run(&args).await?;
        Ok(normalize_field(&unwrap(response)))
    }

    pub(crate) async fn delete_field(
        &self,
        project: &LoopItem,
        field_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        let config = self.config(project)?;
        self.run(&[
            "aitable",
            "field",
            "delete",
            "--base-id",
            &config.base_id,
            "--table-id",
            &config.table_id,
            "--field-ids",
            field_id,
            "--yes",
        ])
        .await?;
        Ok(())
    }

    fn config(&self, project: &LoopItem) -> Result<AITableConfig, TaskRuntimeError> {
        let value = project
            .metadata
            .get("provider_config")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("provider_config must be an object"))?;
        let base_id = required(value, "base_id")?;
        let table_id = value
            .get("table_id")
            .or_else(|| value.get("sheet_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| invalid("provider_config.table_id is required"))?
            .to_owned();
        let mapping = value
            .get("board_mapping")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let status_mode = value
            .get("status_mode")
            .and_then(Value::as_str)
            .unwrap_or("mapped")
            .to_owned();
        let status_mapping = value
            .get("status_mapping")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        Ok(AITableConfig {
            base_id,
            table_id,
            mapping,
            status_mode,
            status_mapping,
        })
    }

    async fn run(&self, args: &[&str]) -> Result<Value, TaskRuntimeError> {
        std::fs::create_dir_all(&self.dws_config_dir)
            .map_err(|error| TaskRuntimeError::ProviderRequest(error.to_string()))?;
        let output = Command::new(&self.dws_binary)
            .args(args)
            .args(["--format", "json"])
            // DWS 1.0.32 keeps OAuth credentials below the user home even when
            // DWS_CONFIG_DIR is set. Override both so Wework never consumes a
            // developer's global DWS session.
            .env("HOME", &self.dws_home)
            .env("USERPROFILE", &self.dws_home)
            .env("DWS_CONFIG_DIR", &self.dws_config_dir)
            // Wework owns this isolated DWS home. File-backed DEKs avoid
            // repeated macOS Keychain prompts when a stale `dek` item exists.
            .env("DWS_DISABLE_KEYCHAIN", "1")
            .output()
            .await
            .map_err(|error| {
                TaskRuntimeError::ProviderRequest(format!(
                    "DWS is unavailable at {}: {error}",
                    self.dws_binary.display()
                ))
            })?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let value = serde_json::from_str::<Value>(stdout.trim())
            .or_else(|_| serde_json::from_str::<Value>(stderr.trim()))
            .map_err(|_| {
                TaskRuntimeError::ProviderRequest(format!(
                    "DWS returned invalid JSON: {}",
                    stderr.trim()
                ))
            })?;
        if !output.status.success() || dws_response_failed(&value) {
            return Err(TaskRuntimeError::ProviderRequest(format!(
                "DWS request failed: {value}"
            )));
        }
        Ok(value)
    }

    /// Project records onto LoopItems using the optional board mapping.
    pub(crate) async fn list_board(
        &self,
        project: &LoopItem,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let mut config = self.config(project)?;
        if mapping_get(&config.mapping, "parent_field_id").is_none() {
            let fields = self
                .run(&[
                    "aitable",
                    "field",
                    "get",
                    "--base-id",
                    &config.base_id,
                    "--table-id",
                    &config.table_id,
                ])
                .await?;
            let parent_field = list_from(&fields, &["fields", "items", "data", "results"])
                .iter()
                .map(normalize_field)
                .filter(|field| field.get("name").and_then(Value::as_str) == Some("父记录"))
                .min_by_key(|field| {
                    (field.get("type").and_then(Value::as_str) != Some("text")) as u8
                });
            if let Some(field_id) = parent_field
                .as_ref()
                .and_then(|field| field.get("id"))
                .and_then(Value::as_str)
            {
                config
                    .mapping
                    .insert("parent_field_id".to_owned(), json!(field_id));
            }
        }
        let mut records = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..50 {
            let page = self
                .list_records(project, None, 100, cursor.as_deref())
                .await?;
            if let Some(items) = page.get("items").and_then(Value::as_array) {
                records.extend(items.iter().cloned());
            }
            cursor = page
                .get("cursor")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        let title_records = records
            .iter()
            .filter_map(|candidate| {
                let title = cell_text(candidate, mapping_get(&config.mapping, "title_field_id"));
                (!title.is_empty()).then(|| (title, string_of(candidate.get("id"))))
            })
            .collect::<HashMap<_, _>>();
        Ok(records
            .iter()
            .enumerate()
            .map(|(index, record)| {
                board_loop_item(project, &config, record, index + 1, &title_records)
            })
            .collect())
    }

    pub(crate) async fn get_board(
        &self,
        project: &LoopItem,
        task_id: &str,
    ) -> Result<LoopItem, TaskRuntimeError> {
        self.list_board(project)
            .await?
            .into_iter()
            .find(|item| item.id == task_id)
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub(crate) async fn create_board(
        &self,
        project: &LoopItem,
        input: TaskCreate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let config = self.config(project)?;
        let mut cells = Map::new();
        insert_mapped(
            &mut cells,
            &config.mapping,
            "title_field_id",
            json!(input.title),
        );
        insert_mapped(
            &mut cells,
            &config.mapping,
            "description_field_id",
            json!(input.description),
        );
        insert_mapped(
            &mut cells,
            &config.mapping,
            "status_field_id",
            json!(source_status_for_write(&config, &input.status, None)),
        );
        insert_mapped(
            &mut cells,
            &config.mapping,
            "priority_field_id",
            json!(input.priority),
        );
        let record = self.create_record(project, cells).await?;
        Ok(board_loop_item(
            project,
            &config,
            &record,
            1,
            &HashMap::new(),
        ))
    }

    pub(crate) async fn update_board(
        &self,
        project: &LoopItem,
        task_id: &str,
        input: TaskUpdate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let config = self.config(project)?;
        let record_id = task_id
            .rsplit(':')
            .next()
            .filter(|value| !value.is_empty())
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let mut cells = Map::new();
        if let Some(value) = input.title {
            insert_mapped(&mut cells, &config.mapping, "title_field_id", json!(value));
        }
        if let Some(value) = input.description {
            insert_mapped(
                &mut cells,
                &config.mapping,
                "description_field_id",
                json!(value),
            );
        }
        if let Some(status) = input.status {
            let value = source_status_for_write(&config, &status, None);
            insert_mapped(&mut cells, &config.mapping, "status_field_id", json!(value));
        }
        if let Some(value) = input.priority {
            insert_mapped(
                &mut cells,
                &config.mapping,
                "priority_field_id",
                json!(value),
            );
        }
        if cells.is_empty() {
            return self.get_board(project, task_id).await;
        }
        let record = self.update_record(project, record_id, cells).await?;
        Ok(board_loop_item(
            project,
            &config,
            &record,
            1,
            &HashMap::new(),
        ))
    }
}

fn resolve_dws_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("DWS_BINARY_PATH") {
        return PathBuf::from(path);
    }
    if let Ok(executable) = std::env::current_exe() {
        let sibling = executable.with_file_name(if cfg!(windows) { "dws.exe" } else { "dws" });
        if sibling.is_file() {
            return sibling;
        }
    }
    PathBuf::from(if cfg!(windows) { "dws.exe" } else { "dws" })
}

fn insert_mapped(
    cells: &mut Map<String, Value>,
    mapping: &Map<String, Value>,
    mapping_key: &str,
    value: Value,
) {
    if let Some(field_id) = mapping_get(mapping, mapping_key) {
        cells.insert(field_id.to_owned(), value);
    }
}

fn required(value: &Map<String, Value>, key: &str) -> Result<String, TaskRuntimeError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| invalid(&format!("provider_config.{key} is required")))
}

fn unwrap(response: Value) -> Value {
    if let Value::Object(map) = &response {
        for key in ["data", "result"] {
            if let Some(inner) = map.get(key).filter(|value| !value.is_null()) {
                return inner.clone();
            }
        }
    }
    response
}

fn dws_response_failed(response: &Value) -> bool {
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        return true;
    }
    if response
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| !matches!(status.to_ascii_lowercase().as_str(), "success" | "ok"))
    {
        return true;
    }
    response.get("error").is_some_and(|error| match error {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(message) => !message.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
        Value::Number(_) => true,
    })
}

fn list_from(value: &Value, keys: &[&str]) -> Vec<Value> {
    let unwrapped = unwrap(value.clone());
    if let Value::Object(map) = &unwrapped {
        for key in keys {
            if let Some(Value::Array(items)) = map.get(*key) {
                return items.clone();
            }
        }
    }
    if let Value::Array(items) = unwrapped {
        return items;
    }
    Vec::new()
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    let unwrapped = unwrap(value.clone());
    unwrapped.as_object().and_then(|map| {
        keys.iter().find_map(|key| {
            map.get(*key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(ToOwned::to_owned)
        })
    })
}

fn normalize_field(field: &Value) -> Value {
    let map = field.as_object().cloned().unwrap_or_default();
    let pick = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| map.get(*key).cloned())
            .unwrap_or(Value::Null)
    };
    json!({
        "id": string_of(map.get("id").or_else(|| map.get("fieldId"))),
        "name": string_of(map.get("name").or_else(|| map.get("fieldName"))),
        "type": string_of(map.get("type").or_else(|| map.get("uiType"))),
        "config": pick(&["property", "config"]),
        "ai_config": pick(&["aiConfig", "ai_config"]),
        "raw": field,
    })
}

fn normalize_record(record: &Value) -> Value {
    let map = record.as_object().cloned().unwrap_or_default();
    let cells = map
        .get("fields")
        .or_else(|| map.get("cells"))
        .or_else(|| map.get("values"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    json!({
        "id": string_of(map.get("id").or_else(|| map.get("recordId"))),
        "cells": cells,
        "raw": record,
    })
}

fn normalize_write_record(response: Value, record_id: Option<&str>, records_json: &str) -> Value {
    let input = serde_json::from_str::<Value>(records_json).unwrap_or_else(|_| json!([]));
    let input_record = input
        .as_array()
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let response_record = list_from(&response, &["records", "items", "data"])
        .into_iter()
        .next();
    if let Some(record) = response_record {
        return normalize_record(&record);
    }
    let created_id = string_field(&response, &["recordId", "record_id"])
        .or_else(|| {
            list_from(&response, &["newRecordIds", "recordIds"])
                .first()
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| record_id.map(ToOwned::to_owned))
        .unwrap_or_default();
    let cells = input_record
        .get("cells")
        .cloned()
        .unwrap_or_else(|| json!({}));
    json!({"id": created_id, "cells": cells, "raw": response})
}

fn string_of(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn invalid(message: impl Into<String>) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.into())
}

fn mapping_get<'a>(mapping: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    mapping
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn cell_text(record: &Value, field_id: Option<&str>) -> String {
    let Some(field_id) = field_id else {
        return String::new();
    };
    let value = record.get("cells").and_then(|cells| cells.get(field_id));
    stringify_cell(value)
}

fn stringify_cell(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Object(map) => map
                    .get("name")
                    .or_else(|| map.get("title"))
                    .or_else(|| map.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                other => stringify_cell(Some(other)),
            })
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        Some(Value::Object(map)) => map
            .get("name")
            .or_else(|| map.get("title"))
            .or_else(|| map.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    }
}

const STATUS_OPTIONS: &[(&str, &[&str])] = &[
    ("inbox", &["inbox", "todo", "backlog", "待办", "收集箱"]),
    ("pending", &["pending", "未开始", "待处理"]),
    (
        "in_progress",
        &["in progress", "in_progress", "doing", "进行中"],
    ),
    (
        "in_review",
        &["in review", "in_review", "review", "评审中", "待评审"],
    ),
    (
        "completed",
        &["completed", "done", "complete", "已完成", "完成"],
    ),
];

const PRIORITY_OPTIONS: &[(&str, &[&str])] = &[
    ("urgent", &["urgent", "紧急"]),
    ("high", &["high", "高"]),
    ("medium", &["medium", "normal", "中", "普通"]),
    ("low", &["low", "低"]),
    ("none", &["none", "无"]),
];

fn map_option(value: &str, table: &[(&str, &[&str])], default: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return default.to_owned();
    }
    for (key, candidates) in table {
        if candidates
            .iter()
            .any(|candidate| candidate.to_lowercase() == normalized)
        {
            return (*key).to_owned();
        }
    }
    default.to_owned()
}

fn mapped_status(config: &AITableConfig, source_status: &str) -> String {
    config
        .status_mapping
        .get(source_status)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| map_option(source_status, STATUS_OPTIONS, "inbox"))
}

fn source_status_for_write(
    config: &AITableConfig,
    status: &str,
    source_status: Option<&str>,
) -> String {
    if config.status_mode == "custom" {
        return source_status.unwrap_or(status).to_owned();
    }
    config
        .status_mapping
        .iter()
        .find_map(|(source, mapped)| (mapped.as_str() == Some(status)).then(|| source.clone()))
        .unwrap_or_else(|| status.to_owned())
}

fn board_loop_item(
    project: &LoopItem,
    config: &AITableConfig,
    record: &Value,
    position: usize,
    title_records: &HashMap<String, String>,
) -> LoopItem {
    let mapping = &config.mapping;
    let record_id = string_of(record.get("id"));
    let title_field = mapping_get(mapping, "title_field_id");
    let title = {
        let value = cell_text(record, title_field);
        if value.is_empty() {
            record_id.clone()
        } else {
            value
        }
    };
    let source_status = cell_text(record, mapping_get(mapping, "status_field_id"));
    let status = mapped_status(config, &source_status);
    let priority = map_option(
        &cell_text(record, mapping_get(mapping, "priority_field_id")),
        PRIORITY_OPTIONS,
        "none",
    );
    let now = chrono::Utc::now().to_rfc3339();
    LoopItem {
        id: format!("aitable:{}:{record_id}", project_key_of(project)),
        resource_type: "task".to_owned(),
        project_space: project.project_space.clone(),
        cloud_project_id: Some(project.id.clone()),
        parent_id: parent_record_id(record, mapping, title_records)
            .map(|parent| format!("aitable:{}:{parent}", project_key_of(project))),
        public_id: None,
        project_key: project.project_key.clone(),
        name: None,
        title: Some(title),
        description: cell_text(record, mapping_get(mapping, "description_field_id")),
        created_by_user_id: 0,
        sequence_number: Some(position as i64),
        next_item_number: None,
        status: Some(status),
        priority: Some(priority),
        sort_order: position as i64,
        current_delivery_id: None,
        metadata: json!({
            "task_provider": TaskProviderKind::DingtalkAitable,
            "record_id": record_id,
            "source_status": source_status,
        }),
        version: 1,
        created_at: now.clone(),
        updated_at: now,
        completed_at: None,
    }
}

fn parent_record_id(
    record: &Value,
    mapping: &Map<String, Value>,
    title_records: &HashMap<String, String>,
) -> Option<String> {
    let field_id = mapping_get(mapping, "parent_field_id")?;
    let value = record.get("cells")?.get(field_id)?;
    if let Some(record_id) = value
        .get("linkedRecordIds")
        .and_then(Value::as_array)
        .and_then(|ids| ids.first())
        .and_then(Value::as_str)
    {
        return Some(record_id.to_owned());
    }
    let parent_title = stringify_cell(Some(value));
    title_records.get(&parent_title).cloned()
}

fn project_key_of(project: &LoopItem) -> &str {
    project.project_key.as_deref().unwrap_or("AITABLE")
}

#[cfg(test)]
#[path = "aitable_provider_tests.rs"]
mod tests;
