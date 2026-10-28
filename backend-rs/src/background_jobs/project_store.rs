// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Shared, transactional persistence for the polymorphic project rows.

use std::collections::BTreeMap;

use brz_mysql::{
    FromMysqlRow, Json, Mysql, MysqlResult, MysqlTransaction, MysqlValue, MysqlValueWriter,
};
use chrono::{NaiveDateTime, Utc};
use serde_json::{Value, json};

pub(crate) const UNSET: &str = "1970-01-01 00:00:01";
pub(crate) const LIVE: &str =
    "(deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))";
pub(crate) const COLUMNS: &str = "id, resource_type, COALESCE(cloud_project_id,'') AS cloud_project_id, COALESCE(parent_id,'') AS parent_id, COALESCE(loop_item_id,'') AS loop_item_id, COALESCE(name,'') AS name, COALESCE(project_key,'') AS project_key, COALESCE(next_item_number,1) AS next_item_number, COALESCE(local_project_id,0) AS local_project_id, COALESCE(assignee_user_id,0) AS assignee_user_id, COALESCE(assignee_team_id,0) AS assignee_team_id, COALESCE(priority,'') AS priority, COALESCE(title,'') AS title, COALESCE(description,'') AS description, COALESCE(status,'') AS status, COALESCE(source,'') AS source, COALESCE(created_by_user_id,0) AS created_by_user_id, COALESCE(user_id,0) AS user_id, COALESCE(task_user_id,0) AS task_user_id, COALESCE(task_id,'') AS task_id, COALESCE(task_title,'') AS task_title, COALESCE(device_id,'') AS device_id, COALESCE(backend_task_id,0) AS backend_task_id, COALESCE(assignee_agent_id,'') AS assignee_agent_id, COALESCE(metadata,JSON_OBJECT()) AS metadata, due_at, COALESCE(version,1) AS version";

#[derive(Clone, Debug, FromMysqlRow)]
pub(crate) struct Node {
    pub id: String,
    pub resource_type: String,
    pub cloud_project_id: String,
    pub parent_id: String,
    pub loop_item_id: String,
    pub name: String,
    pub project_key: String,
    pub next_item_number: i64,
    pub local_project_id: i64,
    pub assignee_user_id: i64,
    pub assignee_team_id: i64,
    pub priority: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub source: String,
    pub created_by_user_id: i64,
    pub user_id: i64,
    pub task_user_id: i64,
    pub task_id: String,
    pub task_title: String,
    pub device_id: String,
    pub backend_task_id: i64,
    pub assignee_agent_id: String,
    pub metadata: Json<Value>,
    pub due_at: Option<NaiveDateTime>,
    pub version: i64,
}

impl Node {
    pub fn meta(&self) -> Value {
        if self.metadata.0.is_object() {
            self.metadata.0.clone()
        } else {
            json!({})
        }
    }

    pub fn unresolved(&self) -> bool {
        self.status == "skipped"
            && self.metadata.0["execution_target"]["reason"]
                .as_str()
                .unwrap_or(&self.description)
                .to_lowercase()
                .contains("binding")
    }
}

pub(crate) fn id() -> String {
    let mut bytes = [0; 8];
    getrandom::getrandom(&mut bytes).expect("system randomness");
    (u64::from_le_bytes(bytes) % 9_000_000_000_000_000_000 + 1).to_string()
}

pub(crate) fn iso(now: NaiveDateTime) -> String {
    now.format("%Y-%m-%dT%H:%M:%S%.f").to_string()
}

pub(crate) async fn get(mysql: &impl Mysql, kind: &str, id: &str) -> MysqlResult<Option<Node>> {
    mysql
        .fetch_optional(
            format!("SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type=?"),
            (id, kind),
        )
        .await
}

pub(crate) async fn locked(
    tx: &mut impl MysqlTransaction,
    kind: &str,
    id: &str,
) -> MysqlResult<Option<Node>> {
    tx.fetch_optional(
        format!("SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type=? FOR UPDATE"),
        (id, kind),
    )
    .await
}

#[derive(Debug, FromMysqlRow)]
struct Column {
    column_name: String,
    is_nullable: String,
    data_type: String,
}

