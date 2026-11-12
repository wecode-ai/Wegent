// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Retain terminal events until the backend acknowledges durable acceptance.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};

use serde_json::Value;

use super::event_stream::event_sequence;

#[derive(Default)]
pub(super) struct TerminalEventJournal {
    pending: BTreeMap<u64, Value>,
    suspended: BTreeMap<String, BTreeMap<u64, Value>>,
    persisted: BTreeSet<u64>,
    root: Option<PathBuf>,
    directory: Option<PathBuf>,
    scope: Option<String>,
    loaded: bool,
}

pub(super) fn is_terminal(event: &Value) -> bool {
    matches!(
        event["event"].as_str(),
        Some("response.completed" | "response.failed" | "response.incomplete" | "error")
    )
}

impl TerminalEventJournal {
    pub fn enable(&mut self, directory: PathBuf) {
        self.root = Some(directory);
    }

    pub fn bind(&mut self, scope: String) -> Result<u64, String> {
        let Some(root) = &self.root else { return Ok(0) };
        if self.scope.as_ref() != Some(&scope) {
            if let Some(previous) = &self.scope {
                // Preserve even events whose disk writes failed, without
                // exposing them to the account that is connecting next.
                self.suspended
                    .insert(previous.clone(), std::mem::take(&mut self.pending));
                self.pending = self.suspended.remove(&scope).unwrap_or_default();
            }
            self.persisted.clear();
            self.directory = Some(root.join(&scope));
            self.scope = Some(scope);
            self.loaded = false;
        }
        self.flush()?;
        Ok(self.pending.keys().next_back().copied().unwrap_or_default())
    }

    pub fn retain(&mut self, event: &Value) -> Result<(), String> {
        if is_terminal(event) {
            let sequence = event_sequence(event).ok_or("Terminal event has no sequence")?;
            self.pending.insert(sequence, event.clone());
            self.flush()?;
        }
        Ok(())
    }

    pub fn pending(&mut self) -> Result<Vec<Value>, String> {
        self.flush()?;
        Ok(self.pending.values().cloned().collect())
    }

    pub fn acknowledge(&mut self, event: &Value) -> Result<(), String> {
        if !is_terminal(event) {
            return Ok(());
        }
        let sequence = event_sequence(event).ok_or("Terminal event has no sequence")?;
        if let Some(directory) = &self.directory {
            match fs::remove_file(directory.join(format!("{sequence}.json"))) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Cannot acknowledge terminal event: {error}")),
            }
        }
        self.pending.remove(&sequence);
        self.persisted.remove(&sequence);
        Ok(())
    }

    fn flush(&mut self) -> Result<(), String> {
        let Some(directory) = &self.directory else {
            return Ok(());
        };
        fs::create_dir_all(directory).map_err(storage_error)?;
        if !self.loaded {
            for entry in fs::read_dir(directory).map_err(storage_error)? {
                let entry = entry.map_err(storage_error)?;
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("json") {
                    continue;
                }
                let event: Value = serde_json::from_slice(&fs::read(&path).map_err(storage_error)?)
                    .map_err(|_| "Invalid terminal event journal".to_owned())?;
                let sequence = event_sequence(&event)
                    .filter(|_| is_terminal(&event))
                    .ok_or("Invalid terminal event journal identity")?;
                if path.file_stem().and_then(|value| value.to_str()) != Some(&sequence.to_string())
                {
                    return Err("Invalid terminal event journal filename".to_owned());
                }
                self.pending.entry(sequence).or_insert(event);
                self.persisted.insert(sequence);
            }
            self.loaded = true;
        }
        for (sequence, event) in &self.pending {
            let path = directory.join(format!("{sequence}.json"));
            if !self.persisted.contains(sequence) {
                let bytes = serde_json::to_vec(event).map_err(|error| error.to_string())?;
                crate::runtime_work::store::atomic_write_file(&path, &bytes)
                    .map_err(storage_error)?;
                self.persisted.insert(*sequence);
            }
        }
        Ok(())
    }
}

