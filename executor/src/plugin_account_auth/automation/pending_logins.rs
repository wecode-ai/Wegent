// SPDX-License-Identifier: Apache-2.0
//! Owner-scoped login reservations shared by the reconciliation lanes.

use super::{retry_delay, DISCOVERY_BATCH_SIZE};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    sync::{Mutex as AsyncMutex, Notify},
    time::Instant,
};

pub(super) type Target = (u64, String);

#[derive(Default)]
pub(in crate::plugin_account_auth) struct PendingLogins {
    state: Mutex<PendingLoginState>,
    ready: Notify,
}

#[derive(Default)]
struct PendingLoginState {
    revision: u64,
    entries: HashMap<Target, PendingLogin>,
    processing: HashSet<Target>,
    actions: HashMap<u64, Weak<AsyncMutex<()>>>,
    registered: HashMap<Target, Instant>,
}

struct PendingLogin {
    ready_at: Instant,
    failures: u32,
    reserved: bool,
}

pub(in crate::plugin_account_auth) struct PendingLoginBatch {
    logins: Arc<PendingLogins>,
    pub(super) revision: u64,
    entries: HashMap<Target, u32>,
}

#[derive(Clone, Copy)]
pub(super) enum LoginOutcome {
    Finished,
    Registered,
    RetryDiscovery,
    RetryRegistration,
}

impl PendingLoginBatch {
    pub(super) fn targets(&self) -> impl Iterator<Item = &Target> {
        self.entries.keys()
    }

    pub(super) fn contains(&self, key: &Target) -> bool {
        self.entries.contains_key(key)
    }

    pub(super) fn finish(&mut self, key: &Target, outcome: LoginOutcome) {
        let Some(failures) = self.entries.remove(key) else {
            return;
        };
        let mut state = self.logins.state.lock().expect("pending plugin logins");
        if state.revision != self.revision {
            return;
        }
        // A newer login already queued for this target takes precedence.
        if !state.entries.contains_key(key) {
            let now = Instant::now();
            match outcome {
                LoginOutcome::Finished => {}
                LoginOutcome::Registered => {
                    state.registered.retain(|_, deadline| *deadline > now);
                    state
                        .registered
                        .insert(key.clone(), now + Duration::from_secs(60));
                }
                LoginOutcome::RetryDiscovery | LoginOutcome::RetryRegistration => {
                    let failures = failures.saturating_add(1);
                    state.entries.insert(
                        key.clone(),
                        PendingLogin {
                            ready_at: now + retry_delay(failures),
                            failures,
                            reserved: matches!(outcome, LoginOutcome::RetryDiscovery),
                        },
                    );
                }
            }
        }
        state.processing.remove(key);
        self.logins.ready.notify_one();
    }

    pub(super) fn finish_remaining(&mut self, outcome: LoginOutcome) {
        let remaining: Vec<_> = self.entries.keys().cloned().collect();
        for key in remaining {
            self.finish(&key, outcome);
        }
    }
}

impl Drop for PendingLoginBatch {
    fn drop(&mut self) {
        let mut state = self.logins.state.lock().expect("pending plugin logins");
        if state.revision == self.revision {
            for key in self.entries.keys() {
                state.processing.remove(key);
            }
        }
    }
}

impl PendingLogins {
    pub(in crate::plugin_account_auth) fn submit(&self, installed_id: u64, connector_slug: String) {
        let mut state = self.state.lock().expect("pending plugin logins");
        let key = (installed_id, connector_slug);
        state.registered.remove(&key);
        state.entries.insert(
            key,
            PendingLogin {
                ready_at: Instant::now(),
                failures: 0,
                reserved: true,
            },
        );
        self.ready.notify_one();
    }

    pub(in crate::plugin_account_auth) async fn notified(&self) {
        self.ready.notified().await;
    }

    pub(in crate::plugin_account_auth) fn wake(&self) {
        self.ready.notify_one();
    }

    pub(in crate::plugin_account_auth) fn next_ready(&self) -> Option<Instant> {
        let state = self.state.lock().expect("pending plugin logins");
        state
            .entries
            .iter()
            .filter(|(key, _)| !state.processing.contains(*key))
            .map(|(_, entry)| entry.ready_at)
            .min()
    }

    pub(in crate::plugin_account_auth) fn clear_owner(&self) {
        let mut state = self.state.lock().expect("pending plugin logins");
        state.revision += 1;
        state.entries.clear();
        state.processing.clear();
        state.actions.clear();
        state.registered.clear();
    }

    pub(super) fn invalidate_registrations(&self, revision: u64, id: Option<u64>) {
        let mut state = self.state.lock().expect("pending plugin logins");
        if state.revision == revision {
            state
                .registered
                .retain(|(target, _), _| id.is_some_and(|id| *target != id));
        }
    }

    pub(super) fn recently_registered(&self, revision: u64, key: &Target) -> bool {
        let state = self.state.lock().expect("pending plugin logins");
        state.revision == revision
            && state
                .registered
                .get(key)
                .is_some_and(|until| *until > Instant::now())
    }

    pub(in crate::plugin_account_auth) fn revision(&self) -> u64 {
        self.state.lock().expect("pending plugin logins").revision
    }

    pub(in crate::plugin_account_auth) fn take(self: &Arc<Self>) -> PendingLoginBatch {
        let mut state = self.state.lock().expect("pending plugin logins");
        let mut entries = HashMap::new();
        let mut installations = HashSet::new();
        let now = Instant::now();
        let PendingLoginState {
            entries: queued,
            processing,
            ..
        } = &mut *state;
        queued.retain(|key, entry| {
            if entry.ready_at > now
                || processing.contains(key)
                || (installations.len() == DISCOVERY_BATCH_SIZE && !installations.contains(&key.0))
            {
                return true;
            }
            installations.insert(key.0);
            entries.insert(key.clone(), entry.failures);
            false
        });
        processing.extend(entries.keys().cloned());
        PendingLoginBatch {
            logins: self.clone(),
            revision: state.revision,
            entries,
        }
    }

    pub(super) fn action_gate(&self, revision: u64, id: u64) -> Option<Arc<AsyncMutex<()>>> {
        let mut state = self.state.lock().expect("pending plugin logins");
        if state.revision != revision {
            return None;
        }
        state.actions.retain(|_, gate| gate.strong_count() != 0);
        if let Some(gate) = state.actions.get(&id).and_then(Weak::upgrade) {
            return Some(gate);
        }
        let gate = Arc::new(AsyncMutex::new(()));
        state.actions.insert(id, Arc::downgrade(&gate));
        Some(gate)
    }

    pub(in crate::plugin_account_auth) fn contains_installation(&self, installed_id: u64) -> bool {
        let state = self.state.lock().expect("pending plugin logins");
        // Old revocation records may lack resolvable installation metadata.
        if installed_id == 0 {
            return !state.processing.is_empty()
                || state.entries.values().any(|entry| entry.reserved);
        }
        state.processing.iter().any(|(id, _)| *id == installed_id)
            || state
                .entries
                .iter()
                .any(|((id, _), entry)| *id == installed_id && entry.reserved)
    }
}
