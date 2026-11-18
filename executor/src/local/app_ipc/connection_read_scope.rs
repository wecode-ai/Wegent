//! A collector endpoint never inherits desktop task, shell or model authority.
use super::AppIpcError;
use serde_json::json;
use serde_json::Value;

pub(super) fn declarations(manifests: &[Value]) -> Result<Vec<Value>, AppIpcError> {
    let invalid = || {
        AppIpcError::new(
            "invalid_connection_manifest",
            "Installed connection declaration is invalid",
        )
    };
    let mut references = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for manifest in manifests {
        let name = manifest["name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .ok_or_else(invalid)?;
        let connections = &manifest["wework"]["connections"];
        if connections["apiVersion"] != 1 {
            return Err(invalid());
        }
        for provider in connections["providers"].as_array().ok_or_else(invalid)? {
            let id = provider["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(invalid)?;
            for alias in provider["uses"].as_array().ok_or_else(invalid)? {
                let alias = alias.as_str().ok_or_else(invalid)?;
                let dependency = &connections["dependencies"][alias];
                if dependency["kind"] != "codexPlugin" {
                    return Err(invalid());
                }
                for source in std::iter::once(&dependency["source"]).chain(
                    dependency["alternateSources"]
                        .as_array()
                        .into_iter()
                        .flatten(),
                ) {
                    let marketplace = source["marketplaceId"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(invalid)?;
                    let plugin = source["pluginId"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(invalid)?;
                    let provider_id = format!("{name}/{id}");
                    if !seen.insert((
                        provider_id.clone(),
                        alias.to_owned(),
                        marketplace.to_owned(),
                        plugin.to_owned(),
                    )) {
                        return Err(invalid());
                    }
                    references.push(json!({"providerId":provider_id,"alias":alias,"marketplaceId":marketplace,"pluginId":plugin,"version":dependency["version"].as_str().unwrap_or("*"),"readTools":provider["mcpReadTools"].get(alias).cloned().unwrap_or(json!([])),"cliReadTools":provider["cliReadTools"].get(alias).cloned().unwrap_or(Value::Null)}));
                }
            }
        }
    }
    Ok(references)
}

pub(super) const METHODS: &[&str] = &[
    "executor.protocol.describe",
    "executor.health",
    "runtime.connections.host",
    "runtime.connections.dependencies.inventory",
    "runtime.connections.mcp",
    "runtime.connections.cli",
    "runtime.connections.git.read",
    "runtime.connections.git.authTarget",
    "runtime.connections.git.webhooks",
];

pub(super) fn allows(method: &str, params: &Value) -> bool {
    METHODS.contains(&method)
        && (method != "runtime.connections.git.webhooks"
            || matches!(
                params["operation"].as_str(),
                Some("events" | "ack" | "boundary")
            ))
}

pub(super) fn grant(references: &[Value], params: &Value) -> Result<Value, AppIpcError> {
    references
        .iter()
        .find(|reference| {
            reference["providerId"] == params["providerId"]
                && reference["alias"] == params["dependencyAlias"]
                && reference["marketplaceId"] == params["source"]["marketplaceId"]
                && reference["pluginId"] == params["source"]["pluginId"]
        })
        .cloned()
        .ok_or_else(|| {
            AppIpcError::new(
                "connection_dependency_denied",
                "Connection dependency is not installed for this collector",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::app_ipc::{AppIpcServer, LocalEndpointRole};
    use serde_json::json;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[derive(Clone, Default)]
    struct Capture(std::sync::Arc<std::sync::Mutex<Vec<Value>>>);

    impl super::super::RuntimeWorkHandler for Capture {
        fn handle_connection_read_rpc<'a>(
            &'a self,
            method: &'a str,
            payload: Value,
            grant: Value,
        ) -> wegent_execution_contracts::ipc::BoxFuture<'a, Result<Value, AppIpcError>> {
            Box::pin(async move {
                self.0
                    .lock()
                    .unwrap()
                    .push(json!({"method":method,"payload":payload,"verifiedGrant":grant}));
                Ok(json!({"success":true}))
            })
        }
        fn handle_runtime_rpc<'a>(
            &'a self,
            data: Value,
        ) -> wegent_execution_contracts::ipc::BoxFuture<'a, Result<Value, AppIpcError>> {
            Box::pin(async move {
                self.0.lock().unwrap().push(data);
                Ok(json!({"success":true}))
            })
        }
    }

    #[tokio::test]
    async fn tool_authority_comes_from_native_manifests_instead_of_host_registration() {
        let manifest = json!({"name":"@installed/connection","wework":{"connections":{"apiVersion":1,"dependencies":{"business":{"kind":"codexPlugin","source":{"marketplaceId":"private","pluginId":"business@private"}}},"providers":[{"id":"inbox","uses":["business"],"mcpReadTools":{"business":[{"server":"business","tool":"lookup"}]},"cliReadTools":{"business":{"toolId":"business","operations":{"read":{"command":["list"]}}}}}]}}});
        let captured = Capture::default();
        let calls = captured.0.clone();
        let mut manifests = vec![manifest];
        let server = AppIpcServer::new()
            .with_connection_read_only()
            .with_connection_provider_manifests(&manifests)
            .unwrap()
            .with_runtime_work_handler(captured);
        manifests[0]["wework"]["connections"]["providers"][0]["mcpReadTools"]["business"] =
            json!([{"server":"business","tool":"delete"}]);
        server.dispatch("runtime.connections.host", json!({"url":"http://127.0.0.1:123/wework/connections/v1/rpc","token":"a".repeat(64),"dependencyReferences":[{"providerId":"@installed/connection/inbox","alias":"business","readTools":[{"server":"business","tool":"delete"}],"cliReadTools":{"operations":{"delete":{"command":["delete"]}}}}]})).await.unwrap();
        for method in ["runtime.connections.mcp", "runtime.connections.cli"] {
            server.dispatch(method, json!({"providerId":"@installed/connection/inbox","dependencyAlias":"business","source":{"marketplaceId":"private","pluginId":"business@private"},"operation":"callTool","tool":"delete","readTools":[{"server":"business","tool":"delete"}],"cliReadTools":{"operations":{"delete":{"command":["delete"]}}},"verifiedGrant":{"readTools":[{"server":"business","tool":"delete"}]}})).await.unwrap();
        }
        let calls = calls.lock().unwrap();
        let authority = &calls[0]["payload"]["dependencyReferences"];
        assert_eq!(authority.as_array().unwrap().len(), 1);
        assert_eq!(
            authority[0]["readTools"],
            json!([{"server":"business","tool":"lookup"}])
        );
        assert_eq!(
            authority[0]["cliReadTools"]["operations"],
            json!({"read":{"command":["list"]}})
        );
        assert_eq!(authority[0]["marketplaceId"], "private");
        assert_eq!(authority[0]["pluginId"], "business@private");
        assert_eq!(calls.len(), 3);
        for call in &calls[1..] {
            assert_eq!(
                call["verifiedGrant"], authority[0],
                "Caller JSON cannot replace the grant passed through the native-only interface"
            );
            assert!(call["verifiedGrant"]["cliReadTools"]["operations"]["delete"].is_null());
            assert_eq!(call["verifiedGrant"]["readTools"][0]["tool"], "lookup");
        }
    }

    #[test]
    fn authenticated_collector_cannot_promote_forged_cli_or_mcp_writes() {
        struct Home(Option<std::ffi::OsString>);
        impl Drop for Home {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(value) => std::env::set_var("WEGENT_EXECUTOR_HOME", value),
                    None => std::env::remove_var("WEGENT_EXECUTOR_HOME"),
                }
            }
        }
        let _lock = crate::test_env::lock();
        let directory = tempfile::tempdir().unwrap();
        let _home = Home(std::env::var_os("WEGENT_EXECUTOR_HOME"));
        std::env::set_var("WEGENT_EXECUTOR_HOME", directory.path());
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let handler = crate::runtime_work::RuntimeWorkRpcHandler::new("device", "/bin/false");
            let server = AppIpcServer::new().with_connection_read_only().with_runtime_work_handler(handler);
            let (client, stream) = tokio::io::duplex(16_384);
            let serving = tokio::spawn(async move { server.serve_authenticated_stream(stream, "reader-token", "owner-token").await });
            let (reader, mut writer) = tokio::io::split(client);
            let mut reader = BufReader::new(reader);
            writer.write_all(b"{\"type\":\"authenticate\",\"protocol_version\":1,\"token\":\"reader-token\",\"receive_events\":false}\n").await.unwrap();
            let mut line = String::new();
            for _ in 0..2 { line.clear(); reader.read_line(&mut line).await.unwrap(); }
            let source = json!({"marketplaceId":"private","pluginId":"business@private"});
            let requests = [
                ("register","runtime.connections.host",json!({"url":"http://127.0.0.1:123/wework/connections/v1/rpc","token":"a".repeat(64),"dependencyReferences":[{"providerId":"@forged/connection/inbox","alias":"business","marketplaceId":"private","pluginId":"business@private","readTools":[{"server":"business","tool":"delete"}],"cliReadTools":{"toolId":"business","operations":{"delete":{"command":["delete"]}}}}]})),
                ("cli-write","runtime.connections.cli",json!({"providerId":"@forged/connection/inbox","dependencyAlias":"business","source":source,"operation":"callTool","tool":"delete","arguments":{}})),
                ("mcp-write","runtime.connections.mcp",json!({"providerId":"@forged/connection/inbox","dependencyAlias":"business","source":source,"operation":"callTool","server":"business","tool":"delete","arguments":{},"readTools":[{"server":"business","tool":"delete"}]})),
            ];
            for (id, method, params) in requests {
                writer.write_all(format!("{}\n", json!({"type":"request","id":id,"method":method,"params":params})).as_bytes()).await.unwrap();
                line.clear(); reader.read_line(&mut line).await.unwrap();
                let response: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(response["id"], id);
                if id == "register" { assert_eq!(response["ok"], true); }
                else {
                    assert_eq!(response["ok"], false);
                    assert_eq!(response["error"]["code"], "connection_dependency_denied", "Writes must be rejected before starting the native tool process");
                }
            }
            drop(writer); drop(reader);
            assert!(matches!(serving.await.unwrap().unwrap(), Some(LocalEndpointRole::Client)));
        });
    }

    #[tokio::test]
    async fn collector_endpoint_rejects_task_shell_auth_and_configuration_operations() {
        let server = AppIpcServer::new().with_connection_read_only();
        for method in [
            "runtime.tasks.start",
            "runtime.tasks.send",
            "runtime.tasks.list",
            "runtime.tasks.transcript.export",
            "runtime.codex.app_server.request",
            "executor.command",
            "executor.backend.configure",
            "runtime.owner.configure",
            "executor.plugin_auth.run",
            "executor.remote_task_access.update",
            "runtime.connections.dependencies.install",
        ] {
            let error = server.dispatch(method, json!({})).await.unwrap_err();
            assert_eq!(error.code, "permission_denied", "{method}");
        }
        for operation in ["create", "remove", "setup", "takeover"] {
            assert_eq!(
                server
                    .dispatch(
                        "runtime.connections.git.webhooks",
                        json!({"operation":operation})
                    )
                    .await
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
        }
        for operation in ["events", "ack", "boundary"] {
            assert!(allows(
                "runtime.connections.git.webhooks",
                &json!({"operation":operation})
            ));
        }
        let description = server
            .dispatch("executor.protocol.describe", json!({}))
            .await
            .unwrap();
        assert_eq!(description["renderer_methods"], json!(METHODS));
        assert_eq!(description["features"]["events"], false);
        assert_eq!(description["features"]["event_resume"], false);
        assert_eq!(
            server.dispatch("executor.health", json!({})).await.unwrap()["status"],
            "healthy"
        );
        let desktop = AppIpcServer::new()
            .dispatch("executor.protocol.describe", json!({}))
            .await
            .unwrap();
        assert_eq!(desktop["features"]["events"], true);
        assert!(desktop["renderer_methods"]
            .as_array()
            .unwrap()
            .contains(&json!("runtime.*")));
    }

    #[tokio::test]
    async fn collector_token_cannot_open_a_task_event_stream() {
        let (mut client, stream) = tokio::io::duplex(8192);
        let server = AppIpcServer::new().with_connection_read_only();
        let serving = tokio::spawn(async move {
            server
                .serve_authenticated_stream(stream, "reader-token", "owner-token")
                .await
        });
        client.write_all(b"{\"type\":\"authenticate\",\"protocol_version\":1,\"token\":\"reader-token\",\"event_stream\":true}\n").await.unwrap();
        let mut reader = BufReader::new(client);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["ok"], true);
        assert!(serving
            .await
            .unwrap()
            .unwrap_err()
            .contains("cannot subscribe"));
        line.clear();
        assert_eq!(reader.read_line(&mut line).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn collector_authentication_ignores_requests_to_receive_task_events() {
        let (client, stream) = tokio::io::duplex(8192);
        let server = AppIpcServer::new().with_connection_read_only();
        let emit = server.clone();
        let serving = tokio::spawn(async move {
            server
                .serve_authenticated_stream(stream, "reader-token", "owner-token")
                .await
        });
        let (reader, mut writer) = tokio::io::split(client);
        writer.write_all(b"{\"type\":\"authenticate\",\"protocol_version\":1,\"token\":\"reader-token\",\"receive_events\":true}\n").await.unwrap();
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        for expected in ["authenticated", "event"] {
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let value: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(value["type"], expected);
            if expected == "event" {
                assert_eq!(value["event"], "executor.ready");
            }
        }
        let mut delivered = emit.event_hub.subscribe_live();
        emit.emit_event(
            "runtime.task.changed",
            json!({"private":"must not leave this endpoint"}),
        )
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), delivered.recv())
            .await
            .unwrap()
            .unwrap();
        writer.write_all(b"{\"type\":\"request\",\"id\":\"health\",\"method\":\"executor.health\",\"params\":{}}\n").await.unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["id"], "health");
        assert_eq!(response["ok"], true);
        line.clear();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(100),
            reader.read_line(&mut line)
        )
        .await
        .is_err());
        drop(writer);
        drop(reader);
        assert!(matches!(
            serving.await.unwrap().unwrap(),
            Some(LocalEndpointRole::Client)
        ));
    }
}
