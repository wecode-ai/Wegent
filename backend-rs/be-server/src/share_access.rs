// SPDX-License-Identifier: Apache-2.0

//! Legacy share tokens are resource locators, never authorization credentials.
use brz_mysql::{FromMysqlRow, MysqlResult};
pub(crate) use wegent_identity::share_token::{legacy_viewer, token_hash};

use crate::http_compat::FastApiError;
use crate::state::AppState;

#[derive(FromMysqlRow)]
pub(crate) struct TaskShareLink {
    pub resource_id: i64,
    pub created_by_user_id: i64,
    pub token_version: i32,
}

const TASK_SHARE_LINK_QUERY: &str = "SELECT share_links.resource_id AS resource_id, \
     share_links.created_by_user_id AS created_by_user_id, \
     share_links.token_version AS token_version FROM share_links \
     WHERE (share_links.token_hash = ? OR \
     (share_links.token_hash IS NULL AND share_links.token_version = 1 \
      AND SHA2(REPLACE(REPLACE(share_links.share_token, '%2B', '+'), '%3D', '='), 256) = ?)) AND \
     ((share_links.resource_type = 'TaskShare' AND share_links.token_version = 2) OR \
      (share_links.resource_type = 'Task' AND share_links.token_version = 1)) \
     AND share_links.is_active = true AND share_links.expires_at > UTC_TIMESTAMP() LIMIT 1";

pub(crate) async fn find_task_share_link(
    state: &AppState,
    token: &str,
) -> MysqlResult<Option<TaskShareLink>> {
    state
        .mysql
        .fetch_optional(
            TASK_SHARE_LINK_QUERY,
            (token_hash(token), token_hash(token)),
        )
        .await
}

pub(crate) async fn require_task_access(
    state: &AppState,
    version: i32,
    task_id: i64,
    viewer_id: Option<i64>,
) -> Result<(), FastApiError> {
    if let Some(viewer) = legacy_viewer(version, viewer_id)?
        && !crate::task_share_api::handler::is_member(state, task_id, viewer).await?
    {
        return Err(FastApiError::forbidden(
            "Legacy share link requires resource access",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashless_lookup_is_only_for_recorded_legacy_rows() {
        assert!(
            TASK_SHARE_LINK_QUERY
                .contains("share_links.token_hash IS NULL AND share_links.token_version = 1")
        );
        assert!(TASK_SHARE_LINK_QUERY.contains("SHA2(REPLACE(REPLACE("));
        assert!(!TASK_SHARE_LINK_QUERY.contains("share_links.share_token = ?"));
    }

    #[test]
    fn task_read_lookup_isolates_bearer_purposes_and_preserves_legacy_locators() {
        assert!(TASK_SHARE_LINK_QUERY.contains(
            "(share_links.resource_type = 'TaskShare' AND share_links.token_version = 2)"
        ));
        assert!(
            TASK_SHARE_LINK_QUERY
                .contains("(share_links.resource_type = 'Task' AND share_links.token_version = 1)")
        );
        assert!(!TASK_SHARE_LINK_QUERY.contains("TaskInvite"));
        assert!(TASK_SHARE_LINK_QUERY.contains("expires_at > UTC_TIMESTAMP()"));
    }
}
