// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Durable, revoke-only native work after platform access was removed.
//!
//! Source: `app/services/plugin_oauth_revocations.py::pending`.

use serde_json::{Map, Value, json};

use crate::device_identity::DeviceKindRow;

use super::connections::AuthFailure;
use super::credential_cipher::CredentialCipher;
use super::{EXCHANGE_FAILED, INVALID_REQUEST, connections, route};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingQuery {
    #[serde(default)]
    after_id: i64,
}

pub(super) fn parse_cursor(data: &Value) -> Result<i64, &'static str> {
    if !data.is_object() {
        return Err(INVALID_REQUEST);
    }
    let query: PendingQuery = serde::Deserialize::deserialize(data).map_err(|_| INVALID_REQUEST)?;
    if query.after_id < 0 {
        return Err(INVALID_REQUEST);
    }
    Ok(query.after_id)
}

/// `_query`: every active `ConnectorConnection` of the caller, by id.
///
/// The source renders the base `_query` filter with the full `Kind`
/// projection, so the recorded exchange selects every mapped column and
/// orders by primary key.
const CONNECTIONS_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.kind = 'ConnectorConnection' AND kinds.namespace = 'plugin-auth' \
     AND kinds.user_id = ? AND kinds.is_active IS true AND kinds.id > ? ORDER BY kinds.id";

/// `pending`'s result bound.
const MAX_PENDING: usize = 10;

pub(super) async fn begin_on<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    lease: &super::automation::Lease<'_>,
    user_id: i64,
    device_id: &str,
    name: &str,
) -> Result<Value, AuthFailure> {
    let row = disconnected_on(transaction, lease, user_id, name).await?;
    let mut document = row.json;
    let spec = &mut document["spec"];
    let binding = route::device_binding_on(transaction, user_id, device_id)
        .await
        .map_err(AuthFailure::from_reason)?;
    let now = unix_seconds();
    if spec["oauthRevocation"]["devices"].get(&binding.logical_device_id) != Some(&binding.document)
    {
        return Err(AuthFailure::Refusal("plugin_auth_device_not_granted"));
    }
    if !is_due_for(
        &document,
        &binding.logical_device_id,
        &binding.document,
        now,
    )
    .map_err(AuthFailure::from_reason)?
    {
        return Ok(json!({"success": true, "state": "unavailable"}));
    }
    let spec = &mut document["spec"];
    let package = if crate::json_compat::python_truthy(&spec["oauthRevocation"]["refreshOperation"])
    {
        None
    } else {
        match connections::current_plugin(transaction, user_id, spec).await {
            Ok((plugin, definition)) => {
                let slug = spec["connectorSlug"]
                    .as_str()
                    .ok_or(AuthFailure::Internal)?;
                Some(connections::package_metadata(&plugin, slug, definition)?)
            }
            Err(AuthFailure::Refusal(_)) => None,
            Err(error) => return Err(error),
        }
    };
    let Some(package) = package else {
        spec["oauthRevocation"]["state"] = json!("attention");
        connections::advance_on(transaction, lease, row.id, &mut document).await?;
        return Ok(json!({"success": true, "state": "unavailable"}));
    };
    let credential = CredentialCipher::from_environment()?.decrypt(
        &spec["oauthRevocation"]["credential"],
        &connections::credential_context(user_id, spec),
    )?;
    let operation = super::migrations::random_token_hex();
    let job = &mut spec["oauthRevocation"];
    job["state"] = json!("in_flight");
    job["operationId"] = json!(operation);
    job["leaseExpiresAt"] = json!(now as i64 + 90);
    job["deviceId"] = json!(binding.logical_device_id);
    job["binding"] = binding.document;
    connections::advance_on(transaction, lease, row.id, &mut document).await?;
    Ok(
        json!({"success": true, "state":"claimed","connection_id":name,
        "operation_id":operation,"package":package,"credential":credential}),
    )
}

