//! Capture an event's account before asynchronous execution or queueing.

use crate::{config::device::ConnectionConfig, protocol::ExecutionRequest};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) const REQUEST_ACCOUNT: &str = "_runtime_event_account";
pub(crate) const RAW_ACCOUNT: &str = "_runtime_event_account";

pub(crate) fn account(connection: &ConnectionConfig) -> Option<String> {
    if connection.backend_url.trim().is_empty() || connection.auth_token.trim().is_empty() {
        return None;
    }
    Some(format!(
        "{:x}",
        Sha256::digest(crate::plugin_account_auth::local_http::account_scope(
            connection
        ))
    ))
}

pub(crate) fn capture(request: &mut ExecutionRequest, connection: Option<&ConnectionConfig>) {
    // A queued or running request keeps its original account, including the
    // absence of a cloud account. Reconnecting cannot adopt offline work.
    request
        .extra
        .entry(REQUEST_ACCOUNT.to_owned())
        .or_insert_with(|| {
            connection
                .and_then(account)
                .map(Value::String)
                .unwrap_or(Value::Null)
        });
}

pub(crate) fn admit(payload: &mut Value, connection: Option<&ConnectionConfig>) {
    let account = connection
        .and_then(account)
        .map(Value::String)
        .unwrap_or(Value::Null);
    for key in ["executionRequest", "execution_request"] {
        if let Some(request) = payload.get_mut(key).and_then(Value::as_object_mut) {
            // This is the external RPC boundary. Supplied routing metadata is
            // replaced before any preparation can yield to an account switch.
            request.insert(REQUEST_ACCOUNT.to_owned(), account.clone());
        }
    }
}

pub(crate) fn stamp(event: &mut Value, request: &ExecutionRequest) {
    if let Some(account) = request.extra.get(REQUEST_ACCOUNT).and_then(Value::as_str) {
        event[RAW_ACCOUNT] = Value::String(account.to_owned());
    }
}

pub(crate) fn device_directory(device_id: &str) -> std::path::PathBuf {
    crate::runtime_work::store::runtime_work_dir()
        .join("terminal-events")
        .join(format!("{:x}", Sha256::digest(device_id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use serde_json::json;

    #[test]
    fn queued_requests_keep_their_account_across_serialization_and_reconfiguration() {
        let connection = |token: &str| ConnectionConfig {
            backend_url: "https://backend.example".into(),
            auth_token: token.into(),
            ..Default::default()
        };
        let mut request = ExecutionRequest::default();
        capture(&mut request, Some(&connection("account-a")));
        let original = request.extra[REQUEST_ACCOUNT].clone();
        let mut restored: ExecutionRequest =
            serde_json::from_value(serde_json::to_value(request).unwrap()).unwrap();
        capture(&mut restored, Some(&connection("account-b")));
        let mut event = json!({"event":"response.completed"});
        stamp(&mut event, &restored);
        assert_eq!(event[RAW_ACCOUNT], original);
        assert_ne!(
            Some(original.as_str().unwrap().to_owned()),
            account(&connection("account-b"))
        );
    }

    #[test]
    fn an_unbound_request_cannot_be_adopted_by_a_later_login() {
        let mut request = ExecutionRequest::default();
        capture(&mut request, None);
        capture(
            &mut request,
            Some(&ConnectionConfig {
                backend_url: "https://backend.example".into(),
                auth_token: "account-b".into(),
                ..Default::default()
            }),
        );
        let mut event = json!({"event":"response.completed"});
        stamp(&mut event, &request);
        assert!(event.get(RAW_ACCOUNT).is_none());
    }

    #[test]
    fn refreshing_credentials_keeps_the_account_but_other_users_and_backends_do_not() {
        let connection = |user: i64, expires: i64, url: &str| ConnectionConfig {
            backend_url: url.into(),
            auth_token: format!(
                "header.{}.signature",
                URL_SAFE_NO_PAD.encode(
                    json!({"user_id":user,"sub":user.to_string(),"exp":expires}).to_string()
                )
            ),
            ..Default::default()
        };
        let a = account(&connection(7, 100, "https://backend.example"));
        assert_eq!(a, account(&connection(7, 200, "https://backend.example")));
        assert_ne!(a, account(&connection(8, 100, "https://backend.example")));
        assert_ne!(a, account(&connection(7, 100, "https://other.example")));
    }
}
