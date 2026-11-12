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

mod storage;

pub(super) struct PendingTerminals {
    pub events: Vec<Value>,
    pub persistence_error: Option<String>,
}

#[derive(Default)]
pub(super) struct TerminalEventJournal {
    accounts: BTreeMap<String, AccountJournal>,
    root: Option<PathBuf>,
}

#[derive(Default)]
struct AccountJournal {
    pending: BTreeMap<u64, Value>,
    persisted: BTreeSet<u64>,
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

    pub fn bind(&mut self, account: &str) -> Result<u64, String> {
        let journal = self.flush(account)?;
        Ok(journal
            .pending
            .keys()
            .next_back()
            .copied()
            .unwrap_or_default())
    }

    pub fn retain(&mut self, account: &str, event: &Value) -> Result<(), String> {
        if is_terminal(event) {
            let sequence = event_sequence(event).ok_or("Terminal event has no sequence")?;
            self.accounts
                .entry(account.to_owned())
                .or_default()
                .pending
                .insert(sequence, event.clone());
            self.flush(account)?;
        }
        Ok(())
    }

    pub fn pending(&mut self, account: &str) -> PendingTerminals {
        let persistence_error = self.flush(account).err();
        PendingTerminals {
            events: self.accounts[account].pending.values().cloned().collect(),
            persistence_error,
        }
    }

    pub fn retry_storage(&mut self) -> Vec<(String, Option<String>)> {
        let accounts = self.accounts.keys().cloned().collect::<Vec<_>>();
        accounts
            .into_iter()
            .map(|account| {
                let error = self.flush(&account).err();
                (account, error)
            })
            .collect()
    }

