//! The desktop's existing authenticated Runtime IPC read channel.
use std::{io::Read, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

use crate::{
    config::device::ConnectionConfig,
    local::{
        app_ipc::AppIpcError,
        backend::{LocalBackendTransport, SocketIoTransport},
    },
    protocol::ExecutionRequest,
    workbench_control::read_budget::ReadBudget,
};

pub(super) struct RuntimeReader {
    transport: SocketIoTransport,
    budget: ReadBudget,
}

impl RuntimeReader {
    pub(super) async fn connect(
        request: &ExecutionRequest,
        connection: &ConnectionConfig,
        budget: ReadBudget,
    ) -> Result<Self, AppIpcError> {
        let backend = crate::agents::request_backend_url(request)
            .ok_or_else(|| AppIpcError::new("cloud_unavailable", "Cloud connection is required"))?;
        let token = request
            .auth_token
            .as_deref()
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                AppIpcError::new("cloud_unavailable", "Cloud authorization is required")
            })?;
        let socket_url = configured_socket_url(&backend, connection)?;
        let transport = SocketIoTransport::for_namespace("/wework-runtime");
        budget
            .read("devices", "runtime.connect", async {
                transport
                    .connect_authenticated(socket_url, token)
                    .await
                    .map_err(|_| {
                        AppIpcError::new(
                            "cloud_unavailable",
                            "Runtime read channel connection failed",
                        )
                    })
            })
            .await?;
        Ok(Self { transport, budget })
    }

    pub(super) async fn close(&self) {
        // Cleanup must also finish inside the MCP deadline after reads expire.
        let _ = tokio::time::timeout(Duration::from_secs(10), self.transport.disconnect()).await;
    }

    pub(super) async fn request(
        &self,
        device: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, AppIpcError> {
        if !matches!(
            method,
            "runtime.tasks.list"
                | "runtime.tasks.get"
                | "runtime.tasks.transcript"
                | "runtime.tasks.transcript.search"
                | "runtime.archived_conversations.list"
        ) {
            return Err(AppIpcError::new(
                "permission_denied",
                "Only existing Runtime read operations are allowed",
            ));
        }
        let id = format!("runtime-read-{}", uuid::Uuid::new_v4());
        // Match the desktop's operation budgets, bounded by this read's deadline.
        let timeout = Duration::from_secs(match method {
            "runtime.tasks.transcript" => 15,
            "runtime.tasks.transcript.search" => 130,
            _ => 75,
        })
        .min(self.budget.remaining());
        let relay_seconds = timeout.as_secs().saturating_sub(10).max(1);
        self.budget
            .read(device, method, async {
                let ack = self
                    .transport
                    .call(
                        "runtime:request",
                        json!({"type":"request","id":id,
            "method":method,"params":params,"device_id":device,"timeout_seconds":relay_seconds}),
                        timeout,
                    )
                    .await
                    .map_err(|error| {
                        AppIpcError::new(
                            if self.budget.remaining().is_zero() {
                                "query_timeout"
                            } else if error.ends_with("timed out") {
                                "device_timeout"
                            } else {
                                "device_query_failed"
                            },
                            "Runtime read request failed",
                        )
                    })?;
                // Socket.IO callbacks pass positional arguments as an array.
                let ack = ack.as_array().and_then(|args| args.first()).unwrap_or(&ack);
                if ack["id"] != id {
                    return Err(invalid_response());
                }
                if ack["ok"] != true || ack["error"].is_object() {
                    return Err(AppIpcError::new(
                        ack["error"]["code"]
                            .as_str()
                            .unwrap_or("device_query_failed"),
                        "The Runtime read channel rejected the request",
                    ));
                }
                let result = decode_response(ack["result"].clone())?;
                check_success(&result)?;
                Ok(result)
            })
            .await
    }

    pub(super) async fn transcript(
        &self,
        device: &str,
        mut params: Value,
    ) -> Result<Value, AppIpcError> {
        params["transcriptProtocolVersion"] = json!(2);
        let mut transfer = super::transcript_transport::TranscriptDecoder::default();
        loop {
            let response = self
                .request(device, "runtime.tasks.transcript", params.clone())
                .await?;
            if response.get("transcriptProtocolVersion").is_none() {
                return Ok(response);
            }
            if let Some(page) = transfer.push(&response)? {
                check_success(&page)?;
                return Ok(page);
            }
            params["transcriptTransfer"] = response["transfer"].clone();
            let request = params["transcriptTransfer"]
                .as_object_mut()
                .ok_or_else(invalid_response)?;
            let snapshot = request.remove("snapshotId").ok_or_else(invalid_response)?;
            let offset = request.remove("nextOffset").ok_or_else(invalid_response)?;
            *request = serde_json::Map::from_iter([
                ("snapshotId".into(), snapshot),
                ("offset".into(), offset),
            ]);
        }
    }
}

fn configured_socket_url<'a>(
    backend: &str,
    connection: &'a ConnectionConfig,
) -> Result<&'a str, AppIpcError> {
    use crate::agents::runtime_capabilities::api_url;
    let invalid_url =
        |_| AppIpcError::new("invalid_configuration", "Invalid backend connection URL");
    if api_url(&connection.backend_url, "/").map_err(invalid_url)?
        != api_url(backend, "/").map_err(invalid_url)?
    {
        return Err(AppIpcError::new(
            "backend_connection_changed",
            "The calling conversation and current desktop connection use different backends",
        ));
    }
    if connection.socket_url.trim().is_empty() {
        return Err(AppIpcError::new(
            "backend_connection_unavailable",
            "The desktop Runtime connection is not configured",
        ));
    }
    // The connection controller already resolves this endpoint for the desktop.
    Ok(&connection.socket_url)
}

fn decode_response(result: Value) -> Result<Value, AppIpcError> {
    match result.get("__runtimeRpcEncoding").and_then(Value::as_str) {
        None => Ok(result),
        Some("gzip+base64+json") => {
            let bytes = STANDARD
                .decode(result["payload"].as_str().ok_or_else(invalid_response)?)
                .map_err(|_| invalid_response())?;
            let mut unpacked = Vec::new();
            flate2::read::GzDecoder::new(bytes.as_slice())
                .read_to_end(&mut unpacked)
                .map_err(|_| invalid_response())?;
            serde_json::from_slice(&unpacked).map_err(|_| invalid_response())
        }
        _ => Err(invalid_response()),
    }
}

fn check_success(result: &Value) -> Result<(), AppIpcError> {
    if !result.is_object() {
        return Err(invalid_response());
    }
    if result["success"] == false {
        return Err(AppIpcError::new(
            result["error"]["code"]
                .as_str()
                .or_else(|| result["code"].as_str())
                .unwrap_or("device_query_failed"),
            "Runtime returned a failed read",
        ));
    }
    Ok(())
}

pub(super) fn invalid_response() -> AppIpcError {
    AppIpcError::new("invalid_response", "Invalid Runtime read response")
}

#[cfg(test)]
pub(super) mod tests;
