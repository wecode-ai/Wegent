// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MySQL data access for `GET /api/bots`, mirroring
//! `bot_kinds_service.get_user_bots` / `count_user_bots`,
//! `query_bots_by_namespaces`, and `_get_bot_components_batch`.
//!
//! Every statement reproduces the source SQLAlchemy ORM rendering: full
//! column lists with `table_column` aliases, predicate order, and value
//! binding. Variable values are bound as `?` parameters; the replay matcher
//! materializes them against the recorded inline literals. Constant column
//! names, kinds, and namespaces stay inline exactly like the source's
//! client-interpolated text.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

use crate::teams::teams_repository::{BindingArg, KIND_COLUMNS, KindRow, placeholders};
use brz_json::OpaqueJson;

/// One `kinds` Bot row selected by the paginated list query. The full column
/// list matches `db.query(Kind)`; only these fields are consumed.
#[derive(Debug, FromMysqlRow)]
pub struct BotRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_user_id")]
    pub user_id: i64,
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[mysql(rename = "kinds_namespace")]
    pub namespace: String,
    #[mysql(rename = "kinds_json")]
    pub json: Json<OpaqueJson>,
    #[mysql(rename = "kinds_is_active")]
    pub is_active: i8,
    #[mysql(rename = "kinds_created_at")]
    pub created_at: NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    pub updated_at: NaiveDateTime,
}

/// Join OR-joined `AND` conditions the way SQLAlchemy renders `or_(*items)`:
/// a single item is emitted bare, otherwise the group is parenthesized.
fn or_group(conditions: &[String]) -> String {
    if conditions.len() == 1 {
        conditions[0].clone()
    } else {
        format!("({})", conditions.join(" OR "))
    }
}

/// One `(kind, name, namespace)` OR condition for a Ghost/Model batch, with
/// the kind bound as a parameter.
fn kinded_condition(kind: &str, name: &str, namespace: &str, args: &mut Vec<BindingArg>) {
    args.push(BindingArg::Str(kind.to_string()));
    args.push(BindingArg::Str(name.to_string()));
    args.push(BindingArg::Str(namespace.to_string()));
}

/// The literal `kinds.kind = ? AND kinds.name = ? AND kinds.namespace = ?`
/// condition text for one batch key.
const KINDED_CONDITION: &str = "kinds.kind = ? AND kinds.name = ? AND kinds.namespace = ?";
/// The literal `kinds.name = ? AND kinds.namespace = ?` condition text.
const NAME_NAMESPACE_CONDITION: &str = "kinds.name = ? AND kinds.namespace = ?";
/// The literal `kinds.user_id = 0 AND kinds.kind = ? AND kinds.name = ? AND
/// kinds.namespace = ?` condition text (public-model fallback).
const PUBLIC_MODEL_CONDITION: &str =
    "kinds.user_id = 0 AND kinds.kind = ? AND kinds.name = ? AND kinds.namespace = ?";

/// The user's personal Bots in `default`
/// (`query_bots_by_namespaces` default-namespace step 1).
pub async fn user_default_bots<M>(
    mysql: &M,
    user_id: i64,
    skip: i64,
    limit: i64,
) -> MysqlResult<Vec<BotRow>>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = ? AND kinds.kind = 'Bot' AND kinds.namespace = 'default' \
         AND kinds.is_active = true ORDER BY kinds.created_at DESC \n LIMIT ?, ?"
    );
    mysql
        .fetch_all(
            sql.as_str(),
            vec![
                BindingArg::Int(user_id),
                BindingArg::Int(skip),
                BindingArg::Int(limit),
            ],
        )
        .await
}