pub(super) async fn finish_on<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    lease: &super::automation::Lease<'_>,
    user_id: i64,
    device_id: &str,
    data: &Value,
) -> Result<Value, AuthFailure> {
    let name = data["connection_id"]
        .as_str()
        .ok_or(AuthFailure::Internal)?;
    let row = disconnected_on(transaction, lease, user_id, name).await?;
    let binding = route::device_binding_on(transaction, user_id, device_id)
        .await
        .map_err(AuthFailure::from_reason)?;
    let mut document = row.json;
    let job = &mut document["spec"]["oauthRevocation"];
    let mismatch = AuthFailure::Refusal("plugin_auth_operation_mismatch");
    if job["operationId"] != data["operation_id"]
        || job["deviceId"] != binding.logical_device_id
        || job["binding"] != binding.document
    {
        return Err(mismatch);
    }
    if job["state"] == "revoked" {
        return Ok(json!({"success": true, "state":"revoked"}));
    }
    if job["state"] != "in_flight" {
        return Err(mismatch);
    }
    let state = if data["succeeded"] == true {
        *job = json!({"state":"revoked", "operationId":job["operationId"],
            "deviceId":job["deviceId"],"binding":job["binding"]});
        "revoked"
    } else {
        let attempts = job["attempts"]
            .as_u64()
            .ok_or(AuthFailure::Internal)?
            .saturating_add(1);
        let state = if attempts >= 5 {
            "attention"
        } else {
            "pending"
        };
        job["attempts"] = json!(attempts);
        job["state"] = json!(state);
        job["nextAttemptAt"] = json!(unix_seconds() as i64 + (15_i64 << attempts.min(6)).min(600));
        state
    };
    connections::advance_on(transaction, lease, row.id, &mut document).await?;
    Ok(json!({"success": true, "state": state}))
}

async fn disconnected_on<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    lease: &super::automation::Lease<'_>,
    user_id: i64,
    name: &str,
) -> Result<DeviceKindRow, AuthFailure> {
    connections::coordinate_owner(transaction, lease, user_id).await?;
    let row = connections::find_connection(transaction, user_id, name)
        .await?
        .ok_or(AuthFailure::Refusal("plugin_auth_connection_not_found"))?;
    if row.json["spec"]["status"] != "disconnected" {
        return Err(AuthFailure::Refusal("plugin_auth_operation_mismatch"));
    }
    Ok(row)
}

/// `plugin_oauth_revocations.pending`: connection names whose revocation work
/// is due for this device, on the exchange transaction.
pub(crate) async fn pending_on<T: brz_mysql::MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    after_id: i64,
) -> Result<Value, &'static str> {
    let binding = route::device_binding_on(transaction, user_id, device_id).await?;
    let rows: Vec<DeviceKindRow> = transaction
        .fetch_all(CONNECTIONS_QUERY, (user_id, after_id))
        .await
        .map_err(|_| EXCHANGE_FAILED)?;
    let now = unix_seconds();
    let mut pending = Vec::new();
    let mut connection_ids = Vec::new();
    let mut next_cursor = None;
    for row in rows {
        if !is_due_for(
            &row.json,
            &binding.logical_device_id,
            &binding.document,
            now,
        )? {
            continue;
        }
        let spec = &row.json["spec"];
        let slug = spec["connectorSlug"].as_str().ok_or(EXCHANGE_FAILED)?;
        let package = connections::current_plugin(transaction, user_id, spec)
            .await
            .and_then(|(plugin, definition)| {
                connections::package_metadata(&plugin, slug, definition)
            });
        let package = match package {
            Ok(package) => Some(package),
            Err(connections::AuthFailure::Refusal(_)) => None,
            Err(connections::AuthFailure::Internal) => return Err(EXCHANGE_FAILED),
        };
        pending.push(json!({"connection_id": row.name, "package": package}));
        connection_ids.push(row.name);
        if pending.len() >= MAX_PENDING {
            next_cursor = Some(row.id);
            break;
        }
    }
    Ok(json!({
        "success": true,
        "connection_ids": connection_ids,
        "revocations": pending,
        "next_cursor": next_cursor
    }))
}

/// One connection row's revocation predicate.
///
/// A malformed document reaches the source as an exception the broker reports
/// as the generic failure code, so every missing required member is an error
/// rather than a silent skip.
fn is_due_for(
    json: &Value,
    logical_device_id: &str,
    binding: &Value,
    now: f64,
) -> Result<bool, &'static str> {
    let spec = json.get("spec").ok_or(EXCHANGE_FAILED)?;
    let status = spec
        .get("status")
        .and_then(Value::as_str)
        .ok_or(EXCHANGE_FAILED)?;
    if status != "disconnected" {
        return Ok(false);
    }
    let job = match spec.get("oauthRevocation") {
        None | Some(Value::Null) => &Map::new(),
        Some(Value::Object(job)) => job,
        Some(_) => return Err(EXCHANGE_FAILED),
    };
    let bound = job
        .get("devices")
        .and_then(Value::as_object)
        .and_then(|devices| devices.get(logical_device_id));
    if bound != Some(binding) {
        return Ok(false);
    }
    let state = job.get("state").and_then(Value::as_str).unwrap_or_default();
    if state != "pending" && state != "in_flight" {
        return Ok(false);
    }
    due(job, state, now)
}

