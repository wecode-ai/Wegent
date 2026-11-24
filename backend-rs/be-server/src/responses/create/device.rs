// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Owned traditional-device placement for ordinary Responses execution.

use brz_http_server::StatusCode;
use serde_json::Value;

use crate::device_identity::{
    DeviceKindRow, device_connection_route_id, resolve_device_for_binding_on,
};
use crate::http_compat::FastApiError;
use wegent_backend_persistence::mysql_query::MysqlQuery;

/// Resolve current ownership before creating a turn; continuations retain placement.
pub(super) async fn resolve<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    requested: Option<&str>,
    existing_task: Option<&Value>,
) -> Result<Option<String>, FastApiError> {
    let stored = existing_task
        .and_then(|task| task.pointer("/spec/device_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let bound = match stored {
        Some(device_id) => Some(resolve_route(query, user_id, device_id).await?),
        None => None,
    };
    let Some(requested) = requested else {
        return Ok(bound);
    };
    let route = resolve_route(query, user_id, requested).await?;
    if bound.as_ref().is_some_and(|bound| bound != &route) {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "execution.device_id must match the previous response device",
        ));
    }
    Ok(Some(route))
}

async fn resolve_route<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
) -> Result<String, FastApiError> {
    let device = resolve_device_for_binding_on(query, user_id, device_id)
        .await
        .map_err(super::handler::dependency)?;
    traditional_route(device.as_ref())
}

fn traditional_route(device: Option<&DeviceKindRow>) -> Result<String, FastApiError> {
    let device = device.ok_or_else(|| {
        FastApiError::detail(StatusCode::NOT_FOUND, "Device not found or not accessible")
    })?;
    if !device.remote_control_enabled() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "execution.type=wegent requires a traditional executor device",
        ));
    }
    let route = device_connection_route_id(device);
    if route.trim().is_empty() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Selected device has no executor route",
        ));
    }
    Ok(route)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn device_selection_checks_current_owner_and_active_registration() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let error = resolve(&mut &mysql, 7, Some("foreign-device"), None)
            .await
            .unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].first_integer, Some(7));
        assert!(queries[0].sql.contains("kinds.namespace = 'default'"));
        assert!(queries[0].sql.contains("kinds.is_active = true"));
        assert!(mysql.writes().is_empty());
    }

    #[tokio::test]
    async fn a_revoked_inherited_device_cannot_be_replaced_by_a_new_selection() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let task = json!({"spec": {"device_id": "revoked-device"}});
        let error = resolve(&mut &mysql, 7, Some("replacement"), Some(&task))
            .await
            .unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(mysql.queries().len(), 1);
        assert!(mysql.writes().is_empty());
    }

    #[tokio::test]
    async fn ordinary_unbound_execution_performs_no_device_query() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        assert_eq!(resolve(&mut &mysql, 7, None, None).await.unwrap(), None);
        assert!(mysql.queries().is_empty());
    }

    #[tokio::test]
    async fn continuation_inherits_the_route_and_accepts_only_aliases_of_its_device() {
        use crate::sql_test_support::mysql_rows::{MysqlRows, Value as Cell};
        let fixture = MysqlRows::start_results(|_| {
            let devices =
                vec![
                    vec![
                    ("kinds_id", Cell::I64(1)),
                    ("kinds_name", Cell::Text("cloud-name".into())),
                    ("kinds_json", Cell::Text(json!({"spec": {
                        "deviceType": "cloud", "cloudConfig": {"deviceId": "cloud-route"}
                    }}).to_string())),
                ],
                    vec![
                        ("kinds_id", Cell::I64(2)),
                        ("kinds_name", Cell::Text("other-device".into())),
                        (
                            "kinds_json",
                            Cell::Text(json!({"spec": {"deviceType": "local"}}).to_string()),
                        ),
                    ],
                ];
            (devices[0].clone(), devices)
        })
        .await;
        let task = json!({"spec": {"device_id": "cloud-route"}});
        for requested in [None, Some("cloud-name")] {
            assert_eq!(
                resolve(&mut &fixture.mysql, 7, requested, Some(&task))
                    .await
                    .unwrap(),
                Some("cloud-route".into())
            );
        }
        let error = resolve(&mut &fixture.mysql, 7, Some("other-device"), Some(&task))
            .await
            .unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn missing_or_revoked_device_cannot_be_used_as_a_raw_route() {
        assert_eq!(
            traditional_route(None).unwrap_err().status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn native_app_and_unknown_device_types_cannot_enter_executor_dispatch() {
        for kind in ["app", "unknown"] {
            let device = DeviceKindRow {
                id: 1,
                name: "device".into(),
                json: json!({"spec": {"deviceType": kind}}),
            };
            assert_eq!(
                traditional_route(Some(&device)).unwrap_err().status(),
                StatusCode::BAD_REQUEST
            );
        }
    }

    #[test]
    fn cloud_device_uses_its_registered_connection_route() {
        let device = DeviceKindRow {
            id: 1,
            name: "cloud-name".into(),
            json: json!({"spec": {
                "deviceType": "cloud", "cloudConfig": {"deviceId": "cloud-route"}
            }}),
        };
        assert_eq!(traditional_route(Some(&device)).unwrap(), "cloud-route");
    }
}
