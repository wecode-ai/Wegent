// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

const AUTH_ERROR: &str = "failed to load configuration: Your access token could not be refreshed. Please log out and sign in again.";

#[test]
fn cloud_config_auth_error_retains_its_native_failure_reason() {
    // Native Codex loses the bundle wording after a failed startup uses defaults.
    let error = response_result(json!({
        "id": 217,
        "error": {
            "code": -32600,
            "message": AUTH_ERROR,
            "data": {
                "reason": "cloudConfigBundle",
                "errorCode": "Auth",
                "detail": "Your access token could not be refreshed. Please log out and sign in again.",
                "statusCode": 401,
                "action": "relogin"
            }
        }
    }))
    .unwrap_err();
    assert!(is_codex_cloud_config_error(&error), "{error}");
    assert!(error.contains(AUTH_ERROR));
}

#[test]
fn cloud_config_recovery_requires_the_bundle_reason_or_explicit_bundle_error() {
    for data in [
        Value::Null,
        json!({"reason": "authentication", "statusCode": 401}),
        json!({"detail": "cloudConfigBundle", "statusCode": 401}),
    ] {
        let error = response_result(json!({
            "id": 1,
            "error": {"code": -32600, "message": AUTH_ERROR, "data": data}
        }))
        .unwrap_err();
        assert_eq!(error, AUTH_ERROR);
        assert!(!is_codex_cloud_config_error(&error));
    }
    let message = "failed to load configuration: Failed to load cloud config bundle (workspace-managed policies).";
    let error = response_result(json!({"error": {
        "message": message,
        "data": {"reason": "cloudConfigBundle"}
    }}))
    .unwrap_err();
    assert_eq!(error, message);
    assert_eq!(
        response_result(json!({"result": {"ready": true}})),
        Ok(json!({"ready": true}))
    );
}

#[tokio::test]
async fn cloud_config_errors_cannot_change_explicit_subscription_or_named_home_auth() {
    let root = tempfile::tempdir().unwrap();
    for (home, launch_config) in [
        (
            None,
            CodexLaunchConfig {
                auth_mode: Some(CodexAuthMode::LocalSubscription),
                ..CodexLaunchConfig::default()
            },
        ),
        (Some(root.path().to_owned()), CodexLaunchConfig::default()),
    ] {
        let client = CodexAppServerClient {
            binary: "must-not-start".to_owned(),
            home,
            state: Arc::new(Mutex::new(CodexAppServerSharedState {
                auth_mode: CodexAuthMode::LocalSubscription,
                ..CodexAppServerSharedState::default()
            })),
        };
        let error = response_result(json!({"error": {
            "message": AUTH_ERROR,
            "data": {"reason": "cloudConfigBundle"}
        }}))
        .unwrap_err();
        let degraded = client
            .degrade_auth_after_cloud_config_failure(
                "thread/start",
                &error,
                None,
                Some(&launch_config),
                false,
            )
            .await
            .unwrap();
        assert!(!degraded);
        assert_eq!(
            client.state.lock().await.auth_mode,
            CodexAuthMode::LocalSubscription
        );
    }
}
