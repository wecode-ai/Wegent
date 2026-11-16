// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

/// Remember native connection ownership, not a cached verdict about its health.
#[derive(Default)]
pub(super) struct McpRecovery {
    connections: StdMutex<HashSet<(String, String)>>,
    admission: Mutex<()>,
    revision: AtomicU64,
}

impl McpRecovery {
    pub(super) fn observe(&self, message: &Value) {
        let method = message["method"].as_str().unwrap_or_default();
        let params = message_params(message);
        let unloaded = matches!(method, "thread/closed" | "thread/archived")
            || (method == "thread/status/changed" && params["status"]["type"] == "notLoaded");
        if !unloaded
            && !matches!(
                method,
                "codex/app-server/exited" | "mcpServer/startupStatus/updated"
            )
        {
            return;
        }
        let mut connections = self
            .connections
            .lock()
            .expect("MCP recovery registry poisoned");
        if method == "codex/app-server/exited" {
            connections.clear();
            return;
        }
        let Some(thread_id) = stream_thread_id(params) else {
            return;
        };
        if unloaded {
            connections.retain(|(thread, _)| thread != &thread_id);
            return;
        }
        let Some(server) = params["name"].as_str() else {
            return;
        };
        // The native connector runtime owns this reserved server's reconnect
        // and authentication policy; do not run a competing recovery loop.
        if server == "codex_apps" {
            return;
        }
        let key = (thread_id, server.to_owned());
        if !params["failureReason"].is_null() {
            connections.remove(&key);
        } else if matches!(
            params["status"].as_str(),
            Some("starting" | "ready" | "failed" | "cancelled")
        ) {
            // Transport exit emits no new startup notification. Every new work
            // admission must check the actual state of known connections.
            connections.insert(key);
        }
    }

    fn connections(&self, thread_id: &str) -> Vec<(String, String)> {
        self.connections
            .lock()
            .expect("MCP recovery registry poisoned")
            .iter()
            .filter(|(thread, _)| thread == thread_id)
            .cloned()
            .collect()
    }

    fn checked(&self, thread: &str, server: &str, status: &str) -> bool {
        if matches!(status, "authenticationRequired" | "disabled") {
            self.connections
                .lock()
                .expect("MCP recovery registry poisoned")
                .remove(&(thread.to_owned(), server.to_owned()));
        }
        matches!(status, "failed" | "cancelled")
    }
}

impl CodexAppServerClient {
    async fn mcp_connection_snapshots(
        &self,
        connections: &[(String, String)],
        launch_config: Option<&CodexLaunchConfig>,
    ) -> Result<Vec<Value>, String> {
        // Exact snapshots inspect existing clients without separate discovery.
        futures_util::future::try_join_all(connections.iter().map(|(thread, server)| {
            self.request_with_thread_admission(
                "mcpServerStatus/list",
                json!({"threadId":thread,"serverName":server,"detail":"toolsAndAuthOnly"}),
                launch_config,
            )
        }))
        .await
    }

