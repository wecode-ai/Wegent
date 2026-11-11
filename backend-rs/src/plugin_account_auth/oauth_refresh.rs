// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Device-bound, single-use OAuth refresh leases.

use brz_mysql::MysqlTransaction;
use serde_json::{Value, json};

use super::connections::{self, AuthFailure};
use super::credential_cipher::CredentialCipher;
use super::{execution, migrations, native_credential, revocations, route, transfers};

const RECONNECT: AuthFailure = AuthFailure::Refusal("plugin_auth_reconnect_required");

pub(super) async fn begin_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &super::automation::Lease<'_>,
    user_id: i64,
    device_id: &str,
    data: &Value,
) -> Result<Value, AuthFailure> {
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let (row, package, credential) =
        execution::resolve_on(transaction, user_id, device_id, data).await?;
    let mut document = row.json;
    let spec = &mut document["spec"];
    let account = spec["accountId"].as_str().ok_or(AuthFailure::Internal)?;
    let transfer =
        json!({"source_identity":spec["sourceIdentity"],"connector_slug":spec["connectorSlug"]});
    transfers::require_no_pending_transfer(transaction, user_id, &transfer, account).await?;
    let definition = &package["auth_definition"];
    if definition["credentialType"] != "oauth2"
        || !definition["oauth2"]
            .as_array()
            .is_some_and(|operations| operations.iter().any(|op| op == "refresh"))
    {
        return Err(AuthFailure::Refusal("plugin_auth_operation_unsupported"));
    }
    let payload = native_credential::oauth_payload(&credential)?;
    let now = revocations::unix_seconds();
    if !execution::requires_refresh(&payload, now) {
        return Ok(json!({"success":true,"state":"ready"}));
    }
    if !has_refresh_token(&payload) {
        return Err(RECONNECT);
    }
    let operation = &spec["oauthRefresh"];
    let state = operation["state"].as_str();
    if state == Some("in_flight")
        && operation["expiresAt"]
            .as_f64()
            .is_some_and(|expires| expires > now)
    {
        return Err(AuthFailure::Refusal("plugin_auth_refresh_in_progress"));
    }
    if matches!(state, Some("in_flight" | "uncertain")) {
        return Err(RECONNECT);
    }
    let binding = route::device_binding_on(transaction, user_id, device_id)
        .await
        .map_err(AuthFailure::from_reason)?;
    let id = migrations::random_token_hex();
    spec["oauthRefresh"] = json!({"id":id,"state":"in_flight",
        "deviceId":binding.logical_device_id,"binding":binding.document,"expiresAt":now as i64 + 90});
    connections::advance_on(transaction, lease, row.id, &mut document).await?;
    Ok(json!({"success":true,"state":"claimed","operation_id":id,
        "connection_id":row.name,"package":package,"credential":credential}))
}

pub(super) async fn finish_on<T: MysqlTransaction>(
    transaction: &mut T,
    lease: &super::automation::Lease<'_>,
    user_id: i64,
    device_id: &str,
    data: &Value,
) -> Result<Value, AuthFailure> {
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let name = data["connection_id"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let row = connections::find_connection(transaction, user_id, name)
        .await?
        .ok_or(AuthFailure::Refusal("plugin_auth_connection_not_found"))?;
    let binding = route::device_binding_on(transaction, user_id, device_id)
        .await
        .map_err(AuthFailure::from_reason)?;
    let mut document = row.json;
    let spec = &mut document["spec"];
    let operation = &spec["oauthRefresh"];
    if operation["id"] != data["operation_id"]
        || operation["deviceId"] != binding.logical_device_id
        || operation["binding"] != binding.document
    {
        return Err(AuthFailure::Refusal("plugin_auth_operation_mismatch"));
    }
    if operation["state"] == "finished" {
        return Ok(json!({"success":true,"state":"finished"}));
    }
    let revocation = &spec["oauthRevocation"];
    let revoking = spec["status"] == "disconnected"
        && matches!(revocation["state"].as_str(), Some("pending" | "attention"))
        && revocation["refreshOperation"] == data["operation_id"];
    if !revoking {
        execution::require_connected(spec)?;
        connections::current_plugin(transaction, user_id, spec).await?;
    }
    let now = revocations::unix_seconds();
    if operation["state"] != "in_flight"
        || (!revoking
            && operation["expiresAt"]
                .as_f64()
                .is_none_or(|expires| expires <= now))
    {
        return Err(RECONNECT);
    }
    let succeeded = data["succeeded"] == true;
    let attempted = data["attempted"].as_bool().unwrap_or(true);
    if succeeded {
        let payload = refresh_result(data, &spec["accountId"], now)?;
        let encrypted = CredentialCipher::from_environment()?.encrypt(
            &crate::json_compat::python_json_value(&payload),
            &connections::credential_context(user_id, spec),
        )?;
        if revoking {
            spec["oauthRevocation"]["credential"] = encrypted;
        } else {
            spec["credential"] = encrypted;
        }
    }
    if revoking {
        let known = succeeded || !attempted;
        let revocation = &mut spec["oauthRevocation"];
        revocation["state"] = json!(if known { "pending" } else { "attention" });
        revocation["waitUntil"] = json!(0);
        revocation["refreshOperation"] = if known {
            Value::Null
        } else {
            data["operation_id"].clone()
        };
    }
    let state = if succeeded {
        "finished"
    } else if attempted {
        "uncertain"
    } else {
        "cancelled"
    };
    spec["oauthRefresh"]["state"] = json!(state);
    connections::advance_on(transaction, lease, row.id, &mut document).await?;
    Ok(json!({"success":true,"state":state}))
}

fn refresh_result(data: &Value, account: &Value, now: f64) -> Result<Value, AuthFailure> {
    let raw = data["credential"].as_str().ok_or(AuthFailure::Internal)?;
    let payload = native_credential::oauth_payload(raw)?;
    if &data["account_id"] != account
        || execution::requires_refresh(&payload, now)
        || payload.get("expires_at").is_none()
        || !has_refresh_token(&payload)
    {
        return Err(AuthFailure::Refusal("plugin_auth_invalid_refresh_result"));
    }
    Ok(payload)
}

fn has_refresh_token(payload: &Value) -> bool {
    payload["refresh_token"]
        .as_str()
        .is_some_and(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_refresh_requires_the_same_account_and_a_usable_replacement() {
        let mut data = json!({"account_id":"mine","credential":
            r#"{"access_token":"fixture","refresh_token":"fixture","expires_at":131}"#});
        assert!(refresh_result(&data, &json!("mine"), 100.0).is_ok());
        let refusal = Err(AuthFailure::Refusal("plugin_auth_invalid_refresh_result"));
        assert_eq!(refresh_result(&data, &json!("another"), 100.0), refusal);
        assert_eq!(refresh_result(&data, &json!("mine"), 101.0), refusal);
        data["credential"] = json!(r#"{"access_token":"fixture","expires_at":900}"#);
        assert_eq!(refresh_result(&data, &json!("mine"), 100.0), refusal);
    }
}
