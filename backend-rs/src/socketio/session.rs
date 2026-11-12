// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Per-socket session state and process-local registration guards for
//! `/local-executor`.
//!
//! Source: `app/api/ws/device_namespace.py`. The Python handler keeps mutable
//! session fields (`device_id`, `reported_device_id`, `logical_device_id`,
//! `device_name`, transfer route and Runtime identity) plus two process-local
//! guards: the connect rate limiter (`_is_connection_rate_limited`, 30
//! attempts per 30 s per peer) and the registration upsert debounce
//! (`_get_recent_registration_display_name`/`_remember_registration`, 10 s).
//!
//! Both guards live in the Rust process because the namespace sessions do.
//! They are bounded: the limiter keeps only attempts inside its window and the
//! debounce expires entries after its window, so neither grows without limit.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::auth::Identity;
use super::device::DeviceType;

/// `DEVICE_CONNECT_RATE_LIMIT_WINDOW_SECONDS`.
pub const CONNECT_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(30);
/// `DEVICE_CONNECT_RATE_LIMIT_MAX_ATTEMPTS`.
pub const CONNECT_RATE_LIMIT_MAX_ATTEMPTS: usize = 30;
/// `DEVICE_REGISTER_UPSERT_DEBOUNCE_SECONDS`.
pub const REGISTER_DEBOUNCE: Duration = Duration::from_secs(10);
/// Bound on distinct rate-limit keys retained by one process.
const MAX_RATE_LIMIT_KEYS: usize = 4096;
/// Bound on distinct devices retained by the registration debounce.
const MAX_DEBOUNCE_ENTRIES: usize = 4096;

/// The mutable part of one `/local-executor` namespace session.
#[derive(Debug, Clone, Default)]
pub struct DeviceSessionState {
    /// Canonical route id (`device_id` in the source session).
    pub device_id: Option<String>,
    /// The executor-reported id (`reported_device_id`).
    pub reported_device_id: Option<String>,
    /// Cloud logical id (`logical_device_id`), defaults to the route id.
    pub logical_device_id: Option<String>,
    pub device_name: Option<String>,
    pub runtime_transfer_host: Option<String>,
    pub runtime_transfer_port: Option<i64>,
    pub runtime_instance_id: Option<String>,
    pub device_type: Option<DeviceType>,
    pub execution_target_id: Option<String>,
    pub registered: bool,
    pub(super) last_presence_attempt: Option<std::time::Instant>,
}

/// One namespace connection's business session.
pub struct DeviceSession {
    user_id: i64,
    user_name: String,
    auth_type: &'static str,
    client_ip: Option<String>,
    state: Mutex<DeviceSessionState>,
}

/// A read-only copy used so handlers never hold the session lock across I/O.
#[derive(Debug, Clone)]
pub struct SessionSnapshot {
    pub user_id: i64,
    pub user_name: String,
    pub auth_type: &'static str,
    pub client_ip: Option<String>,
    pub device: DeviceSessionState,
}

impl DeviceSession {
    /// Creates a connection session from the authenticated identity.
    #[must_use]
    pub fn new(identity: &Identity, client_ip: Option<String>) -> Self {
        Self {
            user_id: identity.user_id,
            user_name: identity.user_name.clone(),
            auth_type: identity.auth_type,
            client_ip,
            state: Mutex::new(DeviceSessionState::default()),
        }
    }

    /// Copies the session fields for one handler invocation.
    #[must_use]
    pub fn snapshot(&self) -> SessionSnapshot {
        let state = self.state.lock().expect("device session lock").clone();
        SessionSnapshot {
            user_id: self.user_id,
            user_name: self.user_name.clone(),
            auth_type: self.auth_type,
            client_ip: self.client_ip.clone(),
            device: state,
        }
    }

