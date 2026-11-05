// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

struct PendingSkillReload {
    request_id: u64,
    handle: CodexAppServerHandle,
}

impl Drop for PendingSkillReload {
    fn drop(&mut self) {
        // A cancelled reload has no receiver left. Retaining its pending entry
        // would indefinitely defer recovery of the invalidated process.
        if let Ok(mut pending) = self.handle.pending.try_lock() {
            pending.remove(&self.request_id);
        } else {
            let handle = self.handle.clone();
            let request_id = self.request_id;
            tokio::spawn(async move { handle.remove_pending(request_id).await });
        }
    }
}

struct SkillConfigurationUpdate<'a> {
    _activation: &'a tokio::sync::RwLockWriteGuard<'static, ()>,
    completed: bool,
}

impl Drop for SkillConfigurationUpdate<'_> {
    fn drop(&mut self) {
        if !self.completed {
            crate::services::capability_activation::mark_changed();
        }
    }
}

impl CodexAppServerClient {
    pub(crate) async fn write_skill_configuration(
        &self,
        params: Value,
        activation: &tokio::sync::RwLockWriteGuard<'static, ()>,
    ) -> Result<Value, String> {
        // A cancelled write may already have reached disk before its reply.
        let mut update = SkillConfigurationUpdate {
            _activation: activation,
            completed: false,
        };
        let response = self.request("skills/config/write", params).await?;
        self.reload_user_skills()
            .await
            .map_err(|error| format!("failed to reload skill configuration: {error}"))?;
        update.completed = true;
        Ok(response)
    }

    pub(crate) async fn reload_user_skills(&self) -> Result<(), String> {
        let params = json!({"edits": [], "reloadUserConfig": true});
        let (request_id, handle, response_rx) = self
            .prepare_request_with_process(false, None, "config/batchWrite", &params)
            .await?;
        let _pending = PendingSkillReload {
            request_id,
            handle: handle.clone(),
        };
        Self::send_request_and_wait(
            "config/batchWrite",
            params,
            codex_rpc_timeout_seconds(),
            request_id,
            handle,
            response_rx,
        )
        .await?;
        Ok(())
    }
}

/// Refresh only running processes belonging to this published capability Home.
/// Native reload updates loaded threads' user layers for their next turn.
pub(crate) async fn reload_skill_configuration(home: &Path) -> Result<usize, String> {
    let clients = {
        let states = shared_codex_app_server_states()
            .lock()
            .expect("Codex app-server shared state registry should not be poisoned");
        states
            .iter()
            .map(|((binary, home), state)| CodexAppServerClient {
                binary: binary.clone(),
                home: home.clone(),
                state: state.clone(),
            })
            .collect::<Vec<_>>()
    };
    let mut refreshed = 0;
    for client in clients {
        let state = client.state.lock().await;
        let process_home = state
            .process_environment
            .get(CODEX_HOME_ENV)
            .or_else(|| state.process_environment.get(WEGENT_CODEX_HOME_ENV));
        if state.process.is_none() || process_home.map(Path::new) != Some(home) {
            continue;
        }
        drop(state);
        client.reload_user_skills().await?;
        refreshed += 1;
    }
    Ok(refreshed)
}

#[cfg(all(test, unix))]
#[path = "skill_config_tests.rs"]
mod tests;
