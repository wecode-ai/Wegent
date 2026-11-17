//! Both device and managed readers enforce the same native manifest grants.
use crate::{agents::CodexAppServerClient, local::app_ipc::AppIpcError};
use serde_json::Value;

pub(super) async fn read(
    client: &CodexAppServerClient,
    method: &str,
    mut payload: Value,
    grant: Value,
) -> Result<Value, AppIpcError> {
    if grant["providerId"] != payload["providerId"]
        || grant["alias"] != payload["dependencyAlias"]
        || grant["marketplaceId"] != payload["source"]["marketplaceId"]
        || grant["pluginId"] != payload["source"]["pluginId"]
    {
        return Err(AppIpcError::new(
            "connection_dependency_denied",
            "Verified connection identity does not match",
        ));
    }
    match method {
        "runtime.connections.mcp" => {
            payload["readTools"] = grant["readTools"].clone();
            super::connection_mcp::request(client.clone(), payload).await
        }
        "runtime.connections.cli" => {
            super::connection_cli::request(client, payload, grant["cliReadTools"].clone()).await
        }
        _ => Err(AppIpcError::new(
            "permission_denied",
            "Only verified connection reads are allowed",
        )),
    }
}