    pub fn acknowledge(&mut self, account: &str, event: &Value) -> Result<(), String> {
        if !is_terminal(event) {
            return Ok(());
        }
        let sequence = event_sequence(event).ok_or("Terminal event has no sequence")?;
        let journal = self.accounts.entry(account.to_owned()).or_default();
        if journal.pending.get(&sequence) != Some(event) {
            return Err("Terminal acknowledgement does not match its account and event".to_owned());
        }
        if let Some(root) = self
            .root
            .as_ref()
            .filter(|_| journal.persisted.contains(&sequence))
        {
            let directory = root.join(account);
            match fs::remove_file(directory.join(format!("{sequence}.json"))) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Cannot acknowledge terminal event: {error}")),
            }
        }
        journal.pending.remove(&sequence);
        journal.persisted.remove(&sequence);
        Ok(())
    }

    fn flush(&mut self, account: &str) -> Result<&mut AccountJournal, String> {
        let journal = self.accounts.entry(account.to_owned()).or_default();
        let Some(root) = &self.root else {
            return Ok(journal);
        };
        let directory = root.join(account);
        storage::private_directory(root).map_err(storage_error)?;
        storage::private_directory(&directory).map_err(storage_error)?;
        if !journal.loaded {
            for entry in fs::read_dir(&directory).map_err(storage_error)? {
                let entry = entry.map_err(storage_error)?;
                let path = entry.path();
                storage::private_file(&path).map_err(storage_error)?;
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
                if journal
                    .pending
                    .get(&sequence)
                    .is_some_and(|pending| pending != &event)
                {
                    return Err(
                        "Terminal event journal sequence conflicts with retained data".into(),
                    );
                }
                journal.pending.entry(sequence).or_insert(event);
                journal.persisted.insert(sequence);
            }
            journal.loaded = true;
        }
        for (sequence, event) in &journal.pending {
            let path = directory.join(format!("{sequence}.json"));
            if !journal.persisted.contains(sequence) {
                let bytes = serde_json::to_vec(event).map_err(|error| error.to_string())?;
                storage::write_event(&path, &bytes).map_err(storage_error)?;
                journal.persisted.insert(*sequence);
            }
        }
        Ok(journal)
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
        journal.bind("account-a").unwrap();
        journal.retain("account-a", &event).unwrap();
        drop(journal);

        let mut reopened = TerminalEventJournal::default();
        reopened.enable(root.path().to_owned());
        reopened.bind("account-a").unwrap();
        assert_eq!(reopened.pending("account-a").events, vec![event.clone()]);
        reopened.acknowledge("account-a", &event).unwrap();
        drop(reopened);

        let mut reopened = TerminalEventJournal::default();
        reopened.enable(root.path().to_owned());
        reopened.bind("account-a").unwrap();
        assert!(reopened.pending("account-a").events.is_empty());
    }

    #[test]
    fn account_switches_preserve_each_accounts_pending_events() {
        let root = tempfile::tempdir().unwrap();
        let first = json!({"event":"response.completed","sequence":10});
        let second = json!({"event":"response.completed","sequence":11});
        let mut journal = TerminalEventJournal::default();
        journal.enable(root.path().to_owned());
        journal.bind("account-a").unwrap();
        journal.retain("account-a", &first).unwrap();
        assert_eq!(journal.bind("account-b").unwrap(), 0);
        assert!(journal.pending("account-b").events.is_empty());
        journal.retain("account-b", &second).unwrap();
        assert_eq!(journal.bind("account-a").unwrap(), 10);
        assert_eq!(journal.pending("account-a").events, vec![first]);
        assert_eq!(journal.bind("account-b").unwrap(), 11);
        assert_eq!(journal.pending("account-b").events, vec![second]);
    }

    #[test]
    fn unreadable_storage_does_not_discard_pending_events() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("events");
        fs::write(&directory, b"unavailable").unwrap();
        let event = json!({"event":"response.failed","sequence":42});
        let mut journal = TerminalEventJournal::default();
        journal.enable(directory.clone());
        assert!(journal.bind("account-a").is_err());
        assert!(journal.retain("account-a", &event).is_err());
        let pending = journal.pending("account-a");
        assert!(pending.persistence_error.is_some());
        assert_eq!(pending.events, vec![event.clone()]);
        fs::remove_file(&directory).unwrap();
        assert_eq!(journal.pending("account-a").events, vec![event]);
    }

    #[cfg(unix)]
    #[test]
    fn journal_files_and_directories_are_private_including_existing_records() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("journal");
        let account = directory.join("account-a");
        let path = account.join("41.json");
        let event = json!({"event":"response.completed","sequence":41});
        let mut journal = TerminalEventJournal::default();
        journal.enable(directory.clone());
        journal.retain("account-a", &event).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(journal);
        for (path, mode) in [(&directory, 0o755), (&account, 0o755), (&path, 0o644)] {
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        }
        let mut reopened = TerminalEventJournal::default();
        reopened.enable(directory.clone());
        assert_eq!(reopened.pending("account-a").events, vec![event]);
        for (path, mode) in [(&directory, 0o700), (&account, 0o700), (&path, 0o600)] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn journal_rejects_symlinked_payloads_without_changing_targets() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("outside.json");
        fs::write(&target, "outside").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        let mut journal = TerminalEventJournal::default();
        journal.enable(root.path().join("journal"));
        journal.bind("account-a").unwrap();
        drop(journal);
        symlink(&target, root.path().join("journal/account-a/41.json")).unwrap();
        let mut journal = TerminalEventJournal::default();
        journal.enable(root.path().join("journal"));
        let error = journal.pending("account-a").persistence_error.unwrap();
        assert!(error.contains("regular file"), "{error}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "outside");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[test]
    fn an_unpersisted_ack_cannot_delete_an_older_conflicting_record() {
        let root = tempfile::tempdir().unwrap();
        let original =
            json!({"event":"response.completed","sequence":41,"payload":{"taskId":"old"}});
        let newer = json!({"event":"response.completed","sequence":41,"payload":{"taskId":"new"}});
        let mut journal = TerminalEventJournal::default();
        journal.enable(root.path().to_owned());
        journal.retain("account-a", &original).unwrap();
        drop(journal);
        let mut reopened = TerminalEventJournal::default();
        reopened.enable(root.path().to_owned());
        assert!(reopened.retain("account-a", &newer).is_err());
        let pending = reopened.pending("account-a");
        assert!(pending.persistence_error.is_some());
        assert_eq!(pending.events, vec![newer.clone()]);
        reopened.acknowledge("account-a", &newer).unwrap();
        assert_eq!(reopened.pending("account-a").events, vec![original]);
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
        assert!(journal.bind("account-a").is_err());
        assert!(journal.retain("account-a", &first).is_err());
        journal.bind("account-b").unwrap();
        assert!(journal.pending("account-b").events.is_empty());
        journal.retain("account-b", &second).unwrap();
        fs::remove_file(blocked).unwrap();
        journal.bind("account-a").unwrap();
        assert_eq!(journal.pending("account-a").events, vec![first.clone()]);
        drop(journal);

        let mut reopened = TerminalEventJournal::default();
        reopened.enable(root.path().to_owned());
        reopened.bind("account-a").unwrap();
        assert_eq!(reopened.pending("account-a").events, vec![first]);
        reopened.bind("account-b").unwrap();
        assert_eq!(reopened.pending("account-b").events, vec![second]);
    }

    #[test]
    fn late_events_and_acknowledgements_keep_their_account_after_a_switch() {
        let root = tempfile::tempdir().unwrap();
        let first = json!({"event":"response.completed","sequence":41,"payload":{"taskId":"a"}});
        let second = json!({"event":"response.completed","sequence":41,"payload":{"taskId":"b"}});
        let mut journal = TerminalEventJournal::default();
        journal.enable(root.path().to_owned());
        journal.bind("account-a").unwrap();
        journal.bind("account-b").unwrap();
        journal.retain("account-a", &first).unwrap();
        journal.retain("account-b", &second).unwrap();
        assert!(journal.acknowledge("account-b", &first).is_err());
        journal.acknowledge("account-a", &first).unwrap();
        assert_eq!(journal.pending("account-b").events, vec![second.clone()]);
        drop(journal);
        let mut reopened = TerminalEventJournal::default();
        reopened.enable(root.path().to_owned());
        assert!(reopened.pending("account-a").events.is_empty());
        assert_eq!(reopened.pending("account-b").events, vec![second]);
    }
}