    /// Reconcile once per admitted execution. Concurrent admissions share the
    /// same global native refresh; a later execution can recover a late service.
    pub(super) async fn reconcile_mcp_connections(
        &self,
        thread_id: &str,
        launch_config: Option<&CodexLaunchConfig>,
    ) -> Result<(), String> {
        let recovery = self
            .state
            .lock()
            .await
            .process
            .as_ref()
            .map(|process| Arc::clone(&process.notifications.mcp_recovery));
        let Some(recovery) = recovery else {
            return Ok(());
        };
        let observed_revision = recovery.revision.load(Ordering::Acquire);
        let _admission = recovery.admission.lock().await;
        if !self
            .state
            .lock()
            .await
            .process
            .as_ref()
            .is_some_and(|process| Arc::ptr_eq(&process.notifications.mcp_recovery, &recovery))
        {
            return Ok(());
        }
        let connections = recovery.connections(thread_id);
        if connections.is_empty() {
            return Ok(());
        }
        let statuses = self
            .mcp_connection_snapshots(&connections, launch_config)
            .await?;
        let mut unavailable = Vec::new();
        for ((thread, server), status) in connections.iter().zip(statuses) {
            let state = status["data"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|entry| entry["name"] == *server)
                .and_then(|entry| entry["runtimeStatus"].as_str())
                .unwrap_or_default();
            if recovery.checked(thread, server, state) {
                unavailable.push(server.clone());
            }
        }
        if unavailable.is_empty() || recovery.revision.load(Ordering::Acquire) != observed_revision
        {
            return Ok(());
        }
        // Native reload covers all loaded threads. Coalesce admissions that
        // queued behind it without querying a peer thread that may be closing.
        recovery.revision.fetch_add(1, Ordering::AcqRel);
        log_executor_event(
            "codex MCP startup recovery",
            &[
                ("thread_id", thread_id.to_owned()),
                ("servers", unavailable.join(",")),
            ],
        );
        self.request_with_thread_admission("config/mcpServer/reload", Value::Null, launch_config)
            .await?;
        // Optional MCPs may be omitted while startup is pending. Wait for native
        // startup results before assembling the next turn's tool catalog.
        let refreshed: Vec<_> = unavailable
            .into_iter()
            .map(|server| (thread_id.to_owned(), server))
            .collect();
        self.mcp_connection_snapshots(&refreshed, launch_config)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(thread: &str, server: &str, status: &str) -> Value {
        json!({"method":"mcpServer/startupStatus/updated","params":{
            "threadId":thread,"name":server,"status":status,"failureReason":null
        }})
    }

    #[test]
    fn connection_health_does_not_poison_later_executions() {
        let recovery = McpRecovery::default();
        for phase in ["starting", "ready", "failed", "cancelled"] {
            recovery.observe(&status("one", "browser", phase));
            assert_eq!(
                recovery.connections("one"),
                vec![("one".into(), "browser".into())]
            );
            assert!(!recovery.checked("one", "browser", "connected"));
            assert!(recovery.checked("one", "browser", "failed"));
            assert_eq!(recovery.connections("one").len(), 1);
        }
        assert!(recovery.connections("unrelated").is_empty());
    }

    #[test]
    fn authentication_and_native_connectors_keep_their_own_recovery() {
        let recovery = McpRecovery::default();
        let mut auth = status("one", "mail", "failed");
        auth["params"]["failureReason"] = json!("reauthenticationRequired");
        recovery.observe(&auth);
        recovery.observe(&status("one", "codex_apps", "failed"));
        assert!(recovery.connections("one").is_empty());
        for state in ["authenticationRequired", "disabled"] {
            recovery.observe(&status("one", "mail", "ready"));
            assert!(!recovery.checked("one", "mail", state));
            assert!(recovery.connections("one").is_empty());
        }
    }

    #[test]
    fn unloaded_threads_discard_connections_before_cold_resume() {
        for notification in [
            json!({"method":"thread/closed","params":{"threadId":"one"}}),
            json!({"method":"thread/archived","params":{"threadId":"one"}}),
            json!({"method":"thread/status/changed","params":{"threadId":"one","status":{"type":"notLoaded"}}}),
            json!({"method":"codex/app-server/exited"}),
        ] {
            let recovery = McpRecovery::default();
            recovery.observe(&status("one", "browser", "ready"));
            recovery.observe(&status("one", "calendar", "failed"));
            recovery.observe(&notification);
            assert!(recovery.connections("one").is_empty());
        }
    }

    #[test]
    fn process_generations_have_independent_recovery() {
        let old = CodexNotificationHub::new();
        let current = CodexNotificationHub::new();
        old.mcp_recovery.observe(&status("one", "mail", "failed"));
        old.mcp_recovery.revision.fetch_add(1, Ordering::AcqRel);
        assert!(current.mcp_recovery.connections("one").is_empty());
        assert_eq!(current.mcp_recovery.revision.load(Ordering::Acquire), 0);
        assert_eq!(old.mcp_recovery.connections("one").len(), 1);
    }
}