/// `_due`: `waitUntil` gates every state; an in-flight lease must expire, and a
/// pending attempt waits for its next attempt time.
fn due(job: &Map<String, Value>, state: &str, now: f64) -> Result<bool, &'static str> {
    if number(job.get("waitUntil")).unwrap_or(0.0) > now {
        return Ok(false);
    }
    if state == "in_flight" {
        let lease = number(job.get("leaseExpiresAt")).ok_or(EXCHANGE_FAILED)?;
        return Ok(lease <= now);
    }
    Ok(number(job.get("nextAttemptAt")).unwrap_or(0.0) <= now)
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        _ => None,
    }
}

/// `time.time()`: whole seconds with sub-second precision.
pub(super) fn unix_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs_f64())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pending_query_accepts_a_nonnegative_integer_cursor() {
        assert_eq!(parse_cursor(&json!({})), Ok(0));
        assert_eq!(parse_cursor(&json!({"after_id": 20})), Ok(20));
        assert_eq!(parse_cursor(&json!({"after_id": -1})), Err(INVALID_REQUEST));
        assert_eq!(
            parse_cursor(&json!({"after_id": "20"})),
            Err(INVALID_REQUEST)
        );
        assert_eq!(parse_cursor(&json!({"extra": 20})), Err(INVALID_REQUEST));
        assert_eq!(parse_cursor(&json!([20])), Err(INVALID_REQUEST));
    }

    fn binding() -> Value {
        json!({
            "deviceRowId": 268919,
            "runtimeDeviceId": "app-record-268919",
            "runtimeInstanceId": "runtime-1"
        })
    }

    fn connection(job: Value, status: &str) -> Value {
        json!({"spec": {"status": status, "oauthRevocation": job}})
    }

    #[test]
    fn a_bound_pending_job_is_due_once_its_attempt_time_passes() {
        let job = json!({
            "state": "pending",
            "devices": {"app-record-268919": binding()},
            "nextAttemptAt": 100
        });
        let document = connection(job, "disconnected");
        assert_eq!(
            is_due_for(&document, "app-record-268919", &binding(), 200.0),
            Ok(true)
        );
        assert_eq!(
            is_due_for(&document, "app-record-268919", &binding(), 50.0),
            Ok(false)
        );
    }

    #[test]
    fn an_in_flight_job_waits_for_its_lease_and_for_wait_until() {
        let job = json!({
            "state": "in_flight",
            "devices": {"app-record-268919": binding()},
            "leaseExpiresAt": 150,
            "waitUntil": 120
        });
        let document = connection(job, "disconnected");
        assert_eq!(
            is_due_for(&document, "app-record-268919", &binding(), 130.0),
            Ok(false)
        );
        assert_eq!(
            is_due_for(&document, "app-record-268919", &binding(), 160.0),
            Ok(true)
        );
    }

    #[test]
    fn another_device_bound_to_the_job_is_not_this_device_s_work() {
        let job = json!({
            "state": "pending",
            "devices": {"other-route": binding()}
        });
        let document = connection(job, "disconnected");
        assert_eq!(
            is_due_for(&document, "app-record-268919", &binding(), 200.0),
            Ok(false)
        );
        let connected = connection(json!({"state": "pending"}), "connected");
        assert_eq!(
            is_due_for(&connected, "app-record-268919", &binding(), 200.0),
            Ok(false)
        );
    }

    #[test]
    fn the_recorded_connection_query_is_the_source_filter() {
        assert!(
            CONNECTIONS_QUERY
                .contains("kinds.kind = 'ConnectorConnection' AND kinds.namespace = 'plugin-auth'")
        );
        assert!(CONNECTIONS_QUERY.ends_with("ORDER BY kinds.id"));
    }
}
