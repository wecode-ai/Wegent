// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::logging::log_executor_event;

type LogFields = Vec<(&'static str, String)>;
type LogObservation = fn(&str, &[(&'static str, String)]);

#[derive(Clone)]
pub(super) struct CodexConfigDiagnosticTarget {
    config_path: PathBuf,
    process_id: Option<u32>,
}

impl CodexConfigDiagnosticTarget {
    pub(super) fn new(home: PathBuf, process_id: Option<u32>) -> Self {
        Self {
            config_path: home.join("config.toml"),
            process_id,
        }
    }

    fn metadata_fields(&self) -> LogFields {
        match fs::metadata(&self.config_path) {
            Ok(metadata) => {
                let mut fields = vec![
                    ("exists", "true".to_owned()),
                    ("bytes", metadata.len().to_string()),
                    ("is_file", metadata.is_file().to_string()),
                ];
                if let Some(modified) = metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                {
                    fields.push(("mtime_ns", modified.as_nanos().to_string()));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    fields.push(("inode", metadata.ino().to_string()));
                }
                fields
            }
            Err(error) => vec![
                (
                    "exists",
                    if error.kind() == std::io::ErrorKind::NotFound {
                        "false"
                    } else {
                        "unknown"
                    }
                    .to_owned(),
                ),
                ("metadata_error_kind", format!("{:?}", error.kind())),
            ],
        }
    }
}

pub(super) struct CodexConfigObservation {
    target: CodexConfigDiagnosticTarget,
    method: &'static str,
    request_id: Option<u64>,
    scope: &'static str,
    logger: LogObservation,
    finished: bool,
}

impl CodexConfigObservation {
    pub(super) fn request(
        target: &CodexConfigDiagnosticTarget,
        method: &str,
        request_id: u64,
    ) -> Option<Self> {
        Some(Self::begin(
            target,
            observed_method(method)?,
            Some(request_id),
            "rpc",
            log_executor_event,
        ))
    }

    pub(super) fn stop(target: &CodexConfigDiagnosticTarget) -> Self {
        Self::begin(target, "process/stop", None, "process", log_executor_event)
    }

    fn begin(
        target: &CodexConfigDiagnosticTarget,
        method: &'static str,
        request_id: Option<u64>,
        scope: &'static str,
        logger: LogObservation,
    ) -> Self {
        let observation = Self {
            target: target.clone(),
            method,
            request_id,
            scope,
            logger,
            finished: false,
        };
        observation.emit("before", "pending");
        observation
    }

    pub(super) fn finish(mut self, outcome: &'static str) {
        self.emit("after", outcome);
        self.finished = true;
    }

    fn emit(&self, phase: &'static str, outcome: &'static str) {
        let mut fields = vec![
            ("scope", self.scope.to_owned()),
            ("method", self.method.to_owned()),
            ("phase", phase.to_owned()),
            ("outcome", outcome.to_owned()),
            (
                "process_id",
                self.target
                    .process_id
                    .map(|id| id.to_string())
                    .unwrap_or_default(),
            ),
        ];
        if let Ok(observed_at) = SystemTime::now().duration_since(UNIX_EPOCH) {
            fields.push(("observed_at_ms", observed_at.as_millis().to_string()));
        }
        if let Some(request_id) = self.request_id {
            fields.push(("request_id", request_id.to_string()));
        }
        fields.extend(self.target.metadata_fields());
        (self.logger)("codex config file observation", &fields);
    }
}

impl Drop for CodexConfigObservation {
    fn drop(&mut self) {
        if !self.finished {
            self.emit("after", "dropped");
        }
    }
}

pub(super) fn observed_method(method: &str) -> Option<&'static str> {
    Some(match method {
        "config/value/write" => "config/value/write",
        "config/batchWrite" => "config/batchWrite",
        "skills/config/write" => "skills/config/write",
        "marketplace/add" => "marketplace/add",
        "marketplace/remove" => "marketplace/remove",
        "marketplace/upgrade" => "marketplace/upgrade",
        // Observe discovery during marketplace reconciliation as well.
        "plugin/list" => "plugin/list",
        "plugin/install" => "plugin/install",
        "plugin/uninstall" => "plugin/uninstall",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::agents::codex::{codex_home_for_launch_config, CodexLaunchConfig, CODEX_HOME_ENV};

    static EVENTS: Mutex<Vec<LogFields>> = Mutex::new(Vec::new());

    fn record(_event: &str, fields: &[(&'static str, String)]) {
        EVENTS.lock().unwrap().push(fields.to_vec());
    }

    fn field<'a>(fields: &'a [(&str, String)], key: &str) -> Option<&'a str> {
        fields
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value.as_str())
    }

    fn events(request_id: u64) -> Vec<LogFields> {
        EVENTS
            .lock()
            .unwrap()
            .iter()
            .filter(|fields| field(fields, "request_id") == Some(request_id.to_string().as_str()))
            .cloned()
            .collect()
    }

    #[test]
    fn observes_only_selected_native_configuration_methods() {
        for method in [
            "config/value/write",
            "config/batchWrite",
            "skills/config/write",
            "marketplace/add",
            "marketplace/remove",
            "marketplace/upgrade",
            "plugin/list",
            "plugin/install",
            "plugin/uninstall",
        ] {
            assert_eq!(observed_method(method), Some(method));
        }
        for method in [
            "config/read",
            "plugin/read",
            "thread/start",
            "account/login/start",
        ] {
            assert_eq!(observed_method(method), None);
        }
    }

    #[test]
    fn metadata_contains_no_config_contents_or_home_path() {
        let home = tempfile::tempdir().unwrap();
        let content = "secret-config-value-that-must-not-be-logged";
        fs::write(home.path().join("config.toml"), content).unwrap();
        let target = CodexConfigDiagnosticTarget::new(home.path().to_path_buf(), Some(1));
        let fields = target.metadata_fields();

        assert_eq!(field(&fields, "exists"), Some("true"));
        assert_eq!(
            field(&fields, "bytes"),
            Some(content.len().to_string().as_str())
        );
        assert!(field(&fields, "mtime_ns").is_some());
        #[cfg(unix)]
        assert!(field(&fields, "inode").is_some());
        let rendered = format!("{fields:?}");
        assert!(!rendered.contains(content));
        assert!(!rendered.contains(home.path().to_str().unwrap()));
    }

    #[test]
    fn distinguishes_missing_config_from_an_empty_file() {
        let home = tempfile::tempdir().unwrap();
        let target = CodexConfigDiagnosticTarget::new(home.path().to_path_buf(), None);
        assert_eq!(field(&target.metadata_fields(), "exists"), Some("false"));
        fs::write(home.path().join("config.toml"), "").unwrap();
        let fields = target.metadata_fields();
        assert_eq!(field(&fields, "exists"), Some("true"));
        assert_eq!(field(&fields, "bytes"), Some("0"));
    }

    #[test]
    fn finished_requests_log_one_after_observation_for_every_outcome() {
        let home = tempfile::tempdir().unwrap();
        let target = CodexConfigDiagnosticTarget::new(home.path().to_path_buf(), Some(7));
        for (request_id, outcome) in [(101, "ok"), (102, "error"), (103, "send_error")] {
            let observation = CodexConfigObservation::begin(
                &target,
                "marketplace/add",
                Some(request_id),
                "rpc",
                record,
            );
            fs::write(home.path().join("config.toml"), "").unwrap();
            observation.finish(outcome);
            let captured = events(request_id);
            assert_eq!(captured.len(), 2);
            assert_eq!(field(&captured[0], "phase"), Some("before"));
            assert_eq!(field(&captured[1], "phase"), Some("after"));
            assert_eq!(field(&captured[1], "outcome"), Some(outcome));
            assert_eq!(field(&captured[1], "bytes"), Some("0"));
        }
    }

    #[test]
    fn dropped_request_observes_the_file_after_cancellation() {
        let home = tempfile::tempdir().unwrap();
        fs::write(home.path().join("config.toml"), "initial").unwrap();
        let target = CodexConfigDiagnosticTarget::new(home.path().to_path_buf(), Some(8));
        let observation =
            CodexConfigObservation::begin(&target, "config/batchWrite", Some(104), "rpc", record);
        fs::write(home.path().join("config.toml"), "").unwrap();
        drop(observation);

        let captured = events(104);
        assert_eq!(captured.len(), 2);
        assert_eq!(field(&captured[0], "bytes"), Some("7"));
        assert_eq!(field(&captured[1], "outcome"), Some("dropped"));
        assert_eq!(field(&captured[1], "bytes"), Some("0"));
    }

    #[test]
    fn explicit_launch_home_is_the_observed_home() {
        let home = tempfile::tempdir().unwrap();
        fs::write(home.path().join("config.toml"), "dedicated-home").unwrap();
        let mut launch_config = CodexLaunchConfig::default();
        launch_config
            .env
            .insert(CODEX_HOME_ENV.to_owned(), home.path().display().to_string());
        let target =
            CodexConfigDiagnosticTarget::new(codex_home_for_launch_config(&launch_config), Some(9));

        assert_eq!(target.config_path, home.path().join("config.toml"));
        assert_eq!(field(&target.metadata_fields(), "bytes"), Some("14"));
    }
}
