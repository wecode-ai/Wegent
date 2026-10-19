//! KindBaseService reads and committed resource writes for new-user batches.
use anyhow::Result;
use brz_mysql::{MysqlRow, MysqlService, MysqlTransaction};
use serde_json::Value;

use super::tasks::TaskResources;
use crate::state::AppState;

pub struct Resource {
    pub id: i64,
    pub user_id: i64,
    pub json: brz_mysql::Json<Value>,
    /// Opaque lookup context retained by a deployment's storage adapter.
    pub storage_key: Option<u64>,
}

impl Resource {
    pub fn from_row(row: MysqlRow) -> brz_mysql::MysqlResult<Self> {
        Ok(Self {
            id: row.get_at(0)?,
            user_id: row.get_at(1)?,
            json: row.get_at(5)?,
            storage_key: None,
        })
    }
}

const KIND_COLUMNS: &str = crate::v1_resources::repository::KIND_COLUMNS;
const KIND_REFRESH_COLUMNS: &str = "kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at";

pub(super) async fn permitted(
    state: &AppState,
    user_id: i64,
    namespace: &str,
    required: &str,
) -> Result<bool> {
    if namespace == "default" {
        return Ok(true);
    }
    let entries = crate::permissions::iter_user_groups_with_roles(
        &state.mysql,
        &state.entity_resolvers,
        state.redis.as_ref(),
        user_id,
    )
    .await?;
    let roles = crate::permissions::effective_roles_in_groups(&entries, &[namespace.to_owned()]);
    Ok(roles
        .iter()
        .find(|(name, _)| name == namespace)
        .is_some_and(|(_, role)| crate::teams::group_membership::has_permission(role, required)))
}

pub(super) async fn get(
    state: &AppState,
    tasks: &dyn TaskResources,
    user_id: i64,
    kind: &str,
    namespace: &str,
    name: &str,
) -> Result<Option<Resource>> {
    if !permitted(state, user_id, namespace, "Reporter").await? {
        return Ok(None);
    }
    get_unchecked(state, tasks, user_id, kind, namespace, name).await
}

pub(super) async fn get_unchecked(
    state: &AppState,
    tasks: &dyn TaskResources,
    user_id: i64,
    kind: &str,
    namespace: &str,
    name: &str,
) -> Result<Option<Resource>> {
    if matches!(kind, "Task" | "Workspace") {
        return tasks.get(user_id, kind, namespace, name).await;
    }
    let mut sql = format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.kind = ? AND kinds.namespace = ? AND kinds.is_active = true"
    );
    let mut args = vec![
        crate::sql_support::StatementArg::Str(kind.into()),
        crate::sql_support::StatementArg::Str(namespace.into()),
    ];
    if namespace == "default" {
        sql.push_str(" AND kinds.user_id = ?");
        args.push(crate::sql_support::StatementArg::Int(user_id));
    }
    if !name.is_empty() {
        sql.push_str(" AND kinds.name = ?");
        args.push(crate::sql_support::StatementArg::Str(name.into()));
    }
    sql.push_str(" LIMIT 1");
    let row: Option<MysqlRow> = state.mysql.fetch_optional(sql, args).await?;
    Ok(row.map(Resource::from_row).transpose()?)
}

pub(super) async fn owned_kind(
    mysql: &MysqlService,
    user_id: i64,
    kind: &str,
    namespace: &str,
    name: &str,
) -> Result<Option<Resource>> {
    let row: Option<MysqlRow> = mysql.fetch_optional(format!("SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.kind = ? AND kinds.namespace = ? AND kinds.name = ? AND kinds.is_active = true LIMIT 1"), (user_id, kind, namespace, name)).await?;
    Ok(row.map(Resource::from_row).transpose()?)
}

pub(super) async fn save(
    mysql: &MysqlService,
    user_id: i64,
    kind: &str,
    namespace: &str,
    name: &str,
    existing: Option<&Resource>,
    resource: &Value,
) -> Result<i64> {
    let payload = crate::json_compat::python_json_value(resource);
    let resource_id = mysql.with_transaction(async |tx| {
        if let Some(existing) = existing {
            if !json_equal(&existing.json.0, resource) {
                tx.execute("UPDATE kinds SET json = ?, updated_at = now() WHERE kinds.id = ?", (payload.as_str(), existing.id)).await?;
            }
            Ok(existing.id)
        } else {
            let result = tx.execute("INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, true, now(), now())", (user_id, kind, name, namespace, payload.as_str())).await?;
            Ok(result.last_insert_id as i64)
        }
    }).await?;
    // db.refresh reloads the committed resource even though only its id is returned.
    let _: Option<MysqlRow> = mysql
        .fetch_optional(
            format!("SELECT {KIND_REFRESH_COLUMNS} FROM kinds WHERE kinds.id = ?"),
            (resource_id,),
        )
        .await?;
    Ok(resource_id)
}

fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| json_equal(a, b)))
        }
        (Value::Bool(a), Value::Number(b)) | (Value::Number(b), Value::Bool(a)) => {
            b.as_f64() == Some(f64::from(u8::from(*a)))
        }
        (Value::Number(a), Value::Number(b)) => {
            if a == b {
                return true;
            }
            let exact = |n: &serde_json::Number| {
                n.as_i64()
                    .map(i128::from)
                    .or_else(|| n.as_u64().map(i128::from))
            };
            match (exact(a), exact(b)) {
                (Some(a), Some(b)) => a == b,
                (Some(integer), None) => b
                    .as_f64()
                    .is_some_and(|f| f.fract() == 0.0 && f as i128 == integer),
                (None, Some(integer)) => a
                    .as_f64()
                    .is_some_and(|f| f.fract() == 0.0 && f as i128 == integer),
                (None, None) => a.as_f64() == b.as_f64(),
            }
        }
        _ => left == right,
    }
}
