//! Confirm only actual materialization; failed delivery leaves the journal pending.
use super::*;

pub(super) fn identity(device_id: &str, snapshot: &Value) -> Value {
    json!({"deviceId":device_id,"revision":snapshot["revision"],"installedRevisions":snapshot["installedRevisions"]})
}

pub(super) async fn confirm(
    controller: &LocalBackendConnectionController,
    connection: &ConnectionConfig,
    instance: &str,
    device_id: &str,
    snapshot: &Value,
    result: &Value,
    targeted: bool,
) -> Result<(), AppIpcError> {
    // Local account execution must remain independent of Device registration.
    if device_id.is_empty() {
        return Ok(());
    }
    if !snapshot["installedRevisions"].is_object()
        || !snapshot["generation"]
            .as_u64()
            .is_some_and(|generation| generation > 0)
    {
        return Err(error("plugin_local_invalid_response"));
    }
    let body = json!({
            "protocolVersion":1, "instanceId":instance,
            "completion":{
                "deviceId":device_id, "generation":snapshot["generation"],
                "installedRevisions":snapshot["installedRevisions"], "result":result,
            }
    });
    let send = || post(connection, "/api/plugins/local-sync/complete", &body);
    let response = if targeted {
        controller.retry_plugin_contention(connection, send).await
    } else {
        send().await
    }
    .map_err(|failure| {
        if matches!(
            failure.code.as_str(),
            "plugin_write_busy"
                | "plugin_write_conflict"
                | "plugin_write_unavailable"
                | "plugin_write_lease_lost"
                | "plugin_local_http_unavailable"
        ) {
            crate::logging::write_executor_error_line(&format!(
                "Local plugin materialized; confirmation remains pending: code={}",
                failure.code
            ));
            error("plugin_local_confirmation_pending")
        } else {
            failure
        }
    })?;
    if !response["recorded"].is_array() || !response["superseded"].is_array() {
        return Err(error("plugin_local_invalid_response"));
    }
    if !response["superseded"].as_array().unwrap().is_empty() {
        return Err(error(if targeted {
            "INTENT_SUPERSEDED"
        } else {
            "plugin_local_sync_busy"
        }));
    }
    if result["plugins"].as_array().map_or(true, |items| {
        items.iter().any(|item| {
            !response["recorded"]
                .as_array()
                .unwrap()
                .contains(&item["id"])
        })
    }) {
        return Err(error("plugin_local_invalid_response"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_content_reinstall_still_needs_a_new_confirmation() {
        let before = json!({"revision":"same-content","installedRevisions":{"8":2}});
        let after = json!({"revision":"same-content","installedRevisions":{"8":4}});
        assert_ne!(
            identity("app-record-92", &before),
            identity("app-record-92", &after)
        );
        assert_ne!(
            identity("app-record-92", &before),
            identity("app-record-93", &before)
        );
    }
}