fn storage_error(error: std::io::Error) -> String {
    format!("Terminal event journal unavailable: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_restart_retains_only_unacknowledged_terminal_events() {
        let root = tempfile::tempdir().unwrap();
        let event = json!({"event":"response.completed","sequence":41,"payload":{"taskId":"a"}});
        let mut journal = TerminalEventJournal::default();
        journal.enable(root.path().to_owned());
        journal.bind("account-a".to_owned()).unwrap();
        journal.retain(&event).unwrap();
        drop(journal);

        let mut reopened = TerminalEventJournal::default();
        reopened.enable(root.path().to_owned());
        reopened.bind("account-a".to_owned()).unwrap();
        assert_eq!(reopened.pending().unwrap(), vec![event.clone()]);
        reopened.acknowledge(&event).unwrap();
        drop(reopened);

        let mut reopened = TerminalEventJournal::default();
        reopened.enable(root.path().to_owned());
        reopened.bind("account-a".to_owned()).unwrap();
        assert!(reopened.pending().unwrap().is_empty());
    }

    #[test]
    fn account_switches_preserve_each_accounts_pending_events() {
        let root = tempfile::tempdir().unwrap();
        let first = json!({"event":"response.completed","sequence":10});
        let second = json!({"event":"response.completed","sequence":11});
        let mut journal = TerminalEventJournal::default();
        journal.enable(root.path().to_owned());
        journal.bind("account-a".to_owned()).unwrap();
        journal.retain(&first).unwrap();
        assert_eq!(journal.bind("account-b".to_owned()).unwrap(), 0);
        assert!(journal.pending().unwrap().is_empty());
        journal.retain(&second).unwrap();
        assert_eq!(journal.bind("account-a".to_owned()).unwrap(), 10);
        assert_eq!(journal.pending().unwrap(), vec![first]);
        assert_eq!(journal.bind("account-b".to_owned()).unwrap(), 11);
        assert_eq!(journal.pending().unwrap(), vec![second]);
    }

    #[test]
    fn unreadable_storage_does_not_discard_pending_events() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("events");
        fs::write(&directory, b"unavailable").unwrap();
        let event = json!({"event":"response.failed","sequence":42});
        let mut journal = TerminalEventJournal::default();
        journal.enable(directory.clone());
        assert!(journal.bind("account-a".to_owned()).is_err());
        assert!(journal.retain(&event).is_err());
        assert!(journal.pending().is_err());
        fs::remove_file(&directory).unwrap();
        assert_eq!(journal.pending().unwrap(), vec![event]);
    }

    #[test]
    fn account_switches_retain_unwritten_events_without_sharing_them() {
        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("account-a");
        fs::write(&blocked, b"unavailable").unwrap();
        let first = json!({"event":"response.failed","sequence":41});
        let second = json!({"event":"response.completed","sequence":42});
        let mut journal = TerminalEventJournal::default();
        journal.enable(root.path().to_owned());
        assert!(journal.bind("account-a".to_owned()).is_err());
        assert!(journal.retain(&first).is_err());
        journal.bind("account-b".to_owned()).unwrap();
        assert!(journal.pending().unwrap().is_empty());
        journal.retain(&second).unwrap();
        fs::remove_file(blocked).unwrap();
        journal.bind("account-a".to_owned()).unwrap();
        assert_eq!(journal.pending().unwrap(), vec![first.clone()]);
        drop(journal);

        let mut reopened = TerminalEventJournal::default();
        reopened.enable(root.path().to_owned());
        reopened.bind("account-a".to_owned()).unwrap();
        assert_eq!(reopened.pending().unwrap(), vec![first]);
        reopened.bind("account-b".to_owned()).unwrap();
        assert_eq!(reopened.pending().unwrap(), vec![second]);
    }
}
