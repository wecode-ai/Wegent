// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Workspace repository fields used by the subscription list.
//!
//! The standalone backend reads active Workspace resources from the base
//! `tasks` table. Deployments with a different task store may supply another
//! [`WorkspaceRepository`] without changing the subscription conversion.
use std::collections::HashMap;

use async_trait::async_trait;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlService};
use serde_json::{Value, json};

/// Repository fields extracted from a Workspace resource.
#[derive(Debug, Default, Clone)]
pub struct RepoFields {
    pub git_repo: Option<String>,
    pub git_repo_id: Option<i64>,
    pub git_domain: Option<String>,
    pub branch_name: Option<String>,
}

/// Application-selected lookup for active Workspace resources.
#[async_trait]
pub trait WorkspaceRepository: Send + Sync {
    async fn fetch_repo_fields(
        &self,
        mysql: &MysqlService,
        workspace_ids: &[i64],
    ) -> Result<HashMap<i64, RepoFields>, brz_mysql::MysqlError>;
}

/// Standalone repository backed by the ordinary `tasks` table.
pub struct BaseWorkspaceRepository;

#[async_trait]
impl WorkspaceRepository for BaseWorkspaceRepository {
    async fn fetch_repo_fields(
        &self,
        mysql: &MysqlService,
        workspace_ids: &[i64],
    ) -> Result<HashMap<i64, RepoFields>, brz_mysql::MysqlError> {
        let rows = query_workspace_rows(mysql, "tasks", workspace_ids).await?;
        Ok(rows
            .into_iter()
            .map(|(id, document)| (id, extract_repo_fields(&document)))
            .collect())
    }
}

/// Load active Workspace rows from a caller-selected task table.
///
/// # Errors
///
/// Returns a database error if the Workspace query fails.
pub async fn query_workspace_rows<M: Mysql>(
    mysql: &M,
    table: &str,
    ids: &[i64],
) -> Result<Vec<(i64, Value)>, brz_mysql::MysqlError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = format!(
        "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, \
         updated_at, project_id, client_origin, is_group_chat \
         FROM {table} \
         WHERE id IN ({placeholders}) AND kind = 'Workspace' AND is_active = 1"
    );
    let rows: Vec<WorkspaceRow> = mysql.fetch_all(sql, ids.to_vec()).await?;
    Ok(rows.into_iter().map(|row| (row.id, row.json.0)).collect())
}

#[derive(Debug, FromMysqlRow)]
struct WorkspaceRow {
    id: i64,
    #[allow(dead_code)]
    user_id: i64,
    json: Json<Value>,
}

/// Extract repository fields from a Workspace CRD document.
pub fn extract_repo_fields(document: &Value) -> RepoFields {
    let repository = document
        .get("spec")
        .and_then(|spec| spec.get("repository"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let field = |name: &str| -> Option<String> {
        repository
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let git_repo_id = repository.get("gitRepoId").and_then(Value::as_i64);
    RepoFields {
        git_repo: field("gitRepo"),
        git_repo_id,
        git_domain: field("gitDomain"),
        branch_name: field("branchName"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn base_table_lookup_uses_public_task_store() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let rows = query_workspace_rows(&mysql, "tasks", &[12, 34])
            .await
            .unwrap();
        assert!(rows.is_empty());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM tasks WHERE id IN (?, ?)"));
        assert!(
            queries[0]
                .sql
                .contains("kind = 'Workspace' AND is_active = 1")
        );
        assert_eq!(queries[0].args, 2);
    }
}
