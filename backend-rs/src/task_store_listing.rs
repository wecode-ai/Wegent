// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Subtask-listing read model shared by the task store.
//!
//! The `subtask_contexts` labeling projection and the two listing result types
//! the [`crate::task_store::TaskStore`] methods return. Extracted from
//! `crate::task_store` to keep that module within the repository's file-size
//! bound; `task_store` re-exports these items.

use brz_mysql::MysqlRow;

// Leave ample headroom below MySQL's 65,535 prepared-statement parameters.
const SUBTASK_IDS_PER_BATCH: usize = 1_000;

/// Read the complete owner-filtered conversation without sorting large JSON
/// columns. All reads use the same handle, including any deployment route.
pub async fn ordered_subtasks_for_user<M: brz_mysql::Mysql>(
    mysql: &M,
    table: &str,
    task_id: i64,
    user_id: i32,
) -> brz_mysql::MysqlResult<Vec<MysqlRow>> {
    let rows: Vec<MysqlRow> = mysql
        .fetch_all(
            crate::task_store_statements::subtask_ids_by_owner_statement(table),
            (task_id, user_id),
        )
        .await?;
    let ids = rows
        .iter()
        .map(|row| row.get_required::<i64>("id"))
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;
    load_subtasks_by_ids(mysql, table, &ids).await
}

/// `subtask_store.list_by_task` page parameters. `owner_user_id` carries the
/// non-member filter the caller's `is_member` produced (`Some` restricts to
/// that owner).
#[derive(Debug, Clone, Copy)]
pub struct SubtaskPage {
    pub owner_user_id: Option<i32>,
    pub before_message_id: Option<i64>,
    pub from_latest: bool,
    pub skip: i64,
    pub limit: i64,
}

/// `subtask_store.list_by_task` for the single-table store, read from `table`:
/// the ordered id page, then the id-scoped full-row load.
pub async fn page_subtasks_by_task<M: brz_mysql::Mysql>(
    mysql: &M,
    table: &str,
    task_id: i64,
    page: &SubtaskPage,
) -> brz_mysql::MysqlResult<Vec<MysqlRow>> {
    let statement = crate::task_store_statements::subtask_ids_for_task_page_statement(
        table,
        page.owner_user_id.is_some(),
        page.before_message_id.is_some(),
        page.from_latest,
    );
    let mut args: Vec<crate::task_store_statements::StatementArg> =
        vec![crate::task_store_statements::StatementArg::Int(task_id)];
    if let Some(owner) = page.owner_user_id {
        args.push(crate::task_store_statements::StatementArg::Int(i64::from(
            owner,
        )));
    }
    if let Some(before) = page.before_message_id {
        args.push(crate::task_store_statements::StatementArg::Int(before));
    }
    args.push(crate::task_store_statements::StatementArg::Int(page.skip));
    args.push(crate::task_store_statements::StatementArg::Int(page.limit));
    let id_rows: Vec<MysqlRow> = mysql.fetch_all(statement, args).await?;
    let mut ids: Vec<i64> = id_rows
        .iter()
        .map(|row| row.get_required::<i64>("id"))
        .collect::<brz_mysql::MysqlResult<_>>()?;
    // `from_latest` reads the descending page, then the source restores
    // ascending id order before loading.
    if page.from_latest {
        ids.reverse();
    }
    load_subtasks_by_ids(mysql, table, &ids).await
}

/// `subtask_store.count_by_task_for_user` for the single-table store, read from
/// `table`.
pub async fn count_subtasks_by_task<M: brz_mysql::Mysql>(
    mysql: &M,
    table: &str,
    task_id: i64,
    owner_user_id: Option<i32>,
) -> brz_mysql::MysqlResult<i64> {
    let statement = crate::task_store_statements::subtask_count_for_task_statement(
        table,
        owner_user_id.is_some(),
    );
    let rows: Vec<MysqlRow> = match owner_user_id {
        Some(owner) => mysql.fetch_all(statement, (task_id, owner)).await?,
        None => mysql.fetch_all(statement, (task_id,)).await?,
    };
    match rows.first() {
        Some(row) => row.get_required("count_1"),
        None => Ok(0),
    }
}

