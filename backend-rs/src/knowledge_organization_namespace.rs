// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge-bases/organization-namespace` — the name of the active
//! organization-level namespace.
//!
//! Mirrors `app.api.endpoints.knowledge.get_organization_namespace` (mounted at
//! the `/knowledge-bases` prefix):
//!
//! 1. `security.get_current_user` — resolve the session user;
//! 2. `db.query(Namespace).filter(Namespace.level == "organization",
//!    Namespace.is_active == True).first()` — the first active
//!    organization-level namespace;
//! 3. render `{"namespace": <name or null>}`.
//!
//! The route is a literal sibling of the
//! `GET /api/knowledge-bases/{knowledge_base_id}` template; the more specific
//! literal route wins dispatch inside the Rust router.
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

/// `namespace` columns as rendered by `db.query(Namespace)`; every column is
/// selected to match the recorded exchange even though only the name is used.
const NAMESPACE_COLUMNS: &str = "namespace.id AS namespace_id, \
     namespace.name AS namespace_name, namespace.display_name AS namespace_display_name, \
     namespace.owner_user_id AS namespace_owner_user_id, \
     namespace.visibility AS namespace_visibility, \
     namespace.description AS namespace_description, namespace.level AS namespace_level, \
     namespace.is_active AS namespace_is_active, \
     namespace.created_at AS namespace_created_at, \
     namespace.updated_at AS namespace_updated_at";

/// The projection of one `namespace` row; only `name` is consumed.
#[derive(Debug, FromMysqlRow)]
struct NamespaceRow {
    namespace_name: String,
}

/// `{"namespace": str | None}` — the endpoint's response body.
#[derive(Debug, serde::Serialize)]
struct OrganizationNamespaceResponse {
    namespace: Option<String>,
}

/// The source `db.query(Namespace).filter(level == "organization",
/// is_active == True).first()` statement.
async fn organization_namespace<M>(mysql: &M) -> MysqlResult<Option<NamespaceRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            format!(
                "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \n\
                 WHERE namespace.level = 'organization' AND namespace.is_active = true \
                 \n LIMIT 1"
            )
            .as_str(),
            (),
        )
        .await
}

/// GET /api/knowledge-bases/organization-namespace: the knowledge-bases free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/knowledge-bases/organization-namespace")]
async fn get_organization_namespace(
    #[inject(state)] state: &AppState,
    #[auth] _current_user: SessionUser,
) -> Result<OrganizationNamespaceResponse, FastApiError> {
    organization_namespace_response(&state.mysql).await
}

/// Handler body for `GET /api/knowledge-bases/organization-namespace`.
async fn organization_namespace_response<M>(
    mysql: &M,
) -> Result<OrganizationNamespaceResponse, FastApiError>
where
    M: Mysql,
{
    let row = organization_namespace(mysql).await.map_err(|error| {
        tracing::error!(%error, "knowledge-bases/organization-namespace dependency failure");
        FastApiError::unhandled()
    })?;
    Ok(OrganizationNamespaceResponse {
        namespace: row.map(|row| row.namespace_name),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    /// An absent organization namespace renders `{"namespace": null}` from the
    /// source `first()` returning `None`.
    #[tokio::test]
    async fn absent_organization_namespace_renders_null() {
        let mysql = KindQueryCapture::default();
        let response = organization_namespace_response(&mysql).await.unwrap();
        assert!(response.namespace.is_none());

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("FROM namespace"));
        assert!(
            queries[0]
                .sql
                .contains("WHERE namespace.level = 'organization' AND namespace.is_active = true")
        );
        assert!(queries[0].sql.contains("LIMIT 1"));
        assert_eq!(queries[0].args, 0);
    }

    /// The response is the single `namespace` key, holding the row name.
    #[test]
    fn response_serializes_as_the_namespace_key() {
        let rendered = crate::json_contract_tests::serialized(OrganizationNamespaceResponse {
            namespace: Some("example-org".to_string()),
        })
        .unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["namespace"]);
        assert_eq!(rendered["namespace"], "example-org");

        let rendered = crate::json_contract_tests::serialized(OrganizationNamespaceResponse {
            namespace: None,
        })
        .unwrap();
        assert!(rendered["namespace"].is_null());
    }
}
