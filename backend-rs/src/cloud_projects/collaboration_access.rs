//! The approved CP contract for migrated project reads.

use brz_mysql::{FromMysqlRow, Mysql, MysqlRow};
use serde_json::{Value, json};

use super::{
    CloudProjectBody, LOOP_ITEMS_COLUMNS, ProjectListRow, WorkspaceContext, role_for_priority,
};

#[derive(serde::Serialize)]
pub(super) struct CollaborativeProjectList {
    pub items: Vec<CollaborativeProject>,
}

#[derive(serde::Serialize)]
pub(super) struct CollaborativeProject {
    #[serde(flatten)]
    project: CloudProjectBody,
    membership_mode: String,
    workspace_access_role: Option<String>,
    permission_sources: Vec<Value>,
}

pub(super) fn access_sql(
    user_id: i32,
    project_id: Option<i64>,
    workspace_id: Option<i64>,
) -> String {
    let sql = include_str!("collaboration_access.sql")
        .replace("{columns}", LOOP_ITEMS_COLUMNS)
        .replace("{user_id}", &user_id.to_string())
        .replace(
            "{project_filter}",
            &project_id
                .map(|id| format!("AND loop_items.id = '{id}'"))
                .unwrap_or_default(),
        )
        .replace(
            "{workspace_filter}",
            &workspace_id
                .map(|id| format!("AND access.workspace_id = {id}"))
                .unwrap_or_default(),
        );
    format!("{sql} ORDER BY loop_items.updated_at DESC, loop_items.id")
}

pub(super) struct AuthorizedProject {
    pub project: ProjectListRow,
    pub priority: i64,
    pub workspace: WorkspaceContext,
    pub workspace_priority: Option<i64>,
    pub sources: Vec<Value>,
    pub public: bool,
}

impl AuthorizedProject {
    pub fn response(&self, user_id: i32, user_name: &str) -> CollaborativeProject {
        let project = super::response::project_response(
            &self.project,
            user_id,
            user_name,
            role_for_priority(self.priority).expect("access query restricts priority"),
            self.public.then_some("Viewer"),
            Some(&self.workspace),
        );
        CollaborativeProject {
            project,
            membership_mode: self
                .project
                .metadata
                .as_ref()
                .and_then(|m| m.0.value.as_ref())
                .and_then(|m| m.membership_mode.clone())
                .unwrap_or_else(|| "inherit".to_owned()),
            workspace_access_role: self
                .workspace_priority
                .and_then(role_for_priority)
                .map(str::to_owned),
            permission_sources: self.sources.clone(),
        }
    }
}

pub(super) async fn authorized_projects<M: Mysql>(
    mysql: &M,
    user_id: i32,
    project_id: Option<i64>,
    workspace_id: Option<i64>,
) -> Result<Vec<AuthorizedProject>, brz_mysql::MysqlError> {
    let rows: Vec<MysqlRow> = mysql
        .fetch_all(access_sql(user_id, project_id, workspace_id), ())
        .await?;
    rows.into_iter()
        .map(|row| {
            let workspace_id: i64 = row.get_required("workspace_id")?;
            let workspace = WorkspaceContext {
                id: workspace_id.to_string(),
                name: row.get_required("workspace_name")?,
                public_id: row
                    .get::<String>("workspace_public_id")?
                    .unwrap_or_default(),
            };
            let direct: Option<i64> = row.get("direct_priority")?;
            let inherited: Option<i64> = row.get("inherited_priority")?;
            let public: Option<i64> = row.get("public_priority")?;
            let mut sources = Vec::new();
            if let Some(role) = inherited.and_then(role_for_priority) {
                sources
                    .push(json!({"type": "workspace", "workspace_id": workspace.id, "role": role}));
            }
            if let Some(role) = direct.and_then(role_for_priority) {
                sources.push(json!({"type": "direct", "role": role}));
            }
            if sources.is_empty() && public.is_some() {
                sources.push(json!({"type": "public", "role": "Viewer"}));
            }
            let priority = row.get_required("anon_1_priority")?;
            let workspace_priority = row.get("workspace_priority")?;
            Ok(AuthorizedProject {
                project: ProjectListRow::from_mysql_row(row)?,
                priority,
                workspace,
                workspace_priority,
                sources,
                public: public.is_some(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_mysql::Json;

    #[tokio::test]
    async fn authorized_point_and_list_queries_keep_the_full_access_projection() {
        for (project_id, workspace_id) in [(Some(1001), None), (None, Some(2001))] {
            let mysql = crate::sql_test_support::KindQueryCapture::default();
            assert!(
                authorized_projects(&mysql, 52, project_id, workspace_id)
                    .await
                    .unwrap()
                    .is_empty()
            );
            let queries = mysql.queries();
            assert_eq!(queries.len(), 1);
            let sql = &queries[0].sql;
            for column in [
                "access.workspace_id",
                "access.workspace_name",
                "access.workspace_public_id",
                "access.workspace_priority",
                "access.direct_priority",
                "access.inherited_priority",
                "access.public_priority",
            ] {
                assert!(sql.contains(column), "missing access projection: {column}");
            }
            assert!(sql.contains("caller.id = 52 AND caller.is_active = true"));
            assert_eq!(
                sql.contains("AND loop_items.id = '1001'"),
                project_id.is_some()
            );
            assert_eq!(
                sql.contains("AND access.workspace_id = 2001"),
                workspace_id.is_some()
            );
        }
    }

    #[test]
    fn cp04_cp07_cp20_guest_response_keeps_parent_navigation_without_space_authority() {
        let access = AuthorizedProject {
            project: ProjectListRow {
                id: "1001".to_owned(),
                public_id: Some("project-public".to_owned()),
                project_key: Some("CP".to_owned()),
                name: Some("Guest project".to_owned()),
                description: None,
                created_by_user_id: 8,
                status: "active".to_owned(),
                version: 1,
                created_at: None,
                updated_at: None,
                metadata: Some(Json(json!({"membership_mode": "restricted"}).into())),
            },
            priority: 2,
            workspace: WorkspaceContext {
                id: "42".to_owned(),
                public_id: "parent-public".to_owned(),
                name: "Parent".to_owned(),
            },
            workspace_priority: None,
            sources: vec![json!({"type": "direct", "role": "Developer"})],
            public: true,
        };
        let body = serde_json::to_value(access.response(7, "guest")).unwrap();
        assert_eq!(body["access_role"], "Developer");
        assert_eq!(body["workspace_context"]["id"], "42");
        assert_eq!(body["workspace_access_role"], Value::Null);
        assert_eq!(body["membership_mode"], "restricted");
        assert_eq!(
            body["permission_sources"],
            json!([{"type": "direct", "role": "Developer"}])
        );
        assert_eq!(body["public_access"], json!({"role": "Viewer"}));
    }
}
