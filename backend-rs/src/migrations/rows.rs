//! Small row helpers for the dynamic historical data migrations.

use brz_mysql::{FromMysqlRow, Json, MysqlArgs, MysqlResult, MysqlTransaction};
use serde_json::Value;

use super::schema_changes::ident;
use crate::sql_support::StatementArg;

#[derive(FromMysqlRow)]
struct Row {
    data: Json<Value>,
}

pub(super) async fn query<A: MysqlArgs + Send>(
    tx: &mut impl MysqlTransaction,
    sql: &str,
    args: A,
) -> MysqlResult<Vec<Value>> {
    let rows: Vec<Row> = tx.fetch_all(sql, args).await?;
    Ok(rows.into_iter().map(|r| r.data.0).collect())
}

pub(super) async fn select<A: MysqlArgs + Send>(
    tx: &mut impl MysqlTransaction,
    table: &str,
    columns: &[&str],
    filter: &str,
    args: A,
) -> MysqlResult<Vec<Value>> {
    let fields = columns
        .iter()
        .map(|c| format!("'{c}',{}", ident(c)))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT JSON_OBJECT({fields}) AS data FROM {} WHERE {filter}",
        ident(table)
    );
    let rows: Vec<Row> = tx.fetch_all(sql, args).await?;
    Ok(rows.into_iter().map(|r| r.data.0).collect())
}

fn argument(value: &Value) -> Option<StatementArg> {
    match value {
        Value::Null => None,
        Value::Bool(v) => Some(StatementArg::Int(i64::from(*v))),
        Value::Number(v) if v.is_i64() => Some(StatementArg::Int(v.as_i64().unwrap())),
        Value::String(v) => Some(StatementArg::Str(v.clone())),
        v => Some(StatementArg::Str(v.to_string())),
    }
}

pub(super) async fn insert(
    tx: &mut impl MysqlTransaction,
    table: &str,
    values: &Value,
) -> MysqlResult<u64> {
    let object = values.as_object().expect("migration insert uses an object");
    let mut columns = object
        .keys()
        .map(|k| ident(k))
        .collect::<Vec<_>>()
        .join(",");
    let mut placeholders = vec!["?"; object.len()].join(",");
    // ORM-created schemas have client-side timestamp defaults. Migration inserts
    // must supply them explicitly, including when upgrading such a schema.
    if ["loop_items", "resource_members", "kinds"].contains(&table) {
        let timestamps: &[&str] = if table == "resource_members" {
            &["created_at", "updated_at", "requested_at"]
        } else {
            &["created_at", "updated_at"]
        };
        for &name in timestamps {
            if !object.contains_key(name) {
                columns.push_str(&format!(",{}", ident(name)));
                placeholders.push_str(",CURRENT_TIMESTAMP");
            }
        }
    }
    let args = object.values().map(argument).collect::<Vec<_>>();
    Ok(tx
        .execute(
            format!(
                "INSERT INTO {} ({columns}) VALUES ({placeholders})",
                ident(table)
            ),
            args,
        )
        .await?
        .last_insert_id)
}

pub(super) async fn update(
    tx: &mut impl MysqlTransaction,
    table: &str,
    id: &Value,
    values: &Value,
) -> MysqlResult<()> {
    let object = values.as_object().expect("migration update uses an object");
    let columns = object
        .keys()
        .map(|k| format!("{}=?", ident(k)))
        .collect::<Vec<_>>()
        .join(",");
    let mut args = object.values().map(argument).collect::<Vec<_>>();
    args.push(argument(id));
    tx.execute(
        format!("UPDATE {} SET {columns} WHERE id=?", ident(table)),
        args,
    )
    .await?;
    Ok(())
}

pub(super) fn string(value: &Value) -> String {
    crate::json_compat::python_str(value)
}

pub(super) fn uuid() -> String {
    crate::background_jobs::project::notifications::uuid()
}

pub(super) fn take(value: &mut Value, key: &str, default: Value) -> Value {
    value
        .as_object_mut()
        .and_then(|o| o.remove(key))
        .unwrap_or(default)
}

pub(super) fn object(value: &Value) -> MysqlResult<Value> {
    if value.is_null() {
        return Ok(serde_json::json!({}));
    }
    if value.is_object() {
        return Ok(value.clone());
    }
    Err(brz_mysql::MysqlError::InvalidQuery {
        reason: "historical migration expected a JSON object".into(),
    })
}
