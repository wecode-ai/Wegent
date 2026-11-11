//! IM conversation bindings identify a personal stand-in on an owned device.
use brz_http_server::StatusCode;
use brz_redis::{Redis, RedisBytes, cmd};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    auth::SessionUser, device_identity::resolve_runtime_route_identity, http_compat::FastApiError,
    state::AppState,
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    device_id: String,
    #[serde(default)]
    role_id: Option<String>,
}

fn binding_key(user: i64, session: &str) -> String {
    format!("channel:stand_in_binding:{user}:{session}")
}

fn owns_session(value: &Value, user: i64, key: &str) -> bool {
    value["user_id"].as_i64() == Some(user) && value["session_key"].as_str() == Some(key)
}

#[brz_http_server::put("/api/im/private-sessions/:session_key/stand-in")]
async fn bind_stand_in(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    session_key: String,
    body: Value,
) -> Result<Binding, FastApiError> {
    let mut binding: Binding = serde_json::from_value(body).map_err(|_| {
        FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, "Invalid stand-in binding")
    })?;
    if binding.device_id.trim().is_empty()
        || binding
            .role_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty())
    {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Device and role IDs must not be empty",
        ));
    }
    let user_id = i64::from(user.id);
    let redis = state.redis.as_ref().ok_or_else(FastApiError::unhandled)?;
    let bytes: Option<RedisBytes> = redis
        .get(format!("channel:private_session:{session_key}"))
        .await
        .map_err(|_| FastApiError::unhandled())?;
    let session: Value = bytes
        .as_ref()
        .and_then(|bytes| serde_json::from_slice(bytes.as_ref()).ok())
        .unwrap_or(Value::Null);
    if !owns_session(&session, user_id, &session_key) {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "IM private session not found",
        ));
    }
    let identity = resolve_runtime_route_identity(&state.mysql, user_id, &binding.device_id)
        .await
        .map_err(|_| FastApiError::unhandled())?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Device not found"))?;
    binding.device_id = identity.logical_device_id;
    let payload = serde_json::to_string(&binding).map_err(|_| FastApiError::unhandled())?;
    // Identity and mode change together; address refreshes never overwrite either.
    let mut write = cmd("MSET");
    write
        .arg(binding_key(user_id, &session_key))
        .arg(payload)
        .arg(format!(
            "channel:private_session_mode:{user_id}:{session_key}"
        ))
        .arg(r#""stand_in""#);
    let _: String = redis
        .command(write)
        .await
        .map_err(|_| FastApiError::unhandled())?;
    Ok(binding)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_active_route_selects_a_concrete_session_url() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).unwrap();
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(table.matches(
            &http::Method::PUT,
            "/api/im/private-sessions/session-123/stand-in"
        ));
        assert!(!table.matches(
            &http::Method::POST,
            "/api/im/private-sessions/session-123/stand-in"
        ));
    }

    #[test]
    fn bindings_are_scoped_to_both_user_and_conversation() {
        let session = json!({"user_id":7,"session_key":"one"});
        assert!(owns_session(&session, 7, "one"));
        assert!(!owns_session(&session, 8, "one"));
        assert!(!owns_session(&session, 7, "two"));
        assert_ne!(binding_key(7, "one"), binding_key(8, "one"));
    }

    #[test]
    fn binding_contract_has_no_task_or_model_override() {
        let binding: Binding =
            serde_json::from_value(json!({"deviceId":"mac","roleId":"work"})).unwrap();
        assert_eq!(
            serde_json::to_value(binding).unwrap(),
            json!({"deviceId":"mac","roleId":"work"})
        );
        assert!(
            serde_json::from_value::<Binding>(json!({"deviceId":"mac","taskId":"old-task"}))
                .is_err()
        );
    }
}
