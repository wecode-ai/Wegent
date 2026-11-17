//! Wake cloud authorization after a committed native credential change.

use brz_redis::Redis;
use serde_json::json;

use crate::state::AppState;

pub(super) fn changes_credentials(operation: &str) -> bool {
    matches!(
        operation,
        super::ENROLL | super::TRANSFER_FINISH | super::OAUTH_FINISH
    )
}

fn message(user_id: i64, installed_id: i64) -> String {
    crate::socketio_emit::device_execution_message(
        "plugin.auth.changed",
        &json!({"installed_plugin_id": installed_id}),
        "/local-executor",
        &format!("user:{user_id}"),
    )
}

pub(super) async fn publish(state: &AppState, user_id: i64, targets: &[i64]) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    for &installed_id in targets {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            redis.publish(
                crate::socketio_emit::SOCKETIO_CHANNEL,
                message(user_id, installed_id),
            ),
        )
        .await;
        if !matches!(result, Ok(Ok(_))) {
            tracing::warn!(
                user_id,
                installed_id,
                "Plugin authentication notification unavailable"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_notification_contains_only_the_owned_installation_hint() {
        let frame: serde_json::Value = serde_json::from_str(&message(23, 41)).unwrap();
        assert_eq!(frame["room"], "user:23");
        assert_eq!(frame["namespace"], "/local-executor");
        assert_eq!(frame["event"], "plugin.auth.changed");
        assert_eq!(frame["data"], json!([{"installed_plugin_id":41}]));
        assert_ne!(frame["host_id"], crate::socketio_emit::host_id());
    }

    #[test]
    fn grants_and_discovery_do_not_generate_credential_notifications() {
        assert!(changes_credentials(super::super::ENROLL));
        assert!(changes_credentials(super::super::TRANSFER_FINISH));
        assert!(changes_credentials(super::super::OAUTH_FINISH));
        assert!(!changes_credentials(super::super::AUTOMATIC));
        assert!(!changes_credentials(super::super::LOCAL_LIFECYCLE));
    }
}
