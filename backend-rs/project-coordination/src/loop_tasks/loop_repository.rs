// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed `loop_items` rows and the loop-item task-binding read path.
//!
//! Mirrors the single-table `LoopNode` mapping (`app.models.delivery`): the
//! `loop_items` table holds project (`resource_type='project'`), task
//! (`'task'`), and execution/binding (`'execution'`) rows.
use crate::board_snapshot::repository::ProjectRow as BoardProjectRow;
use crate::cloud_projects::{LOOP_ITEMS_COLUMNS, ProjectListRow, WORKSPACE_ID_COLUMN};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use wegent_devices::device_identity::owned_device_identity_ids;

use super::loop_columns::CLOUD_CONTEXT_COLUMNS;

mod entities;
#[cfg(test)]
use serde_json::Value;

/// Base role hierarchy (`app.schemas.base_role`); lower is more privileged.
fn role_level(role: &str) -> i32 {
    match role {
        "Owner" => 0,
        "Maintainer" => 1,
        "Developer" => 2,
        "Reporter" => 3,
        "Viewer" => 4,
        "RestrictedAnalyst" => 5,
        _ => 999,
    }
}

/// `has_permission`.
pub fn has_permission(user_role: &str, required_role: &str) -> bool {
    role_level(user_role) <= role_level(required_role)
}

/// Shared ordered assignment-event query for transactional and ordinary reads.
pub fn item_comments_query() -> String {
    ordered_comments_query(false)
}

fn ordered_comments_query(assignments_only: bool) -> String {
    let assignment_filter = if assignments_only {
        "AND JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, '$.event_type')) = 'assignment' "
    } else {
        ""
    };
    format!(
        "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.loop_item_id = ? \
                     AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                     AND loop_items.resource_type IN ('comment') \
                     {assignment_filter}\
                     ORDER BY loop_items.created_at, loop_items.id",
    )
}

/// `issue_assignment_service._assignment_comments(for_update=False)`: the
/// shared read form every `active_for_issues` caller uses. SQLAlchemy renders
/// the item ids as inlined quoted literals in an `IN (...)` list and the
/// `event_type` JSON access through the `CASE ... WHEN 'null'` coalesce form.
pub fn assignment_comments_query(item_ids: &[String]) -> String {
    let quoted = item_ids
        .iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.loop_item_id IN ({quoted}) \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
             ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND CASE JSON_EXTRACT(loop_items.metadata, '$.\\\"event_type\\\"') \
         WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, \
         '$.\\\"event_type\\\"')) END = 'assignment' \
         AND loop_items.resource_type IN ('comment') \
         ORDER BY loop_items.created_at, loop_items.id"
    )
}

/// Loop-item repositories for the task-binding read path.
pub struct LoopItemRepository<'a, M> {
    mysql: &'a M,
}

/// `visible_item_filter(user_id, project)` (`app.services.loop_items.access`)
/// rendered exactly as SQLAlchemy emits it for the task-list query: the
/// `security_level` JSON path through the `CASE ... WHEN 'null'` coalesce
/// form, and the single-table-inheritance subqueries over `loop_items` with
/// their `resource_type` guards (execution bindings, collaborator rows, and
/// owned chat agents).
pub fn visible_item_filter_sql(user_id: i32, default_security: &str) -> String {
    let related = related_item_predicate_sql(user_id);
    // SQLAlchemy emits the JSON path through a bound-ish string literal whose
    // embedded double quotes are backslash-escaped: `'$.\"security_level\"'`.
    format!(
        " AND (coalesce(CASE JSON_EXTRACT(loop_items.metadata, '$.\\\"security_level\\\"') \
         WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, \
         '$.\\\"security_level\\\"')) END, '{default_security}') = 'open' OR {related})"
    )
}

/// The five related-item branches share the current single-table schema.
pub async fn is_related_item_on(
    query: &mut impl wegent_backend_persistence::mysql_query::MysqlQuery,
    item_id: &str,
    user_id: i32,
) -> MysqlResult<bool> {
    #[derive(Debug, FromMysqlRow)]
    struct ExistsRow {
        #[mysql(rename = "loop_items_id")]
        #[allow(dead_code, reason = "presence-only probe")]
        id: String,
    }
    let row: Option<ExistsRow> = query
        .fetch_optional(
            &format!(
                "SELECT loop_items.id AS loop_items_id FROM loop_items \
                     WHERE loop_items.id = ? AND ({}) \
                     AND loop_items.resource_type IN ('task') LIMIT 1",
                related_item_predicate_sql(user_id),
            ),
            (item_id,),
        )
        .await?;
    Ok(row.is_some())
}

