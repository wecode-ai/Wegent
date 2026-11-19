//! Metadata-only observations for the existing isolated authentication E2E harness.
use super::AuthError;
use serde_json::json;
use std::{fs::OpenOptions, io::Write, path::PathBuf, sync::Mutex};

static WRITER: Mutex<()> = Mutex::new(());

pub(super) fn path(marker: Option<PathBuf>) -> Option<PathBuf> {
    marker.map(|marker| {
        let mut value = marker.into_os_string();
        value.push(".enrollments.jsonl");
        PathBuf::from(value)
    })
}

pub(super) struct Enrollment {
    path: Option<PathBuf>,
    attempt_id: String,
    installed_plugin_id: u64,
    connector_slug: String,
    finished: bool,
}

impl Enrollment {
    pub(super) fn start(
        path: Option<PathBuf>,
        installed_plugin_id: u64,
        connector_slug: &str,
    ) -> Self {
        let attempt_id = path
            .as_ref()
            .map(|_| uuid::Uuid::new_v4().to_string())
            .unwrap_or_default();
        let observation = Self {
            path,
            attempt_id,
            installed_plugin_id,
            connector_slug: connector_slug.to_owned(),
            finished: false,
        };
        observation.record("started", None);
        observation
    }

    pub(super) fn requesting(&self) {
        self.record("requesting", None);
    }

    pub(super) fn finish(&mut self, result: &Result<(), AuthError>) {
        self.record("finished", Some(result));
        self.finished = true;
    }

    fn record(&self, phase: &str, result: Option<&Result<(), AuthError>>) {
        let Some(path) = &self.path else { return };
        let Ok(_guard) = WRITER.lock() else { return };
        let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
            return;
        };
        let event = json!({
            "attempt_id": self.attempt_id,
            "installed_plugin_id": self.installed_plugin_id,
            "connector_slug": self.connector_slug,
            "phase": phase,
            "ok": result.map(Result::is_ok),
            "code": result.and_then(|result| result.as_ref().err()).map(|error| error.0),
        });
        let _ = writeln!(file, "{event}");
    }
}

impl Drop for Enrollment {
    fn drop(&mut self) {
        if !self.finished {
            self.record("finished", Some(&Err(AuthError("plugin_auth_cancelled"))));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_and_failed_attempts_have_one_unsuccessful_completion() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("enrollments.jsonl");
        {
            let cancelled = Enrollment::start(Some(path.clone()), 42, "mail");
            cancelled.requesting();
        }
        {
            let mut failed = Enrollment::start(Some(path.clone()), 42, "mail");
            failed.requesting();
            failed.finish(&Err(AuthError("plugin_auth_transport_failed")));
        }
        let events: Vec<serde_json::Value> = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let finished: Vec<_> = events
            .iter()
            .filter(|event| event["phase"] == "finished")
            .collect();
        assert_eq!(finished.len(), 2);
        assert_eq!(finished[0]["code"], "plugin_auth_cancelled");
        assert_eq!(finished[1]["code"], "plugin_auth_transport_failed");
        for (index, event) in finished.iter().enumerate() {
            assert_eq!(event["ok"], false);
            assert_eq!(event["attempt_id"], events[index * 3]["attempt_id"]);
            assert_eq!(event["installed_plugin_id"], 42);
            assert_eq!(event["connector_slug"], "mail");
        }
    }
}
