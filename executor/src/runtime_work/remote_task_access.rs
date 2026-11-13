//! Installation-local consent for personal task access through the Backend.

use std::{fs, path::PathBuf, sync::OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::local::app_ipc::AppIpcError;

use super::store::atomic_write_file;

static CHANGED: OnceLock<Notify> = OnceLock::new();

pub(crate) const TASK_METHODS: &[&str] = &[
    "runtime.tasks.create",
    "runtime.tasks.list",
    "runtime.tasks.search",
    "runtime.tasks.transcript",
    "runtime.tasks.transcript.search",
    "runtime.tasks.send",
    "runtime.tasks.cancel",
    "runtime.tasks.goal.get",
    "runtime.tasks.goal.set",
];

#[derive(Clone)]
pub(crate) struct RemoteTaskAccess {
    path: PathBuf,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    enabled: bool,
}

impl RemoteTaskAccess {
    pub(crate) fn from_env() -> Self {
        Self::new(crate::config::paths::executor_home().join("remote-task-access.json"))
    }

    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub(crate) fn read(&self) -> Result<Value, AppIpcError> {
        let settings = match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice::<Settings>(&bytes)
                .map_err(|error| access_error(error.to_string()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(error) => return Err(access_error(error.to_string())),
        };
        Ok(json!({"enabled": settings.enabled}))
    }

    pub(crate) fn enabled(&self) -> bool {
        self.read()
            .ok()
            .and_then(|value| value["enabled"].as_bool())
            == Some(true)
    }

    pub(crate) fn update(&self, params: Value) -> Result<Value, AppIpcError> {
        let settings = serde_json::from_value::<Settings>(params)
            .map_err(|error| AppIpcError::new("invalid_params", error.to_string()))?;
        let bytes =
            serde_json::to_vec(&settings).map_err(|error| access_error(error.to_string()))?;
        atomic_write_file(&self.path, &bytes).map_err(|error| access_error(error.to_string()))?;
        CHANGED.get_or_init(Notify::new).notify_one();
        Ok(json!({"enabled": settings.enabled}))
    }

    pub(crate) fn authorize(
        &self,
        method: &str,
        access_scope: Option<&str>,
    ) -> Result<(), AppIpcError> {
        let project_method = matches!(
            method,
            "runtime.tasks.send" | "runtime.tasks.transcript" | "runtime.tasks.transcript.search"
        );
        if method == "runtime.runner.catalog"
            || (access_scope == Some("project-session") && project_method)
            || (access_scope == Some("stand-in-conversation")
                && method == "runtime.stand_in.conversation")
            || (TASK_METHODS.contains(&method) && self.enabled())
        {
            return Ok(());
        }
        Err(AppIpcError::new(
            "remote_control_disabled",
            "Remote task access is disabled on this computer or does not allow this operation",
        ))
    }
}

pub(crate) async fn changed() {
    CHANGED.get_or_init(Notify::new).notified().await;
}

fn access_error(message: String) -> AppIpcError {
    AppIpcError::new("remote_task_access_failed", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_is_local_persistent_and_revoked_for_existing_readers() {
        let root = tempfile::tempdir().unwrap();
        let a = RemoteTaskAccess::new(root.path().join("a/settings.json"));
        let b = RemoteTaskAccess::new(root.path().join("b/settings.json"));
        let existing_reader = a.clone();
        assert!(!a.enabled());
        assert!(a.authorize("runtime.tasks.list", None).is_err());
        a.update(json!({"enabled": true})).unwrap();
        assert!(existing_reader
            .authorize("runtime.tasks.list", None)
            .is_ok());
        assert!(existing_reader
            .authorize("runtime.tasks.send", None)
            .is_ok());
        assert!(!b.enabled());
        assert!(RemoteTaskAccess::new(a.path.clone()).enabled());
        a.update(json!({"enabled": false})).unwrap();
        assert!(existing_reader
            .authorize("runtime.tasks.send", None)
            .is_err());
    }

    #[test]
    fn task_creation_requires_current_consent_on_the_target_installation() {
        let root = tempfile::tempdir().unwrap();
        let access = RemoteTaskAccess::new(root.path().join("a/settings.json"));
        let peer = RemoteTaskAccess::new(root.path().join("b/settings.json"));
        let reader = access.clone();
        let method = "runtime.tasks.create";
        assert!(reader.authorize(method, None).is_err());
        assert!(reader.authorize(method, Some("project-session")).is_err());
        access.update(json!({"enabled": true})).unwrap();
        assert!(reader.authorize(method, None).is_ok());
        assert!(peer.authorize(method, None).is_err());
        access.update(json!({"enabled": false})).unwrap();
        assert!(reader.authorize(method, None).is_err());
    }

    #[test]
    fn consent_never_allows_configuration_or_shell_commands() {
        let root = tempfile::tempdir().unwrap();
        let access = RemoteTaskAccess::new(root.path().join("settings.json"));
        access.update(json!({"enabled": true})).unwrap();
        for method in [
            "executor.remote_task_access.update",
            "executor.backend.configure",
            "runtime.settings.update",
            "runtime.codex.app_server.request",
            "device.execute_command",
        ] {
            assert!(access.authorize(method, None).is_err(), "{method}");
            assert!(
                access.authorize(method, Some("project-session")).is_err(),
                "{method}"
            );
        }
        access.update(json!({"enabled": false})).unwrap();
        assert!(access
            .authorize("runtime.tasks.transcript", Some("project-session"))
            .is_ok());
        assert!(access
            .authorize("runtime.tasks.list", Some("project-session"))
            .is_err());
    }

    #[test]
    fn stand_in_grant_is_required_and_cannot_authorize_other_operations() {
        let root = tempfile::tempdir().unwrap();
        let access = RemoteTaskAccess::new(root.path().join("settings.json"));
        for enabled in [false, true] {
            access.update(json!({"enabled": enabled})).unwrap();
            for scope in [None, Some("project-session"), Some("unknown")] {
                assert!(access
                    .authorize("runtime.stand_in.conversation", scope)
                    .is_err());
            }
            assert!(access
                .authorize(
                    "runtime.stand_in.conversation",
                    Some("stand-in-conversation")
                )
                .is_ok());
        }
        access.update(json!({"enabled": false})).unwrap();
        for method in TASK_METHODS.iter().copied().chain([
            "runtime.stand_in.personal.save",
            "executor.remote_task_access.update",
            "executor.backend.configure",
            "runtime.settings.update",
            "runtime.codex.app_server.request",
            "device.execute_command",
        ]) {
            assert!(
                access
                    .authorize(method, Some("stand-in-conversation"))
                    .is_err(),
                "{method}"
            );
        }
    }

    #[test]
    fn invalid_or_unreadable_consent_never_grants_access() {
        let root = tempfile::tempdir().unwrap();
        let access = RemoteTaskAccess::new(root.path().join("settings.json"));
        for contents in ["", "{}", "{\"enabled\":\"true\"}", "{\"enabled\":1}"] {
            fs::write(&access.path, contents).unwrap();
            assert!(!access.enabled());
        }
        assert!(access.update(json!({"enabled": "true"})).is_err());
        assert!(access
            .update(json!({"enabled": true, "deviceId": "other"}))
            .is_err());
    }
}