#[derive(Clone)]
enum Arg {
    Null,
    Int(i64),
    Text(String),
}

impl MysqlValue for Arg {
    fn write(self, writer: &mut MysqlValueWriter) -> MysqlResult<()> {
        match self {
            Self::Null => Option::<String>::None.write(writer),
            Self::Int(v) => v.write(writer),
            Self::Text(v) => v.write(writer),
        }
    }
    fn encoded_size_hint(&self) -> usize {
        match self {
            Self::Null => 0,
            Self::Int(v) => v.encoded_size_hint(),
            Self::Text(v) => v.encoded_size_hint(),
        }
    }
}

/// Respect the same nullable-vs-sentinel adapter as Python's LoopNode hooks.
/// In particular, nullable unique public_id/project_key/storage_prefix must
/// remain NULL; an empty string would create collisions between unrelated rows.
pub(crate) async fn insert(
    tx: &mut impl MysqlTransaction,
    kind: &str,
    values: Value,
) -> MysqlResult<String> {
    let columns: Vec<Column> = tx.fetch_all(
        "SELECT CAST(COLUMN_NAME AS CHAR) AS column_name, CAST(IS_NULLABLE AS CHAR) AS is_nullable, CAST(DATA_TYPE AS CHAR) AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='loop_items' ORDER BY ORDINAL_POSITION", ()
    ).await?;
    let now = Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.f")
        .to_string();
    let mut row = BTreeMap::from([
        ("id".to_string(), json!(id())),
        ("resource_type".into(), json!(kind)),
        ("project_space".into(), json!("default")),
        ("description".into(), json!("")),
        ("assignee_agent_id".into(), json!("")),
        ("sort_order".into(), json!(0)),
        ("sequence_number".into(), json!(0)),
        ("next_item_number".into(), json!(1)),
        ("metadata".into(), json!({})),
        ("version".into(), json!(1)),
        ("created_at".into(), json!(now)),
        ("updated_at".into(), json!(now)),
    ]);
    if let Value::Object(values) = values {
        row.extend(values);
    }
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    let mut args = Vec::with_capacity(columns.len());
    let names: Vec<_> = columns
        .iter()
        .map(|column| format!("`{}`", column.column_name))
        .collect();
    for column in &columns {
        let value = row.get(&column.column_name);
        args.push(match value {
            Some(Value::Null) | None if column.is_nullable == "YES" => Arg::Null,
            Some(Value::String(value)) => Arg::Text(value.clone()),
            Some(Value::Number(value)) => Arg::Int(value.as_i64().unwrap_or(0)),
            Some(Value::Bool(value)) => Arg::Int(i64::from(*value)),
            Some(Value::Object(_) | Value::Array(_)) => Arg::Text(value.unwrap().to_string()),
            _ => match column.data_type.as_str() {
                "datetime" | "timestamp" => Arg::Text(UNSET.into()),
                "tinyint" | "smallint" | "mediumint" | "int" | "bigint" | "float" | "double"
                | "decimal" => Arg::Int(0),
                "json" => Arg::Text("{}".into()),
                _ => Arg::Text(String::new()),
            },
        });
    }
    let placeholders = vec!["?"; columns.len()].join(",");
    tx.execute(
        format!(
            "INSERT INTO loop_items ({}) VALUES ({placeholders})",
            names.join(",")
        ),
        args,
    )
    .await?;
    Ok(id)
}

pub(crate) fn new_run(
    rule: &Node,
    trigger: &str,
    scheduled_for: NaiveDateTime,
    public_id: Option<&str>,
) -> Value {
    json!({"public_id":public_id,"cloud_project_id":rule.cloud_project_id,"parent_id":rule.id,
        "assignee_agent_id":rule.assignee_agent_id,"source":trigger,"status":"pending",
        "created_by_user_id":rule.created_by_user_id,"metadata":{"trigger":trigger,
        "timezone":rule.metadata.0["timezone"].as_str().unwrap_or("Asia/Shanghai"),
        "scheduled_for":iso(scheduled_for),"error":null}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_fit_signed_database_keys_and_are_nonzero() {
        for _ in 0..32 {
            assert!((1..=i64::MAX).contains(&id().parse::<i64>().unwrap()));
        }
    }
}