fn related_item_predicate_sql(user_id: i32) -> String {
    format!(
        "loop_items.created_by_user_id = {user_id} \
         OR loop_items.assignee_user_id = {user_id} \
         OR loop_items.id IN (SELECT loop_items.loop_item_id \n\
         FROM loop_items \n\
         WHERE loop_items.task_user_id = {user_id} \
         AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN \
         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND loop_items.resource_type IN ('execution')) \
         OR loop_items.id IN (SELECT loop_items.loop_item_id \n\
         FROM loop_items \n\
         WHERE loop_items.user_id = {user_id} \
         AND loop_items.resource_type IN ('collaborator')) \
         OR loop_items.assignee_agent_id IN (SELECT loop_items.id \n\
         FROM loop_items \n\
         WHERE loop_items.created_by_user_id = {user_id} \
         AND loop_items.status = 'active' \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND loop_items.resource_type IN ('chat_agent'))"
    )
}

impl<'a, M: Mysql> LoopItemRepository<'a, M> {
    pub fn new(mysql: &'a M) -> Self {
        Self { mysql }
    }

    /// `ExternalLoopItemProvider._find_project`: resolve `KEY-number` ids to
    /// an external-provider project row. Returns `Ok(None)` when the id does
    /// not parse or the project is not github/gitlab backed.
    pub async fn find_external_project(
        &self,
        item_id: &str,
    ) -> MysqlResult<Option<BoardProjectRow>> {
        let Some((key, number)) = split_external_item_id(item_id) else {
            return Ok(None);
        };
        let _ = number;
        // `db.query(CloudProject).filter(CloudProject.project_key == key)`
        // renders the full labeled projection, not a narrowed column list.
        let project: Option<BoardProjectRow> = self
            .mysql
            .fetch_optional(
                &format!(
                    "SELECT {WORKSPACE_ID_COLUMN}, {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.project_key = ? \n\
                     AND loop_items.resource_type IN ('project') \n LIMIT 1",
                ),
                (key,),
            )
            .await?;
        Ok(match project {
            Some(project) if matches!(project.task_provider().as_str(), "github" | "gitlab") => {
                Some(project)
            }
            _ => None,
        })
    }