/// `_load_ordered` / `_load_ordered_from_model`'s id-scoped read: the full
/// subtask projection for `ids`, re-ordered by the caller's id list (the
/// source's `id_to_subtask` dict lookup). An empty id list issues no statement.
pub async fn load_subtasks_by_ids<M: brz_mysql::Mysql>(
    mysql: &M,
    table: &str,
    ids: &[i64],
) -> brz_mysql::MysqlResult<Vec<MysqlRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut by_id: std::collections::HashMap<i64, MysqlRow> =
        std::collections::HashMap::with_capacity(ids.len());
    for batch in ids.chunks(SUBTASK_IDS_PER_BATCH) {
        let rows: Vec<MysqlRow> = mysql
            .fetch_all(
                crate::task_store_statements::subtasks_by_ids_statement(table, batch.len()),
                batch.to_vec(),
            )
            .await?;
        for row in rows {
            let id: i64 = row.get_required("id")?;
            by_id.insert(id, row);
        }
    }
    let mut ordered: Vec<MysqlRow> = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(row) = by_id.remove(id) {
            ordered.push(row);
        }
    }
    Ok(ordered)
}

/// The `subtask_contexts` labeling projection the context reads share
/// (`context_columns`): every column labelled with its own table name, in the
/// recorded order.
pub fn subtask_context_columns() -> String {
    [
        "id",
        "subtask_id",
        "user_id",
        "context_type",
        "name",
        "status",
        "error_message",
        "binary_data",
        "image_base64",
        "extracted_text",
        "text_length",
        "type_data",
        "created_at",
        "updated_at",
    ]
    .iter()
    .map(|column| format!("subtask_contexts.{column} AS subtask_contexts_{column}"))
    .collect::<Vec<_>>()
    .join(", ")
}

/// One subtask listing from `subtask_store.list_by_task_ordered`.
///
/// The source attaches the subtask contexts to a listing whose rows came from
/// a table the deployment resolved itself, so `contexts` carries that batch
/// there and is `None` on the path where the source leaves the contexts to be
/// loaded later. A caller that only reads the rows ignores it.
#[derive(Debug)]
pub struct SubtaskListing {
    pub rows: Vec<MysqlRow>,
    pub contexts: Option<Vec<MysqlRow>>,
}

/// One `task_store.list_owned_task_ids` page: the source total and the page's
/// task ids in the store's own order.
#[derive(Debug)]
pub struct OwnedTaskPage {
    pub total: i64,
    pub ids: Vec<i64>,
}

/// `task_store.list_owned_task_ids`: the distinct count plus one page of the
/// owner's task ids.
pub async fn owned_task_id_page<M: brz_mysql::Mysql>(
    mysql: &M,
    user_id: i64,
    skip: i64,
    limit: i64,
) -> brz_mysql::MysqlResult<OwnedTaskPage> {
    use crate::task_store_statements::TASKS_TABLE;
    use crate::tasks_search::statements::{owned_task_count_statement, owned_task_ids_statement};
    let totals = mysql
        .fetch_all(owned_task_count_statement(TASKS_TABLE), (user_id,))
        .await?;
    let total = totals
        .first()
        .map_or(Ok(0), |row: &MysqlRow| row.get_required::<i64>("count_1"))?;
    // The statement omits `OFFSET ?` on the first page, so the bind list must
    // omit `skip` too; an extra bind shifts the parameters and returns no rows.
    let rows = if skip > 0 {
        mysql
            .fetch_all(
                owned_task_ids_statement(TASKS_TABLE, true),
                (user_id, limit, skip),
            )
            .await?
    } else {
        mysql
            .fetch_all(
                owned_task_ids_statement(TASKS_TABLE, false),
                (user_id, limit),
            )
            .await?
    };
    let ids = rows
        .iter()
        .map(|row: &MysqlRow| row.get_required::<i64>("id"))
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;
    Ok(OwnedTaskPage { total, ids })
}

/// `task_store.list_accessible_task_ids`: the distinct count plus one page of
/// the user's accessible (owned or approved-member) active task ids.
pub async fn accessible_task_id_page<M: brz_mysql::Mysql>(
    mysql: &M,
    user_id: i64,
    skip: i64,
    limit: i64,
) -> brz_mysql::MysqlResult<OwnedTaskPage> {
    use crate::task_store_statements::TASKS_TABLE;
    use crate::tasks_list::statements::{
        accessible_task_count_statement, accessible_task_ids_statement,
    };
    let entity_id = user_id.to_string();
    let totals = mysql
        .fetch_all(
            accessible_task_count_statement(TASKS_TABLE),
            (entity_id.as_str(), 1i8, user_id),
        )
        .await?;
    let total = totals
        .first()
        .map_or(Ok(0), |row: &MysqlRow| row.get_required::<i64>("count_1"))?;
    let rows = mysql
        .fetch_all(
            accessible_task_ids_statement(TASKS_TABLE),
            (entity_id.as_str(), 1i8, user_id, limit, skip),
        )
        .await?;
    let ids = rows
        .iter()
        .map(|row: &MysqlRow| row.get_required::<i64>("id"))
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;
    Ok(OwnedTaskPage { total, ids })
}

