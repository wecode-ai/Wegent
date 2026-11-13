// SPDX-License-Identifier: Apache-2.0

//! Legacy share tokens are resource locators, never authorization credentials.
use brz_mysql::{FromMysqlRow, MysqlResult};
use sha2::{Digest, Sha256};

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

pub(crate) fn token_hash(token: &str) -> String {
    // Historical AES links quote '+' and '='; do not interpret raw '+' as space.
    let normalized = token.replace("%2B", "+").replace("%3D", "=");
    let digest = Sha256::digest(normalized.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Only version 2 is a bearer. Unknown versions fail closed.
pub(crate) fn legacy_viewer(
    version: i32,
    viewer_id: Option<i64>,
) -> Result<Option<i64>, FastApiError> {
    match version {
        2 => Ok(None),
        1 => viewer_id.map(Some).ok_or_else(|| {
            FastApiError::unauthorized("Authentication required for legacy share link")
        }),
        _ => Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Invalid share token",
        )),
    }
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
    fn only_opaque_tokens_grant_anonymous_access() {
        assert_eq!(legacy_viewer(2, None).unwrap(), None);
        assert!(legacy_viewer(1, None).is_err());
        assert_eq!(legacy_viewer(1, Some(7)).unwrap(), Some(7));
        assert!(legacy_viewer(0, Some(7)).is_err());
        assert!(legacy_viewer(3, Some(7)).is_err());
    }

    #[test]
    fn historical_url_quoting_preserves_plus() {
        assert_eq!(token_hash("aes%2B%3D"), token_hash("aes+="));
        assert_ne!(token_hash("aes+="), token_hash("aes ="));
    }

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
