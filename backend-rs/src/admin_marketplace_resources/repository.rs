// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MySQL access for `GET /api/admin/marketplace-resources`.
//!
//! Every statement mirrors the SQL the source SQLAlchemy session renders (and
//! the recording captured as text `COM_QUERY`), so the projected columns,
//! aliases, join order and filters stay identical. The two request-selected
//! values (`kinds.kind` and `marketplace_resources.resource_type`) are both
//! constrained by the endpoint's `^(agent|skill)$` pattern, so they render as
//! inline literals like the source.

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

use crate::json_compat::JsonProjection;

use super::models::KindPayload;

/// The `kinds` column projection rendered by `db.query(Kind)` (SQLAlchemy
/// labels every column `kinds_<name>`).
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS \
     kinds_created_at, kinds.updated_at AS kinds_updated_at";

/// One system `kinds` row (`Kind.user_id == 0`, `is_active IS true`). Only the
/// members the projection reads are declared; the remaining selected columns
/// stay in the statement to match the recorded exchange.
#[derive(Debug, FromMysqlRow)]
pub struct SystemRow {
    pub kinds_id: i64,
    pub kinds_user_id: i64,
    pub kinds_kind: String,
    pub kinds_name: String,
    kinds_json: Option<Json<JsonProjection<KindPayload>>>,
    pub kinds_updated_at: NaiveDateTime,
}

/// One published row: the `kinds` columns plus the publisher name and the
/// stored recommendation score.
#[derive(Debug, FromMysqlRow)]
pub struct PublishedRow {
    pub kinds_id: i64,
    pub kinds_user_id: i64,
    pub kinds_kind: String,
    pub kinds_name: String,
    kinds_json: Option<Json<JsonProjection<KindPayload>>>,
    pub kinds_updated_at: NaiveDateTime,
    pub users_user_name: Option<String>,
    pub marketplace_resources_recommendation_score: i64,
}

/// The projected `kinds.json` payload of a row, absent when the column is NULL
/// or is valid JSON of another shape.
pub trait PayloadRow {
    fn payload(&self) -> Option<&KindPayload>;
}

impl PayloadRow for SystemRow {
    fn payload(&self) -> Option<&KindPayload> {
        self.kinds_json
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
    }
}

impl PayloadRow for PublishedRow {
    fn payload(&self) -> Option<&KindPayload> {
        self.kinds_json
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
    }
}

/// `db.query(Kind).filter(user_id == 0, kind == kind, is_active IS true).all()`.
pub async fn fetch_system_rows<M: Mysql>(mysql: &M, kind: &str) -> MysqlResult<Vec<SystemRow>> {
    mysql.fetch_all(system_rows_sql(kind), ()).await
}

/// `db.query(Kind, User.user_name, MarketplaceResource.recommendation_score)`
/// joined through `marketplace_resources` and `users`.
pub async fn fetch_published_rows<M: Mysql>(
    mysql: &M,
    kind: &str,
    resource_type: &str,
) -> MysqlResult<Vec<PublishedRow>> {
    mysql
        .fetch_all(published_rows_sql(kind, resource_type), ())
        .await
}

/// The system-scan statement the source session renders.
#[must_use]
pub fn system_rows_sql(kind: &str) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \n\
         FROM kinds \n\
         WHERE kinds.user_id = 0 AND kinds.kind = '{kind}' AND kinds.is_active IS true"
    )
}

/// The published-scan statement the source session renders.
#[must_use]
pub fn published_rows_sql(kind: &str, resource_type: &str) -> String {
    format!(
        "SELECT {KIND_COLUMNS}, users.user_name AS users_user_name, \
         marketplace_resources.recommendation_score AS \
         marketplace_resources_recommendation_score \n\
         FROM marketplace_resources INNER JOIN kinds ON kinds.id = \
         marketplace_resources.kind_id LEFT OUTER JOIN users ON users.id = kinds.user_id \n\
         WHERE kinds.user_id != 0 AND kinds.kind = '{kind}' AND kinds.is_active IS true \
         AND marketplace_resources.resource_type = '{resource_type}'"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_scan_matches_the_recorded_statement() {
        assert_eq!(
            system_rows_sql("Team"),
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, kinds.kind AS \
             kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
             kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS \
             kinds_created_at, kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE \
             kinds.user_id = 0 AND kinds.kind = 'Team' AND kinds.is_active IS true"
        );
    }

    #[test]
    fn published_scan_matches_the_recorded_statement() {
        assert_eq!(
            published_rows_sql("Team", "agent"),
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, kinds.kind AS \
             kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
             kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS \
             kinds_created_at, kinds.updated_at AS kinds_updated_at, users.user_name AS \
             users_user_name, marketplace_resources.recommendation_score AS \
             marketplace_resources_recommendation_score \nFROM marketplace_resources INNER JOIN \
             kinds ON kinds.id = marketplace_resources.kind_id LEFT OUTER JOIN users ON users.id \
             = kinds.user_id \nWHERE kinds.user_id != 0 AND kinds.kind = 'Team' AND \
             kinds.is_active IS true AND marketplace_resources.resource_type = 'agent'"
        );
    }
}
