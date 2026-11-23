// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Recent-team picker statements: the owner's recent non-group tasks.

use super::quote_sql_literal;

/// `recent_owner_only_query`'s `mode` restriction
/// (`func.coalesce(func.nullif(<taskType>, ""), "chat") == mode`).
///
/// `<taskType>` is SQLAlchemy's JSON string extract, rendered as `CASE
/// JSON_EXTRACT(...) WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(...) END`: a
/// missing label stays SQL `NULL`, an empty label collapses to `chat`, and the
/// validated `RecentTeamMode` literal only appears on the comparison side,
/// exactly as the source's `COM_QUERY` renders it.
pub fn recent_team_mode_predicate(table: &str, mode: &str) -> String {
    let mode = quote_sql_literal(mode);
    let task_type = format!("JSON_EXTRACT({table}.json, '$.\"metadata\".\"labels\".\"taskType\"')");
    format!(
        " AND coalesce(nullif(CASE {task_type} WHEN 'null' THEN NULL \
         ELSE JSON_UNQUOTE({task_type}) END, ''), 'chat') = {mode}"
    )
}

/// `task_store.list_recent_task_team_refs` (`recent_team_refs.py`): the owner's
/// recent non-group tasks carrying no approved member, projected to the two
/// JSON extracts SQLAlchemy labels `anon_1` (`metadata.labels.taskType`) and
/// `anon_2` (`spec.teamRef`), ordered `updated_at DESC, id DESC`, limited to one
/// page. `mode` restricts the task-type label before the page limit, exactly as
/// [`recent_team_mode_predicate`] renders it.
///
/// The single-table store reads the base `tasks` table for this picker and
/// selects only the two extracts, so the projection keeps SQLAlchemy's
/// unquoted `JSON_EXTRACT` rendering (the extract's table and column are
/// unquoted while each path segment is double-quoted). Parameters bind in
/// source order: the owner id, then the page size.
pub fn recent_task_team_refs_statement(table: &str, mode: Option<&str>) -> String {
    let mode = mode
        .map(|mode| recent_team_mode_predicate(table, mode))
        .unwrap_or_default();
    format!(
        "SELECT JSON_EXTRACT({table}.json, '$.\"metadata\".\"labels\".\"taskType\"') AS anon_1, \
         JSON_EXTRACT({table}.json, '$.\"spec\".\"teamRef\"') AS anon_2 \nFROM {table} \n\
         WHERE {table}.kind = 'Task' AND {table}.user_id = ? AND {table}.is_active = 1 \
         AND {table}.is_group_chat IS false \
         AND NOT (EXISTS (SELECT * \nFROM resource_members \n\
         WHERE resource_members.resource_type = 'Task' \
         AND resource_members.resource_id = {table}.id \
         AND resource_members.status = 'approved')){mode} \
         ORDER BY {table}.updated_at DESC, {table}.id DESC \n LIMIT ?"
    )
}