/// The public Bots in `default`, used only when the user has none
/// (`query_bots_by_namespaces` default-namespace step 2).
pub async fn public_default_bots<M>(mysql: &M, skip: i64, limit: i64) -> MysqlResult<Vec<BotRow>>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = 0 AND kinds.kind = 'Bot' AND kinds.namespace = 'default' \
         AND kinds.is_active = true ORDER BY kinds.created_at DESC \n LIMIT ?, ?"
    );
    mysql
        .fetch_all(
            sql.as_str(),
            vec![BindingArg::Int(skip), BindingArg::Int(limit)],
        )
        .await
}

/// Group-namespace Bots with no `user_id` filter
/// (`query_bots_by_namespaces` group step). `namespaces` keeps the caller's
/// order.
pub async fn group_bots<M>(
    mysql: &M,
    namespaces: &[String],
    skip: i64,
    limit: i64,
) -> MysqlResult<Vec<BotRow>>
where
    M: Mysql,
{
    if namespaces.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.kind = 'Bot' AND kinds.namespace IN ({}) AND kinds.is_active = true \
         ORDER BY kinds.created_at DESC \n LIMIT ?, ?",
        placeholders(namespaces.len()),
    );
    let mut args: Vec<BindingArg> = namespaces
        .iter()
        .map(|namespace| BindingArg::Str(namespace.clone()))
        .collect();
    args.push(BindingArg::Int(skip));
    args.push(BindingArg::Int(limit));
    mysql.fetch_all(sql.as_str(), args).await
}

/// `count_user_bots`' total: `query.count()` is rendered as a count over the
/// same filtered `kinds` projection.
pub async fn count_bots<M>(mysql: &M, user_id: i64, namespaces: &[String]) -> MysqlResult<i64>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[mysql(rename = "count_1")]
        count: i64,
    }
    let sql = format!(
        "SELECT count(*) AS count_1 \n\
         FROM (SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = ? AND kinds.kind = 'Bot' \
         AND kinds.namespace IN ({}) AND kinds.is_active = true) AS anon_1",
        placeholders(namespaces.len()),
    );
    let mut args: Vec<BindingArg> = Vec::with_capacity(namespaces.len() + 1);
    args.push(BindingArg::Int(user_id));
    args.extend(
        namespaces
            .iter()
            .map(|namespace| BindingArg::Str(namespace.clone())),
    );
    let row: Row = mysql.fetch_one(sql.as_str(), args).await?;
    Ok(row.count)
}

/// Personal Ghost keys (`user_id` + the ref triple)
/// (`_get_bot_components_batch` personal-ghost query).
pub async fn personal_ghosts<M>(
    mysql: &M,
    user_id: i64,
    keys: &[(String, String)],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<BindingArg> = Vec::with_capacity(keys.len() * 3 + 1);
    args.push(BindingArg::Int(user_id));
    let mut conditions = Vec::with_capacity(keys.len());
    for (name, namespace) in keys {
        conditions.push(KINDED_CONDITION.to_string());
        kinded_condition("Ghost", name, namespace, &mut args);
    }
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = ? AND kinds.is_active = true AND {}",
        or_group(&conditions),
    );
    mysql.fetch_all(sql.as_str(), args).await
}

/// Group Ghost keys with no `user_id` filter.
pub async fn group_ghosts<M>(mysql: &M, keys: &[(String, String)]) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<BindingArg> = Vec::with_capacity(keys.len() * 3);
    let mut conditions = Vec::with_capacity(keys.len());
    for (name, namespace) in keys {
        conditions.push(KINDED_CONDITION.to_string());
        kinded_condition("Ghost", name, namespace, &mut args);
    }
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.is_active = true AND {}",
        or_group(&conditions),
    );
    mysql.fetch_all(sql.as_str(), args).await
}

