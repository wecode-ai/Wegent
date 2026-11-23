//! Published deliveries are contribution facts; drafts and comments are not.
use super::*;
use crate::http_compat::FastApiError;
use brz_mysql::FromMysqlRow;
use chrono::NaiveDateTime;

#[derive(FromMysqlRow)]
struct Delivery {
    id: String,
    loop_item_id: String,
    created_by_user_id: Option<i32>,
    delivered_at: NaiveDateTime,
}

pub(super) async fn load(
    query: &mut impl wegent_backend_persistence::mysql_query::MysqlQuery,
    project: &str,
    visibility: &str,
    window: Window,
) -> Result<Vec<Evidence>, FastApiError> {
    let rows: Vec<Delivery> = query
        .fetch_all(
            format!(
                "SELECT id,loop_item_id,created_by_user_id,delivered_at FROM loop_items \
         WHERE resource_type='delivery' AND status='delivered' AND {} \
         AND delivered_at>'1970-01-01 00:00:01' AND delivered_at<? AND loop_item_id IN \
         (SELECT id FROM loop_items WHERE cloud_project_id=? AND resource_type='task' \
         AND (parent_id IS NULL OR parent_id='') AND {} {visibility})",
                super::super::LIVE,
                super::super::LIVE
            ),
            (window.as_of.naive_utc(), project),
        )
        .await
        .map_err(super::super::internal)?;
    Ok(rows
        .into_iter()
        .map(|row| Evidence {
            key: format!("delivery:{}", row.id),
            revision: 1,
            issue_id: row.loop_item_id,
            references: vec![row.id],
            fact: Fact::Contribution {
                user_id: row.created_by_user_id.filter(|id| *id > 0),
                basis: ContributionBasis::Delivery,
                effective_at: row.delivered_at.and_utc(),
                revoked: false,
            },
        })
        .collect())
}
