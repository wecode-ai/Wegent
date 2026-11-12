// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Coalesce native reconciliation across concurrent resumes without retaining a
/// failed startup future or replaying business operations.
#[derive(Default)]
pub(super) struct McpRecovery {
    connections: StdMutex<HashMap<(String, String), ConnectionHealth>>,
    admission: Mutex<()>,
}

#[derive(Default)]
struct ConnectionHealth {
    failed: bool,
    attempted: bool,
}

/// An interrupted status check has not attempted recovery and must not consume it.
struct RecoveryClaim {
    recovery: Arc<McpRecovery>,
    connections: Vec<(String, String)>,
    committed: bool,
}

impl Drop for RecoveryClaim {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let mut connections = self
            .recovery
            .connections
            .lock()
            .expect("MCP recovery registry poisoned");
        for key in &self.connections {
            if let Some(health) = connections.get_mut(key) {
                health.attempted = false;
            }
        }
    }
}

impl McpRecovery {
    pub(super) fn observe(&self, message: &Value) {
        let method = message["method"].as_str().unwrap_or_default();
        let params = message_params(message);
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
        if matches!(method, "thread/closed" | "thread/archived")
            || (method == "thread/status/changed" && params["status"]["type"] == "notLoaded")
        {
            connections.retain(|(thread, _), _| thread != &thread_id);
            return;
        }
        if method != "mcpServer/startupStatus/updated" {
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
        match params["status"].as_str() {
            Some("ready") => {
                // Transport exit does not emit another startup notification.
                // Retain ready connections for exact status checks at admission.
                connections.insert(key, ConnectionHealth::default());
            }
            Some("starting") => {
                connections.entry(key).or_default();
            }
            Some("failed" | "cancelled") if params["failureReason"].is_null() => {
                // A retry's starting/failed notifications must not rearm itself.
                connections.entry(key).or_default().failed = true;
            }
            Some("failed") => {
                // Authentication requires a credential change, not automatic retries.
                connections.remove(&key);
            }
            _ => {}
        }
    }

    fn claim(&self, thread_id: &str) -> Vec<(String, String)> {
        let mut connections = self
            .connections
            .lock()
            .expect("MCP recovery registry poisoned");
        connections
            .iter_mut()
            .filter_map(|((thread, server), health)| {
                if thread != thread_id || health.attempted {
                    return None;
                }
                health.attempted = true;
                Some((thread.clone(), server.clone()))
            })
            .collect()
    }

    fn claim_other_failures(&self) {
        for health in self
            .connections
            .lock()
            .expect("MCP recovery registry poisoned")
            .values_mut()
        {
            if health.failed {
                health.attempted = true;
            }
        }
    }

    fn checked(&self, thread: &str, server: &str, status: &str) -> bool {
        let mut connections = self
            .connections
            .lock()
            .expect("MCP recovery registry poisoned");
        let key = (thread.to_owned(), server.to_owned());
        if status == "authenticationRequired" || status == "disabled" {
            connections.remove(&key);
            return false;
        }
        let failed = matches!(status, "failed" | "cancelled");
        if let Some(health) = connections.get_mut(&key) {
            health.failed = failed;
            health.attempted = failed;
        }
        failed
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

    /// Check native connections at work admission without replaying any tool
    /// call or restarting the shared process. Persistent failures get one attempt
    /// until a ready notification establishes a new connection episode.
    pub(super) async fn reconcile_mcp_connections(
        &self,
        thread_id: &str,
        launch_config: Option<&CodexLaunchConfig>,
    ) -> Result<(), String> {
        let recovery = {
            let state = self.state.lock().await;
            state
                .process
                .as_ref()
                .map(|process| Arc::clone(&process.notifications.mcp_recovery))
        };
        let Some(recovery) = recovery else {
            return Ok(());
        };
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
        let connections = recovery.claim(thread_id);
        if connections.is_empty() {
            return Ok(());
        }
        let mut claim = RecoveryClaim {
            recovery: Arc::clone(&recovery),
            connections,
            committed: false,
        };
        let statuses = self
            .mcp_connection_snapshots(&claim.connections, launch_config)
            .await?;
        let mut unavailable = Vec::new();
        for ((thread, server), status) in claim.connections.iter().zip(statuses) {
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
        if unavailable.is_empty() {
            claim.committed = true;
            return Ok(());
        }
        // The native API reconciles all threads. Do not separately inspect a
        // peer thread that may close while this resume holds its own admission.
        recovery.claim_other_failures();
        claim.committed = true;
        log_executor_event(
            "codex MCP startup recovery",
            &[
                ("thread_id", thread_id.to_owned()),
                ("servers", unavailable.join(",")),
            ],
        );
        // Native reconciliation reuses ready clients and creates fresh clients
        // for failed startup, while retaining each thread's configuration layers.
        self.request_with_thread_admission("config/mcpServer/reload", Value::Null, launch_config)
            .await?;
        // Optional MCPs may be omitted while startup is pending. Wait for the
        // native startup results before assembling the next turn's tool catalog.
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
    fn failures_are_claimed_once_across_threads_and_rearm_only_after_ready() {
        let recovery = McpRecovery::default();
        recovery.observe(&status("one", "computer", "failed"));
        recovery.observe(&status("two", "calendar", "cancelled"));
        assert!(recovery.claim("unrelated").is_empty());
        assert_eq!(recovery.claim("one").len(), 1);
        recovery.claim_other_failures();
        for phase in ["starting", "failed", "cancelled"] {
            recovery.observe(&status("two", "calendar", phase));
            assert!(recovery.claim("two").is_empty());
        }
        recovery.observe(&status("two", "calendar", "ready"));
        recovery.observe(&status("two", "calendar", "failed"));
        assert_eq!(
            recovery.claim("two"),
            vec![("two".into(), "calendar".into())]
        );
    }

    #[test]
    fn authentication_and_shutdown_do_not_schedule_recovery() {
        let recovery = McpRecovery::default();
        let mut auth = status("one", "mail", "failed");
        auth["params"]["failureReason"] = json!("reauthenticationRequired");
        recovery.observe(&auth);
        recovery.observe(&status("one", "codex_apps", "failed"));
        assert!(recovery.claim("one").is_empty());
        recovery.observe(&status("one", "computer", "failed"));
        recovery.observe(&json!({"method":"thread/closed","params":{"threadId":"one"}}));
        assert!(recovery.claim("one").is_empty());
        recovery.observe(&status("one", "computer", "failed"));
        recovery.observe(&json!({"method":"codex/app-server/exited"}));
        assert!(recovery.claim("one").is_empty());
    }

    #[test]
    fn process_generations_have_independent_recovery() {
        let old = CodexNotificationHub::new();
        let current = CodexNotificationHub::new();
        old.mcp_recovery.observe(&status("one", "mail", "failed"));
        assert!(current.mcp_recovery.claim("one").is_empty());
        assert_eq!(old.mcp_recovery.claim("one").len(), 1);
    }

    #[test]
    fn ready_connections_are_checked_for_silent_transport_failure() {
        let recovery = McpRecovery::default();
        recovery.observe(&status("one", "browser", "ready"));
        assert_eq!(recovery.claim("one").len(), 1);
        assert!(!recovery.checked("one", "browser", "connected"));
        assert_eq!(recovery.claim("one").len(), 1);
        assert!(recovery.checked("one", "browser", "failed"));
        assert!(recovery.claim("one").is_empty());
        recovery.observe(&status("one", "browser", "ready"));
        assert_eq!(recovery.claim("one").len(), 1);
    }

    #[test]
    fn unloaded_threads_discard_connection_health_before_cold_resume() {
        for notification in [
            json!({"method":"thread/closed","params":{"threadId":"one"}}),
            json!({"method":"thread/archived","params":{"threadId":"one"}}),
            json!({"method":"thread/status/changed","params":{"threadId":"one","status":{"type":"notLoaded"}}}),
        ] {
            let recovery = McpRecovery::default();
            recovery.observe(&status("one", "browser", "ready"));
            recovery.observe(&status("one", "calendar", "failed"));
            recovery.observe(&notification);
            assert!(recovery.claim("one").is_empty());
        }
    }

    #[test]
    fn abandoned_status_checks_preserve_unattempted_recovery() {
        let recovery = Arc::new(McpRecovery::default());
        recovery.observe(&status("one", "mail", "failed"));
        let claim = RecoveryClaim {
            recovery: Arc::clone(&recovery),
            connections: recovery.claim("one"),
            committed: false,
        };
        assert!(recovery.claim("one").is_empty());
        drop(claim);
        assert_eq!(recovery.claim("one").len(), 1);
        let claim = RecoveryClaim {
            recovery: Arc::clone(&recovery),
            connections: vec![("one".into(), "mail".into())],
            committed: true,
        };
        drop(claim);
        assert!(recovery.claim("one").is_empty());
    }
}
