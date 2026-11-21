// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Approved resource grants resolved through external entity ids.

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use wegent_backend_persistence::mysql_query::MysqlQuery;

/// `IExternalEntityResolver.get_resource_ids_by_entity` step 1: the DISTINCT
/// approved entity ids bound to one resource type (the candidate list passed
/// to the application-supplied resolver).
pub async fn distinct_entity_resource_ids<M>(
    mut mysql: &M,
    resource_type: &str,
    entity_type: &str,
) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    distinct_entity_resource_ids_on(&mut mysql, resource_type, entity_type).await
}

pub async fn distinct_entity_resource_ids_on<Q>(
    mysql: &mut Q,
    resource_type: &str,
    entity_type: &str,
) -> MysqlResult<Vec<String>>
where
    Q: MysqlQuery,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_entity_id: String,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            "SELECT DISTINCT resource_members.entity_id AS resource_members_entity_id \
             FROM resource_members WHERE resource_members.resource_type = ? AND \
             resource_members.entity_type = ? AND \
             resource_members.entity_id IS NOT NULL AND \
             resource_members.status = 'approved'",
            (resource_type, entity_type),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_entity_id)
        .collect())
}

/// `list_resources_by_entity_match`: the DISTINCT approved resource ids
/// bound to resolver-matched entity ids for one resource type.
pub async fn resource_ids_by_entity_ids<M>(
    mut mysql: &M,
    resource_type: &str,
    entity_type: &str,
    matched_entity_ids: &[String],
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    resource_ids_by_entity_ids_on(&mut mysql, resource_type, entity_type, matched_entity_ids).await
}

pub async fn resource_ids_by_entity_ids_on<Q>(
    mysql: &mut Q,
    resource_type: &str,
    entity_type: &str,
    matched_entity_ids: &[String],
) -> MysqlResult<Vec<i64>>
where
    Q: MysqlQuery,
{
    if matched_entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_resource_id: i64,
    }
    let placeholders = vec!["?"; matched_entity_ids.len()].join(", ");
    let rows: Vec<Row> = mysql
        .fetch_all(
            format!(
                "SELECT DISTINCT resource_members.resource_id AS \
                 resource_members_resource_id FROM resource_members WHERE \
                 resource_members.resource_type = ? AND resource_members.entity_type = \
                 ? AND resource_members.entity_id IN ({placeholders}) AND \
                 resource_members.status = 'approved'"
            ),
            std::iter::once(resource_type)
                .chain(std::iter::once(entity_type))
                .chain(matched_entity_ids.iter().map(String::as_str))
                .collect::<Vec<&str>>(),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}