    /// Caller-owned active bindings for the item,
    /// newest first, selected with the source's labeled `loop_items`
    /// projection. The recorded contract filters `resource_type='execution'`
    /// bindings whose `unlinked_at` is unset; it does not filter
    /// `deleted_at`, so the statement stays compatible with the recorded
    /// exchange.
    pub async fn list_task_bindings(
        &self,
        item_id: &str,
        user_id: i32,
    ) -> MysqlResult<Vec<BindingRow>> {
        self.mysql
            .fetch_all(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.loop_item_id = ? AND loop_items.task_user_id = ? \
                     AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN \
                         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                     AND loop_items.resource_type IN ('execution') \
                     ORDER BY loop_items.linked_at DESC, loop_items.id DESC",
                ),
                (item_id, user_id),
            )
            .await
    }

    /// `LoopItemService.find_cloud_context`: the active runtime-task binding
    /// for `(task_user_id, owned device identity, task_id)`. `Ok(None)` maps to the
    /// `Cloud context not found` 404.
    ///
    /// The projection mirrors the source SQLAlchemy `db.query(LoopItemTaskBinding)`
    /// labeled column list exactly (all 60 mapped `loop_items` columns, aliased
    /// `loop_items_<column>`), so the prepared statement matches the recorded
    /// exchange for replay. The typed row consumes only the binding fields;
    /// its `#[mysql(rename = ...)]` attributes map the labeled columns back to
    /// the row fields.
    pub async fn find_cloud_context_binding(
        &self,
        user_id: i32,
        device_id: &str,
        task_id: &str,
    ) -> MysqlResult<Option<CloudContextBindingRow>> {
        let device_ids =
            owned_device_identity_ids(self.mysql, i64::from(user_id), device_id).await?;
        let (sql, args) = cloud_context_binding_statement(user_id, &device_ids, task_id);
        self.mysql.fetch_optional(sql, args).await
    }

    /// `_attach_badges`: `db.query(LoopItem.id, LoopItem.metadata_json)
    /// .filter(LoopItem.id.in_(ids))` reduced to `id -> raw metadata`. The
    /// ids are rendered as quoted literals, like SQLAlchemy's bound list.
    pub async fn item_metadata_for_ids(
        &self,
        item_ids: &[String],
    ) -> MysqlResult<std::collections::HashMap<String, Option<serde_json::Value>>> {
        if item_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        #[derive(Debug, FromMysqlRow)]
        struct ItemMetadataRow {
            #[mysql(rename = "loop_items_id")]
            id: String,
            #[mysql(rename = "loop_items_metadata")]
            metadata: Option<Json<serde_json::Value>>,
        }
        let quoted = item_ids
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(", ");
        let rows: Vec<ItemMetadataRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT loop_items.id AS loop_items_id, loop_items.metadata AS \
                     loop_items_metadata \nFROM loop_items \nWHERE loop_items.id IN ({quoted})",
                ),
                (),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| (row.id, row.metadata.map(|json| json.0)))
            .collect())
    }

    /// `loop_item_service.list`: the active task rows of one project, ordered
    /// by `sort_order, updated_at DESC`. The recorded COM_QUERY inlines the
    /// numeric `cloud_project_id`. When the caller lacks `Maintainer`, the
    /// source adds the `visible_item_filter`; `default_security` is the
    /// project's `default_issue_security`.
    pub async fn list_project_task_items(
        &self,
        project_id: &str,
        user_id: i32,
        visible_filter: Option<&str>,
    ) -> MysqlResult<Vec<TaskItemFullRow>> {
        let visibility = match visible_filter {
            Some(default_security) => visible_item_filter_sql(user_id, default_security),
            None => String::new(),
        };
        self.mysql
            .fetch_all(
                &format!(
                    "SELECT {CLOUD_CONTEXT_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.cloud_project_id = '{project_id}' \
                     AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')){visibility} \
                     AND loop_items.resource_type IN ('task') \
                     ORDER BY loop_items.sort_order, loop_items.updated_at DESC, loop_items.id",
                ),
                (),
            )
            .await
    }

    /// `db.get(CloudProject, binding.cloud_project_id)` (`find_cloud_context`):
    /// the bound project row. SQLAlchemy renders the string primary key as a
    /// quoted literal with the polymorphic `resource_type` filter and no
    /// `status`/`LIMIT` clause, so the statement matches the recorded
    /// `db.get` exchange (the `access_project` helper renders a different
    /// statement and does not match here).
    pub async fn get_cloud_project(&self, project_id: &str) -> MysqlResult<Option<ProjectListRow>> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.id = '{project_id}' \
                     AND loop_items.resource_type IN ('project')",
                ),
                (),
            )
            .await
    }

    /// `_latest_executions(db, item_ids)` (`app/services/loop_items/
    /// read_context.py`): the newest execution row per item through the
    /// `IN (SELECT max(id) ... GROUP BY loop_item_id)` subquery the source
    /// renders. Item ids are inlined as quoted literals in `IN (...)` order.
    pub async fn latest_executions_for_items(
        &self,
        item_ids: &[String],
    ) -> MysqlResult<std::collections::HashMap<String, ExecutionFullRow>> {
        if item_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let quoted = item_ids
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(", ");
        let rows: Vec<ExecutionFullRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
                     WHERE loop_item_executions.id IN (SELECT max(loop_item_executions.id) \
                     AS max_1 \nFROM loop_item_executions \n\
                     WHERE loop_item_executions.loop_item_id IN ({quoted}) \
                     GROUP BY loop_item_executions.loop_item_id)"
                ),
                (),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| (row.loop_item_id.clone().unwrap_or_default(), row))
            .collect())
    }

    /// `LoopItemReadContext.load`'s `db.query(User).filter(User.id.in_(user_ids))`
    /// (`app/services/loop_items/read_context.py:50-54`): one labeled batch read
    /// supplies every assignee and creator name for the page. Ids render as
    /// inlined integer literals in `IN (...)` order.
    pub async fn user_names_for_ids(
        &self,
        user_ids: &[i32],
    ) -> MysqlResult<std::collections::HashMap<i32, String>> {
        if user_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let listed = user_ids
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        #[derive(Debug, FromMysqlRow)]
        struct UserNameRow {
            #[mysql(rename = "users_id")]
            id: i32,
            #[mysql(rename = "users_user_name")]
            user_name: String,
        }
        let rows: Vec<UserNameRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT users.id AS users_id, users.user_name AS users_user_name, \
                     users.password_hash AS users_password_hash, \
                     users.email AS users_email, users.git_info AS users_git_info, \
                     users.is_active AS users_is_active, users.`role` AS users_role, \
                     users.auth_source AS users_auth_source, \
                     users.preferences AS users_preferences, \
                     users.created_at AS users_created_at, \
                     users.updated_at AS users_updated_at \n\
                     FROM users \nWHERE users.id IN ({listed})"
                ),
                (),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| (row.id, row.user_name))
            .collect())
    }

    /// `LoopItemReadContext.load`'s `db.query(ProjectChatAgent)
    /// .filter(ProjectChatAgent.id.in_(agent_ids))`
    /// (`app/services/loop_items/read_context.py:58-67`): one labeled batch read
    /// of the assignee and execution agents named by the page.
    pub async fn chat_agents_for_ids(
        &self,
        agent_ids: &[String],
    ) -> MysqlResult<std::collections::HashMap<String, ChatAgentRow>> {
        if agent_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let quoted = agent_ids
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(", ");
        #[derive(Debug, FromMysqlRow)]
        struct LabeledAgentRow {
            #[mysql(rename = "loop_items_id")]
            id: String,
            #[mysql(rename = "loop_items_name")]
            name: Option<String>,
            #[mysql(rename = "loop_items_title")]
            title: Option<String>,
            #[mysql(rename = "loop_items_created_by_user_id")]
            created_by_user_id: Option<i32>,
        }
        let rows: Vec<LabeledAgentRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                     WHERE loop_items.id IN ({quoted}) \
                     AND loop_items.resource_type IN ('chat_agent')"
                ),
                (),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                (
                    row.id.clone(),
                    ChatAgentRow {
                        id: row.id,
                        name: row.name,
                        title: row.title,
                        created_by_user_id: row.created_by_user_id,
                    },
                )
            })
            .collect())
    }

    /// `LoopItemReadContext.load`'s `db.query(Kind).filter(Kind.id.in_(team_ids))`
    /// (`app/services/loop_items/read_context.py:68-75`): one labeled batch read
    /// of the assignee and execution teams.
    pub async fn team_names_for_ids(
        &self,
        team_ids: &[i64],
    ) -> MysqlResult<std::collections::HashMap<i64, String>> {
        if team_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let listed = team_ids
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        #[derive(Debug, FromMysqlRow)]
        struct TeamNameRow {
            #[mysql(rename = "kinds_id")]
            id: i64,
            #[mysql(rename = "kinds_name")]
            name: Option<String>,
        }
        let rows: Vec<TeamNameRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                     kinds.is_active AS kinds_is_active, \
                     kinds.created_at AS kinds_created_at, \
                     kinds.updated_at AS kinds_updated_at \n\
                     FROM kinds \nWHERE kinds.id IN ({listed})"
                ),
                (),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| (row.id, row.name.unwrap_or_default()))
            .collect())
    }

    /// `LoopItemReadContext._messages` (`app/services/loop_items/
    /// read_context.py:118-143`): one labeled batch read of the cached task
    /// messages named by each item's `ai_state.project_chat_message_id`.
    pub async fn messages_for_items(
        &self,
        pairs: &[(String, String)],
    ) -> MysqlResult<std::collections::HashMap<(String, String), ProjectChatMessageRow>> {
        if pairs.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let tasks: Vec<String> = {
            let mut seen = Vec::new();
            for (task, _) in pairs {
                if !seen.contains(task) {
                    seen.push(task.clone());
                }
            }
            seen
        };
        let messages: Vec<String> = {
            let mut seen = Vec::new();
            for (_, message) in pairs {
                if !seen.contains(message) {
                    seen.push(message.clone());
                }
            }
            seen
        };
        let quote = |values: &[String]| {
            values
                .iter()
                .map(|value| format!("'{value}'"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        #[derive(Debug, FromMysqlRow)]
        struct MessageRow {
            #[mysql(rename = "project_chat_messages_task_id")]
            task_id: String,
            #[mysql(rename = "project_chat_messages_message_id")]
            message_id: String,
            #[mysql(rename = "project_chat_messages_status")]
            status: String,
            #[mysql(rename = "project_chat_messages_content")]
            content: Option<String>,
            #[mysql(rename = "project_chat_messages_updated_at")]
            updated_at: Option<NaiveDateTime>,
        }
        let rows: Vec<MessageRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT project_chat_messages.id AS project_chat_messages_id, \
                     project_chat_messages.message_id AS project_chat_messages_message_id, \
                     project_chat_messages.task_id AS project_chat_messages_task_id, \
                     project_chat_messages.status AS project_chat_messages_status, \
                     project_chat_messages.content AS project_chat_messages_content, \
                     project_chat_messages.updated_at AS project_chat_messages_updated_at \n\
                     FROM project_chat_messages \n\
                     WHERE project_chat_messages.task_id IN ({}) \
                     AND project_chat_messages.message_id IN ({}) \
                     AND (project_chat_messages.deleted_at IS NULL OR \
                         project_chat_messages.deleted_at IN \
                         ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))",
                    quote(&tasks),
                    quote(&messages)
                ),
                (),
            )
            .await?;
        let wanted: std::collections::HashSet<(String, String)> = pairs.iter().cloned().collect();
        Ok(rows
            .into_iter()
            .filter(|row| wanted.contains(&(row.task_id.clone(), row.message_id.clone())))
            .map(|row| {
                (
                    (row.task_id, row.message_id),
                    ProjectChatMessageRow {
                        status: row.status,
                        content: row.content,
                        updated_at: row.updated_at,
                    },
                )
            })
            .collect())
    }
}