    /// Applies `_register_device_session`'s session mutation.
    ///
    /// Returns the route id and execution target the reply must join rooms for.
    pub fn apply_registration(&self, registration: RegistrationSession) -> (String, String) {
        let mut state = self.state.lock().expect("device session lock");
        let route_id = registration.route_id;
        let execution_target_id = registration.execution_target_id;
        state.reported_device_id = Some(registration.reported_device_id);
        state.device_id = Some(route_id.clone());
        state.logical_device_id = Some(registration.logical_device_id);
        state.device_name = Some(registration.device_name);
        state.runtime_transfer_host = registration.runtime_transfer_host;
        state.runtime_transfer_port = registration.runtime_transfer_port;
        state.runtime_instance_id = registration.runtime_instance_id;
        state.device_type = Some(registration.device_type);
        state.execution_target_id = Some(execution_target_id.clone());
        state.registered = true;
        state.last_presence_attempt = Some(std::time::Instant::now());
        (route_id, execution_target_id)
    }

    /// Applies the heartbeat's transfer-route write-back (`save_session`).
    pub fn apply_heartbeat_transfer(
        &self,
        runtime_transfer_host: Option<String>,
        runtime_transfer_port: Option<i64>,
    ) {
        let mut state = self.state.lock().expect("device session lock");
        state.runtime_transfer_host = runtime_transfer_host;
        state.runtime_transfer_port = runtime_transfer_port;
    }

    pub(super) fn reserve_presence_update(&self) -> bool {
        let mut state = self.state.lock().expect("device session lock");
        let now = std::time::Instant::now();
        if state
            .last_presence_attempt
            .is_some_and(|last| now.duration_since(last) < super::device_upsert::PERSIST_INTERVAL)
        {
            return false;
        }
        state.last_presence_attempt = Some(now);
        true
    }
}

/// One successful registration's session values.
pub struct RegistrationSession {
    pub reported_device_id: String,
    pub route_id: String,
    pub logical_device_id: String,
    pub device_name: String,
    pub runtime_transfer_host: Option<String>,
    pub runtime_transfer_port: Option<i64>,
    pub runtime_instance_id: Option<String>,
    pub device_type: DeviceType,
    pub execution_target_id: String,
}

/// `_is_connection_rate_limited`: a fixed 30 s window per peer address.
#[derive(Default)]
pub struct ConnectionRateLimiter {
    attempts: Mutex<HashMap<String, Vec<Instant>>>,
}

impl ConnectionRateLimiter {
    /// Records one attempt; returns `false` once the window is full.
    pub fn allow(&self, key: &str, now: Instant) -> bool {
        let mut attempts = self.attempts.lock().expect("rate limiter lock");
        if attempts.len() > MAX_RATE_LIMIT_KEYS {
            attempts.retain(|_, window| {
                window
                    .iter()
                    .any(|at| *at > now - CONNECT_RATE_LIMIT_WINDOW)
            });
        }
        let window = attempts.entry(key.to_owned()).or_default();
        window.retain(|at| *at > now - CONNECT_RATE_LIMIT_WINDOW);
        if window.len() >= CONNECT_RATE_LIMIT_MAX_ATTEMPTS {
            return false;
        }
        window.push(now);
        true
    }
}

/// `DeviceRegistrationFingerprint`: the fields an exact reconnect must repeat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationFingerprint {
    pub display_name: String,
    pub client_ip: String,
    pub device_type: &'static str,
    pub bind_shell: &'static str,
    pub runtime_transfer_host: String,
    pub runtime_transfer_port: Option<i64>,
    pub runtime_instance_id: String,
    pub app_device_id: String,
}

/// `_get_recent_registration_display_name`/`_remember_registration`.
#[derive(Default)]
pub struct RegistrationDebounce {
    entries: Mutex<HashMap<(i64, String), DebounceEntry>>,
}

struct DebounceEntry {
    at: Instant,
    fingerprint: RegistrationFingerprint,
    display_name: String,
}

