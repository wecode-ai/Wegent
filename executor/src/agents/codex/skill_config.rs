// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

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
        self.request_existing(
            "config/batchWrite",
            json!({"edits": [], "reloadUserConfig": true}),
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
            .filter(|((_, registered_home), _)| {
                registered_home.as_deref().map_or_else(
                    || wework_codex_home() == home,
                    |registered_home| registered_home == home,
                )
            })
            .map(|((binary, home), state)| CodexAppServerClient {
                binary: binary.clone(),
                home: home.clone(),
                state: state.clone(),
            })
            .collect::<Vec<_>>()
    };
    let mut refreshed = 0;
    for client in clients {
        if client.state.lock().await.process.is_none() {
            continue;
        }
        client.reload_user_skills().await?;
        refreshed += 1;
    }
    Ok(refreshed)
}

#[cfg(all(test, unix))]
#[path = "skill_config_tests.rs"]
mod tests;