#[path = "loop_repository_reads.rs"]
mod loop_repository_reads;

#[path = "loop_repository_reads2.rs"]
mod loop_repository_reads2;

#[path = "loop_repository_rows.rs"]
mod loop_repository_rows;
#[cfg(test)]
pub use crate::sql_support::StatementArg;
pub use loop_repository_rows::cloud_context_binding_statement;
pub use loop_repository_rows::*;

#[cfg(test)]
mod visible_filter_tests {
    use super::visible_item_filter_sql;

    #[test]
    fn visible_item_filter_matches_the_recorded_rendering() {
        let rendered = visible_item_filter_sql(86, "open");
        // The recorded statement's filter fragment (case 30e04068, user 86).
        let expected = " AND (coalesce(CASE JSON_EXTRACT(loop_items.metadata, '$.\\\"security_level\\\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, '$.\\\"security_level\\\"')) END, 'open') = 'open' OR loop_items.created_by_user_id = 86 OR loop_items.assignee_user_id = 86 OR loop_items.id IN (SELECT loop_items.loop_item_id \nFROM loop_items \nWHERE loop_items.task_user_id = 86 AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) AND loop_items.resource_type IN ('execution')) OR loop_items.id IN (SELECT loop_items.loop_item_id \nFROM loop_items \nWHERE loop_items.user_id = 86 AND loop_items.resource_type IN ('collaborator')) OR loop_items.assignee_agent_id IN (SELECT loop_items.id \nFROM loop_items \nWHERE loop_items.created_by_user_id = 86 AND loop_items.status = 'active' AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) AND loop_items.resource_type IN ('chat_agent')))";
        let normalize = |s: &str| re_whitespace(s);
        fn re_whitespace(s: &str) -> String {
            s.split_whitespace().collect::<Vec<_>>().join(" ")
        }
        assert_eq!(normalize(&rendered), normalize(expected));
        assert!(rendered.contains("$.\\\"security_level\\\""));
        assert!(
            rendered.contains(
                "loop_items.user_id = 86 AND loop_items.resource_type IN ('collaborator')"
            )
        );
    }
}

#[cfg(test)]
#[path = "loop_repository_tests.rs"]
mod tests;