/// User shells by `(name, namespace)` keys (`get_shells_by_names_batch` user
/// step).
pub async fn user_shells<M>(
    mysql: &M,
    user_id: i64,
    keys: &[(String, String)],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<BindingArg> = Vec::with_capacity(keys.len() * 2 + 1);
    args.push(BindingArg::Int(user_id));
    let mut conditions = Vec::with_capacity(keys.len());
    for (name, namespace) in keys {
        conditions.push(NAME_NAMESPACE_CONDITION.to_string());
        args.push(BindingArg::Str(name.clone()));
        args.push(BindingArg::Str(namespace.clone()));
    }
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = ? AND kinds.kind = 'Shell' AND kinds.is_active = true AND {}",
        or_group(&conditions),
    );
    mysql.fetch_all(sql.as_str(), args).await
}

/// Public shells for the missing keys (`get_shells_by_names_batch` public
/// step; no `user_id` filter).
pub async fn public_shells<M>(mysql: &M, keys: &[(String, String)]) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<BindingArg> = Vec::with_capacity(keys.len() * 2);
    let mut conditions = Vec::with_capacity(keys.len());
    for (name, namespace) in keys {
        conditions.push(NAME_NAMESPACE_CONDITION.to_string());
        args.push(BindingArg::Str(name.clone()));
        args.push(BindingArg::Str(namespace.clone()));
    }
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.kind = 'Shell' AND kinds.is_active = true AND {}",
        or_group(&conditions),
    );
    mysql.fetch_all(sql.as_str(), args).await
}

/// Personal Model keys (`user_id` + ref triple).
pub async fn personal_models<M>(
    mysql: &M,
    user_id: i64,
    keys: &[(String, String)],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<BindingArg> = Vec::with_capacity(keys.len() * 3 + 1);
    args.push(BindingArg::Int(user_id));
    let mut conditions = Vec::with_capacity(keys.len());
    for (name, namespace) in keys {
        conditions.push(KINDED_CONDITION.to_string());
        kinded_condition("Model", name, namespace, &mut args);
    }
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = ? AND kinds.is_active = true AND {}",
        or_group(&conditions),
    );
    mysql.fetch_all(sql.as_str(), args).await
}

/// Group Model keys with no `user_id` filter.
pub async fn group_models<M>(mysql: &M, keys: &[(String, String)]) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<BindingArg> = Vec::with_capacity(keys.len() * 3);
    let mut conditions = Vec::with_capacity(keys.len());
    for (name, namespace) in keys {
        conditions.push(KINDED_CONDITION.to_string());
        kinded_condition("Model", name, namespace, &mut args);
    }
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.is_active = true AND {}",
        or_group(&conditions),
    );
    mysql.fetch_all(sql.as_str(), args).await
}

/// Public Models for the missing keys (`Kind.is_active.is_(True)`, `user_id =
/// 0`). The caller filters the result through the `allowedUsers` whitelist.
pub async fn public_models<M>(mysql: &M, keys: &[(String, String)]) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<BindingArg> = Vec::with_capacity(keys.len() * 2);
    let mut conditions = Vec::with_capacity(keys.len());
    for (name, namespace) in keys {
        conditions.push(PUBLIC_MODEL_CONDITION.to_string());
        args.push(BindingArg::Str("Model".to_string()));
        args.push(BindingArg::Str(name.clone()));
        args.push(BindingArg::Str(namespace.clone()));
    }
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.is_active IS true AND {}",
        or_group(&conditions),
    );
    mysql.fetch_all(sql.as_str(), args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_condition_is_not_parenthesized() {
        assert_eq!(or_group(&["a".to_string()]), "a");
    }

    #[test]
    fn multiple_conditions_are_parenthesized_and_joined() {
        assert_eq!(or_group(&["a".to_string(), "b".to_string()]), "(a OR b)");
    }

    #[test]
    fn public_model_condition_orders_columns_like_the_source() {
        // `and_(Kind.user_id == 0, Kind.kind == "Model", Kind.name, Kind.namespace)`
        assert_eq!(
            PUBLIC_MODEL_CONDITION,
            "kinds.user_id = 0 AND kinds.kind = ? AND kinds.name = ? AND kinds.namespace = ?"
        );
    }
}
