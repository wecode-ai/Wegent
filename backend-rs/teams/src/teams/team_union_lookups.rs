// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `kinds` / `users` preload lookups the teams endpoints share with the
//! accessible-team union (`batch_load_kinds_by_refs`, `db.query(User)`).
//!
//! Split from `team_union` to keep each file under the 1000-line source-review
//! limit; the statements and their ordering contracts are unchanged.
use brz_mysql::{Mysql, MysqlResult};

use super::teams_repository::{KIND_COLUMNS, KindRow, placeholders};

/// Bots by `(user_id, name, namespace)` triples (personal bots) or
/// `(name, namespace)` pairs (group bots). `refs` keeps the caller's
/// construction order, duplicates included, exactly like the source's
/// `all_bot_refs` list.
/// One bound argument of a `kinds_by_refs` query. The source renders
/// `kinds.user_id` as an integer literal and `kinds.name` / `kinds.namespace`
/// as quoted strings; the replay matcher compares bound values by token kind,
/// so the user id must bind as an integer exactly like the recorded rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
enum KindRefArg {
    Int(i64),
    Str(String),
}

impl brz_mysql::MysqlValue for KindRefArg {
    fn write(self, writer: &mut brz_mysql::MysqlValueWriter) -> MysqlResult<()> {
        match self {
            Self::Int(value) => value.write(writer),
            Self::Str(value) => value.write(writer),
        }
    }
    fn encoded_size_hint(&self) -> usize {
        match self {
            Self::Int(value) => value.encoded_size_hint(),
            Self::Str(value) => value.encoded_size_hint(),
        }
    }
}

/// Bot/shell/model kinds by `(user_id, name, namespace)` triples (personal
/// kinds) or `(name, namespace)` pairs (group kinds). `refs` keeps the
/// caller's construction order, duplicates included, exactly like the source's
/// `all_bot_refs` list.
pub async fn kinds_by_refs<M>(
    mysql: &M,
    kind: &str,
    refs: &[(i64, String, String)],
    with_user: bool,
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let mut conditions = Vec::with_capacity(refs.len());
    for _ in refs {
        conditions.push(if with_user {
            "kinds.user_id = ? AND kinds.name = ? AND kinds.namespace = ?"
        } else {
            "kinds.name = ? AND kinds.namespace = ?"
        });
    }
    // SQLAlchemy renders `or_(*conditions)` without parentheses when there is
    // exactly one condition (recorded single group-bot / single-ref queries),
    // and with parentheses around the joined group otherwise.
    let joined = conditions.join(" OR ");
    let condition_sql = if conditions.len() == 1 {
        joined
    } else {
        format!("({joined})")
    };
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.kind = ? AND kinds.is_active = true AND {condition_sql}"
    );
    let mut args: Vec<KindRefArg> = Vec::with_capacity(refs.len() * 3 + 1);
    args.push(KindRefArg::Str(kind.to_string()));
    for (user_id, name, namespace) in refs {
        if with_user {
            args.push(KindRefArg::Int(*user_id));
        }
        args.push(KindRefArg::Str(name.clone()));
        args.push(KindRefArg::Str(namespace.clone()));
    }
    mysql.fetch_all(sql.as_str(), args).await
}

/// Public kinds by name (`user_id = 0`). `names` keeps the caller's order.
pub async fn public_kinds_by_names<M>(
    mysql: &M,
    kind: &str,
    names: &[String],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.kind = ? AND kinds.user_id = 0 \
         AND kinds.is_active = true AND kinds.name IN ({})",
        placeholders(names.len()),
    );
    let mut args: Vec<String> = Vec::with_capacity(names.len() + 1);
    args.push(kind.to_string());
    args.extend(names.iter().cloned());
    mysql.fetch_all(sql.as_str(), args).await
}
