// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// A native reload reconciles every thread and retains healthy clients. Claim all
/// observed failures together so concurrent resumes do not each reload the runtime.
#[derive(Default)]
pub(super) struct McpRecovery {
    failures: StdMutex<HashMap<(String, String), bool>>,
    admission: Mutex<()>,
}

impl McpRecovery {
    pub(super) fn observe(&self, message: &Value) {
        let method = message["method"].as_str().unwrap_or_default();
        let params = message_params(message);
        let mut failures = self
            .failures
            .lock()
            .expect("MCP recovery registry poisoned");
        if method == "codex/app-server/exited" {
            failures.clear();
            return;
        }
        let Some(thread_id) = stream_thread_id(params) else {
            return;
        };
        if method == "thread/closed" {
            failures.retain(|(thread, _), _| thread != &thread_id);
            return;
        }
        if method != "mcpServer/startupStatus/updated" {
            return;
        }
        let Some(server) = params["name"].as_str() else {
            return;
        };
        let key = (thread_id, server.to_owned());
        match params["status"].as_str() {
            Some("ready") => {
                failures.remove(&key);
            }
            Some("failed" | "cancelled") if params["failureReason"].is_null() => {
                // A retry's starting/failed notifications must not rearm itself.
                failures.entry(key).or_insert(false);
            }
            Some("failed") => {
                // Authentication requires a credential change, not automatic retries.
                failures.remove(&key);
            }
            _ => {}
        }
    }

    fn claim(&self, thread_id: &str) -> Vec<(String, String)> {
        let mut failures = self
            .failures
            .lock()
            .expect("MCP recovery registry poisoned");
        if !failures
            .iter()
            .any(|((thread, _), attempted)| thread == thread_id && !attempted)
        {
            return Vec::new();
        }
        failures
            .iter_mut()
            .filter_map(|(key, attempted)| {
                if *attempted {
                    return None;
                }
                *attempted = true;
                Some(key.clone())
            })
            .collect()
    }
}

impl CodexAppServerClient {
    /// Recover failed startup at a new resume boundary, without replaying any tool
    /// call or restarting the shared process. Persistent failures get one attempt
    /// until a ready notification establishes a new connection episode.
    pub(super) async fn recover_mcp_startup(
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
        let failures = recovery.claim(thread_id);
        if failures.is_empty() {
            return Ok(());
        }
        let mut unavailable = Vec::new();
        for (thread, server) in failures {
            let status = self
                .request_with_thread_admission(
                    "mcpServerStatus/list",
                    json!({"threadId":thread,"serverName":server,"detail":"toolsAndAuthOnly"}),
                    launch_config,
                )
                .await?;
            if status["data"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|entry| {
                    entry["name"] == server
                        && matches!(
                            entry["runtimeStatus"].as_str(),
                            Some("failed" | "cancelled")
                        )
                })
            {
                unavailable.push(server);
            }
        }
        if unavailable.is_empty() {
            return Ok(());
        }
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
        assert_eq!(recovery.claim("one").len(), 2);
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
}
