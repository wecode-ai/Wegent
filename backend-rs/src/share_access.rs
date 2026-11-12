// SPDX-License-Identifier: Apache-2.0

//! Legacy share tokens are resource locators, never authorization credentials.
use sha2::{Digest, Sha256};

use crate::http_compat::FastApiError;
use crate::state::AppState;

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
}