impl RegistrationDebounce {
    /// The cached display name for an exact recent registration.
    pub fn display_name(
        &self,
        user_id: i64,
        device_id: &str,
        fingerprint: &RegistrationFingerprint,
        now: Instant,
    ) -> Option<String> {
        let mut entries = self.entries.lock().expect("registration debounce lock");
        let key = (user_id, device_id.to_owned());
        let entry = entries.get(&key)?;
        if now.duration_since(entry.at) > REGISTER_DEBOUNCE {
            entries.remove(&key);
            return None;
        }
        (entry.fingerprint == *fingerprint).then(|| entry.display_name.clone())
    }

    /// Records a successful upsert.
    pub fn remember(
        &self,
        user_id: i64,
        device_id: &str,
        fingerprint: RegistrationFingerprint,
        display_name: String,
        now: Instant,
    ) {
        let mut entries = self.entries.lock().expect("registration debounce lock");
        if entries.len() > MAX_DEBOUNCE_ENTRIES {
            entries.retain(|_, entry| now.duration_since(entry.at) <= REGISTER_DEBOUNCE);
        }
        entries.insert(
            (user_id, device_id.to_owned()),
            DebounceEntry {
                at: now,
                fingerprint,
                display_name,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::socketio::auth::Identity;

    fn identity() -> Identity {
        Identity {
            user_id: 4443,
            user_name: "executor".into(),
            auth_type: "jwt",
            email: None,
        }
    }

    #[test]
    fn registration_updates_the_session_fields() {
        let session = DeviceSession::new(&identity(), Some("127.0.0.1".into()));
        let (route, target) = session.apply_registration(RegistrationSession {
            reported_device_id: "d-1".into(),
            route_id: "app-record-7".into(),
            logical_device_id: "app-record-7".into(),
            device_name: "executor".into(),
            runtime_transfer_host: Some("192.0.2.1".into()),
            runtime_transfer_port: Some(17888),
            runtime_instance_id: Some("runtime-1".into()),
            device_type: DeviceType::App,
            execution_target_id: "app-record-7".into(),
        });
        assert_eq!(route, "app-record-7");
        assert_eq!(target, "app-record-7");
        let snapshot = session.snapshot();
        assert_eq!(snapshot.device.reported_device_id.as_deref(), Some("d-1"));
        assert_eq!(snapshot.device.device_id.as_deref(), Some("app-record-7"));
        assert_eq!(snapshot.client_ip.as_deref(), Some("127.0.0.1"));
        assert!(snapshot.device.registered);
    }

    #[test]
    fn rate_limiter_rejects_the_thirty_first_attempt_in_the_window() {
        let limiter = ConnectionRateLimiter::default();
        let now = Instant::now();
        for _ in 0..CONNECT_RATE_LIMIT_MAX_ATTEMPTS {
            assert!(limiter.allow("ip:127.0.0.1", now));
        }
        assert!(!limiter.allow("ip:127.0.0.1", now));
        assert!(limiter.allow("ip:127.0.0.1", now + CONNECT_RATE_LIMIT_WINDOW));
    }

    #[test]
    fn debounce_requires_the_exact_fingerprint() {
        let debounce = RegistrationDebounce::default();
        let now = Instant::now();
        let fingerprint = RegistrationFingerprint {
            display_name: "executor".into(),
            client_ip: "127.0.0.1".into(),
            device_type: "local",
            bind_shell: "claudecode",
            runtime_transfer_host: String::new(),
            runtime_transfer_port: Some(17888),
            runtime_instance_id: String::new(),
            app_device_id: String::new(),
        };
        debounce.remember(1, "d-1", fingerprint.clone(), "executor".into(), now);
        assert_eq!(
            debounce.display_name(1, "d-1", &fingerprint, now),
            Some("executor".into())
        );
        let mut changed = fingerprint;
        changed.display_name = "other".into();
        assert_eq!(debounce.display_name(1, "d-1", &changed, now), None);
        assert_eq!(
            debounce.display_name(1, "d-1", &changed, now + REGISTER_DEBOUNCE),
            None
        );
    }
}
