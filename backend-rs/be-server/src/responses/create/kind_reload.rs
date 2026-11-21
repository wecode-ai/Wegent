// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The Kind row an expired session instance re-reads after a commit.
//!
//! `prepare_execution_session` ends with `db.commit()`
//! (`app/services/chat/trigger/lifecycle.py:421`), which expires every instance
//! in the request session. The first use of an expired Kind afterwards — the
//! Team passed into `build_execution_request` (`openapi_responses.py:795-799`)
//! — makes the ORM re-select the row by primary key, unaliased and without a
//! `LIMIT` (`Session._load_expired` → `loading.load_on_pk_identity`).
use brz_mysql::{FromMysqlRow, Json};

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::resolution::KindRow;

/// `Session._load_expired` for a Kind instance: the primary-key re-select with
/// the unaliased projection and no `LIMIT` (recorded `SELECT kinds.id,
/// kinds.user_id, … FROM kinds WHERE kinds.id = ?`).
pub fn kind_entity_by_id_statement() -> String {
    format!("SELECT {KIND_ENTITY_COLUMNS} \nFROM kinds \nWHERE kinds.id = ?")
}

/// `kinds` columns as the ORM identity-map refresh renders them: unaliased, in
/// mapper order.
const KIND_ENTITY_COLUMNS: &str = "kinds.id, kinds.user_id, kinds.kind, kinds.name, \
     kinds.namespace, kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at";

/// One `kinds` row decoded from [`KIND_ENTITY_COLUMNS`].
#[derive(Debug, FromMysqlRow)]
pub struct KindEntityRow {
    #[mysql(rename = "id")]
    pub id: i64,
    #[mysql(rename = "user_id")]
    pub user_id: i64,
    #[mysql(rename = "kind")]
    pub kind: String,
    #[mysql(rename = "name")]
    pub name: String,
    #[mysql(rename = "namespace")]
    pub namespace: String,
    #[mysql(rename = "json")]
    pub json: Json<serde_json::Value>,
    #[mysql(rename = "is_active")]
    pub is_active: i8,
    #[mysql(rename = "created_at")]
    pub created_at: Option<chrono::NaiveDateTime>,
    #[mysql(rename = "updated_at")]
    pub updated_at: Option<chrono::NaiveDateTime>,
}

impl From<KindEntityRow> for KindRow {
    fn from(row: KindEntityRow) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            kind: row.kind,
            name: row.name,
            namespace: row.namespace,
            json: row.json,
            is_active: row.is_active,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// `Session._load_expired` for the Team Kind: the expired instance is
/// re-selected by primary key at its first post-commit use. A missing row is
/// the source's `ObjectDeletedError`, which FastAPI renders as a 500.
pub async fn reload_team(state: &AppState, team: &KindRow) -> Result<KindRow, FastApiError> {
    let row: Option<KindEntityRow> = state
        .mysql
        .fetch_optional(kind_entity_by_id_statement(), (team.id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, "responses team reload failed");
            FastApiError::internal()
        })?;
    let Some(row) = row else {
        tracing::error!("responses team reload found no row");
        return Err(FastApiError::internal());
    };
    Ok(row.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// Recorded (`db.refresh(team)` after the setup commit): the ORM re-selects
    /// the row by primary key with the unaliased projection and no `LIMIT`.
    #[test]
    fn kind_entity_reload_matches_the_recorded_refresh() {
        let sql = normalize(&kind_entity_by_id_statement());
        assert!(sql.starts_with(
            "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, \
             kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at"
        ));
        assert!(sql.ends_with("FROM kinds WHERE kinds.id = ?"));
        assert!(!sql.contains(" AS "));
        assert!(!sql.to_uppercase().contains("LIMIT"));
    }

    #[test]
    fn the_unaliased_row_maps_onto_the_kind_row() {
        let row = KindEntityRow {
            id: 302292,
            user_id: 1250,
            kind: "Team".to_string(),
            name: "team".to_string(),
            namespace: "lbs-group1".to_string(),
            json: Json(serde_json::json!({"kind": "Team"})),
            is_active: 1,
            created_at: None,
            updated_at: None,
        };
        let kind: KindRow = row.into();
        assert_eq!(kind.id, 302292);
        assert_eq!(kind.namespace, "lbs-group1");
        assert_eq!(kind.json.0["kind"], "Team");
    }
}
