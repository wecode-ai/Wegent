//! TaskResourceBaseService storage boundary for Task/Workspace batch resources.
use anyhow::Result;
use async_trait::async_trait;
use brz_mysql::{Mysql, MysqlRow, MysqlService, MysqlTransaction};
use serde_json::Value;

pub use super::repository::Resource;
const TASK_COLUMNS: &str = "id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, client_origin, is_group_chat";

#[async_trait]
pub trait TaskResources: Send + Sync {
    async fn get(
        &self,
        user_id: i64,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<Resource>>;
    async fn owned_task(
        &self,
        user_id: i64,
        namespace: &str,
        name: &str,
    ) -> Result<Option<Resource>>;
    async fn save(
        &self,
        user_id: i64,
        kind: &str,
        namespace: &str,
        name: &str,
        existing: Option<&Resource>,
        resource: &Value,
    ) -> Result<i64>;
}

pub struct BaseTaskResources {
    pub mysql: MysqlService,
}

#[async_trait]
impl TaskResources for BaseTaskResources {
    async fn owned_task(
        &self,
        user_id: i64,
        namespace: &str,
        name: &str,
    ) -> Result<Option<Resource>> {
        owned_task(&self.mysql, "tasks", user_id, namespace, name).await
    }
    async fn get(
        &self,
        user_id: i64,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<Resource>> {
        Ok(list(&self.mysql, "tasks", user_id, kind, namespace, name)
            .await?
            .into_iter()
            .next())
    }

    async fn save(
        &self,
        user_id: i64,
        kind: &str,
        namespace: &str,
        name: &str,
        existing: Option<&Resource>,
        resource: &Value,
    ) -> Result<i64> {
        save(
            &self.mysql,
            "tasks",
            ResourceWrite {
                user_id,
                kind,
                namespace,
                name,
                id: existing.map(|r| r.id),
                allocated_id: None,
                resource,
            },
        )
        .await
    }
}

pub async fn owned_task<M: Mysql>(
    mysql: &M,
    table: &str,
    user_id: i64,
    namespace: &str,
    name: &str,
) -> Result<Option<Resource>> {
    let row: Option<MysqlRow> = mysql.fetch_optional(format!("SELECT {TASK_COLUMNS} FROM {table} WHERE user_id = ? AND kind = 'Task' AND namespace = ? AND name = ? AND is_active = 1 LIMIT 1"), (user_id, namespace, name)).await?;
    Ok(row.map(Resource::from_row).transpose()?)
}

pub async fn list<M: Mysql>(
    mysql: &M,
    table: &str,
    user_id: i64,
    kind: &str,
    namespace: &str,
    name: &str,
) -> Result<Vec<Resource>> {
    let mut sql = format!(
        "SELECT {TASK_COLUMNS} FROM {table} WHERE kind = ? AND namespace = ? AND is_active = ?"
    );
    let mut args = vec![
        crate::sql_support::StatementArg::Str(kind.into()),
        crate::sql_support::StatementArg::Str(namespace.into()),
        crate::sql_support::StatementArg::Int(1),
    ];
    if namespace == "default" {
        sql.push_str(" AND user_id = ?");
        args.push(crate::sql_support::StatementArg::Int(user_id));
    }
    if !name.is_empty() {
        sql.push_str(" AND name = ?");
        args.push(crate::sql_support::StatementArg::Str(name.into()));
    }
    let rows: Vec<MysqlRow> = mysql.fetch_all(sql, args).await?;
    Ok(rows
        .into_iter()
        .map(Resource::from_row)
        .collect::<brz_mysql::MysqlResult<_>>()?)
}

pub struct ResourceWrite<'a> {
    pub user_id: i64,
    pub kind: &'a str,
    pub namespace: &'a str,
    pub name: &'a str,
    pub id: Option<i64>,
    pub allocated_id: Option<i64>,
    pub resource: &'a Value,
}

pub async fn save<M: Mysql>(mysql: &M, table: &str, input: ResourceWrite<'_>) -> Result<i64> {
    let ResourceWrite {
        user_id,
        kind,
        namespace,
        name,
        id,
        allocated_id,
        resource,
    } = input;
    let json = crate::json_compat::python_json_value(resource);
    let now = chrono::Local::now().naive_local();
    let id = mysql.with_transaction(async |tx| {
        if let Some(id) = id {
            tx.execute(format!("UPDATE {table} SET json = ?, updated_at = ? WHERE id = ?"), (json.as_str(), now, id)).await?;
            return Ok(id);
        }
        if let Some(id) = allocated_id {
            tx.execute("SAVEPOINT sa_savepoint_1", ()).await?;
            tx.execute(format!("INSERT INTO {table} (id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, client_origin, is_group_chat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"), (id, user_id, kind, name, namespace, json.as_str(), 1_i64, now, now, 0_i64, "frontend", 0_i64)).await?;
            tx.execute("RELEASE SAVEPOINT sa_savepoint_1", ()).await?;
            Ok(id)
        } else {
            let result = tx.execute(format!("INSERT INTO {table} (user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, client_origin, is_group_chat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"), (user_id, kind, name, namespace, json.as_str(), 1_i64, now, now, 0_i64, "frontend", 0_i64)).await?;
            Ok(result.last_insert_id as i64)
        }
    }).await?;
    let _: Option<MysqlRow> = mysql
        .fetch_optional(
            format!("SELECT {TASK_COLUMNS} FROM {table} WHERE id = ?"),
            (id,),
        )
        .await?;
    Ok(id)
}