/// `task_store.list_group_task_ids_for_accessible_user`: the owned group chats
/// unioned with the approved-member task ids, first-seen order.
pub async fn accessible_group_task_ids<M: brz_mysql::Mysql>(
    mysql: &M,
    user_id: i64,
) -> brz_mysql::MysqlResult<Vec<i64>> {
    use crate::task_store_statements::{
        TASKS_TABLE, member_task_ids_statement, owned_group_chat_ids_statement,
    };
    // `_OWNED_GROUP_CHAT_SQL` then `_MEMBER_TASK_IDS_SQL`, unioned as sets; the
    // id list keeps a stable order so a caller can re-order or count it.
    let owned: Vec<MysqlRow> = mysql
        .fetch_all(owned_group_chat_ids_statement(TASKS_TABLE), (1i8, user_id))
        .await?;
    let members: Vec<MysqlRow> = mysql
        .fetch_all(
            member_task_ids_statement(TASKS_TABLE),
            (user_id.to_string(), 1i8),
        )
        .await?;
    let mut ids: Vec<i64> = Vec::new();
    for row in owned.iter().chain(members.iter()) {
        let id = row.get_required::<i64>("id")?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// `task_store.list_by_ids_ordered`: the caller-ordered page over `task_ids`.
pub async fn task_rows_by_ids_ordered<M: brz_mysql::Mysql>(
    mysql: &M,
    task_ids: &[i64],
    order_field: &str,
    descending: bool,
    skip: i64,
    limit: Option<i64>,
    exclude_deleted: bool,
) -> brz_mysql::MysqlResult<Vec<MysqlRow>> {
    use crate::task_store_statements::{StatementArg, TASKS_TABLE, tasks_by_ids_ordered_statement};
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = tasks_by_ids_ordered_statement(
        TASKS_TABLE,
        task_ids.len(),
        order_field,
        descending,
        exclude_deleted,
        skip > 0,
    );
    // Argument order follows the statement: the id list, then the page bounds
    // (the source binds `LIMIT` before `OFFSET`). A missing limit is the
    // SQLAlchemy unbounded sentinel: every row the page can hold.
    let mut args: Vec<StatementArg> = task_ids.iter().copied().map(StatementArg::Int).collect();
    args.push(StatementArg::Int(limit.unwrap_or(i64::MAX)));
    if skip > 0 {
        args.push(StatementArg::Int(skip));
    }
    mysql.fetch_all(sql, args).await
}

/// `subtask_store.list_by_task_ordered` for the single-table store, read from
/// `table`: the task's subtasks ordered `message_id`, `created_at`, with the
/// contexts left to the caller (the base store's default).
pub async fn ordered_subtasks_by_task<M: brz_mysql::Mysql>(
    mysql: &M,
    table: &str,
    task_id: i64,
) -> brz_mysql::MysqlResult<SubtaskListing> {
    let rows = mysql
        .fetch_all(
            crate::task_store_statements::subtasks_by_message_ordered_statement(table),
            (task_id,),
        )
        .await?;
    Ok(SubtaskListing {
        rows,
        contexts: None,
    })
}

#[cfg(test)]
#[path = "task_store_listing_tests.rs"]
mod tests;

/// [`ordered_subtasks_by_task`] on the caller's request transaction.
pub async fn ordered_subtasks_by_task_on(
    sql: &mut dyn crate::request_sql::RequestSql,
    table: &str,
    task_id: i64,
) -> brz_mysql::MysqlResult<SubtaskListing> {
    let rows = sql
        .fetch_all_rows(
            crate::request_sql::RouteKey::Task(task_id as u64),
            &crate::task_store_statements::subtasks_by_message_ordered_statement(table),
            vec![crate::task_store_statements::StatementArg::Int(task_id)],
        )
        .await?;
    Ok(SubtaskListing {
        rows,
        contexts: None,
    })
}
