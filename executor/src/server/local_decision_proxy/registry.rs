// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! In-memory registry of local decision routes.
//!
//! A route is a capability: the opaque token in the URL is the only thing a
//! Smart App needs in order to call the decision upstream. The registry never
//! copies a credential out of its owner: every route holds the shared
//! `ConnectionConfig` snapshot and lets the request path resolve the upstream
//! credential from the current login state.
//!
//! None of the types here derive `Debug`, because a `ConnectionConfig` happens
//! to render its tokens through `Debug`.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};

use crate::{config::device::ConnectionConfig, logging::log_executor_event};

/// Routes that are not used for this long are reclaimed.
const ROUTE_IDLE_TTL: Duration = Duration::from_secs(30 * 60);
/// Hard cap for a route nobody references any more, so an abandoned token does
/// not outlive its Smart App indefinitely.
const ROUTE_MAX_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const TOKEN_PREFIX: &str = "decision-";
const TOKEN_RANDOM_BYTES: usize = 32;

/// Everything a request needs after a successful lookup.
///
/// The registry lock is released before any network work starts.
#[derive(Clone)]
pub(crate) struct DecisionRouteHandle {
    pub scope: String,
    pub snapshot: Arc<Mutex<Option<ConnectionConfig>>>,
}

impl DecisionRouteHandle {
    /// The live connection snapshot the route reads its credential from.
    pub(crate) fn snapshot(&self) -> Arc<Mutex<Option<ConnectionConfig>>> {
        Arc::clone(&self.snapshot)
    }
}

struct DecisionRouteBinding {
    scope: String,
    snapshot: Arc<Mutex<Option<ConnectionConfig>>>,
    created_at: Instant,
    last_used: Instant,
    active_references: usize,
}

#[derive(Default)]
pub(crate) struct DecisionRouteRegistry {
    routes: HashMap<String, DecisionRouteBinding>,
    tokens_by_scope: HashMap<String, String>,
}

impl DecisionRouteRegistry {
    pub(crate) fn register(
        &mut self,
        scope: &str,
        snapshot: Arc<Mutex<Option<ConnectionConfig>>>,
        now: Instant,
    ) -> String {
        self.prune(now);
        let token = match self.tokens_by_scope.get(scope) {
            Some(token) => token.clone(),
            None => {
                let token = generate_token(self);
                self.tokens_by_scope.insert(scope.to_owned(), token.clone());
                token
            }
        };
        match self.routes.get_mut(&token) {
            Some(binding) => {
                binding.active_references += 1;
                binding.last_used = now;
                binding.snapshot = snapshot;
            }
            None => {
                self.routes.insert(
                    token.clone(),
                    DecisionRouteBinding {
                        scope: scope.to_owned(),
                        snapshot,
                        created_at: now,
                        last_used: now,
                        active_references: 1,
                    },
                );
            }
        }
        token
    }

    /// Releases one reference. A route with no references left stops
    /// authenticating immediately; its entry is reclaimed by [`Self::prune`].
    pub(crate) fn unregister(&mut self, token: &str, now: Instant) -> bool {
        let Some(binding) = self.routes.get_mut(token) else {
            return false;
        };
        if binding.active_references == 0 {
            return false;
        }
        binding.active_references -= 1;
        binding.last_used = now;
        if binding.active_references == 0 {
            self.tokens_by_scope.retain(|_, value| value != token);
        }
        true
    }

    pub(crate) fn lookup(&mut self, token: &str, now: Instant) -> Option<DecisionRouteHandle> {
        self.prune(now);
        let binding = self.routes.get_mut(token)?;
        if binding.active_references == 0 {
            return None;
        }
        binding.last_used = now;
        Some(DecisionRouteHandle {
            scope: binding.scope.clone(),
            snapshot: Arc::clone(&binding.snapshot),
        })
    }

    fn prune(&mut self, now: Instant) {
        self.routes.retain(|_, binding| {
            // A route a running Smart App still references must survive: nothing
            // re-registers it while the app runs, so expiring it here would make
            // every later request fail with route_not_found.
            if binding.active_references > 0 {
                return true;
            }
            now.saturating_duration_since(binding.created_at) < ROUTE_MAX_TTL
                && now.saturating_duration_since(binding.last_used) < ROUTE_IDLE_TTL
        });
        let routes = &self.routes;
        self.tokens_by_scope
            .retain(|_, token| routes.contains_key(token));
    }

    #[cfg(test)]
    pub(crate) fn active_references(&self, token: &str) -> Option<usize> {
        self.routes
            .get(token)
            .map(|binding| binding.active_references)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.routes.len()
    }
}

fn registry() -> &'static Mutex<DecisionRouteRegistry> {
    static REGISTRY: OnceLock<Mutex<DecisionRouteRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(DecisionRouteRegistry::default()))
}

/// Registers a route for `scope` and returns its token.
///
/// Registering the same scope again only adds a reference, so the Smart App can
/// be restarted without invalidating a token an in-flight request still uses.
pub(crate) fn register(scope: &str, snapshot: Arc<Mutex<Option<ConnectionConfig>>>) -> String {
    let now = Instant::now();
    let (token, reused, active_registrations) = {
        let mut registry = registry()
            .lock()
            .expect("decision proxy registry should not be poisoned");
        let reused = registry.tokens_by_scope.contains_key(scope);
        let token = registry.register(scope, snapshot, now);
        (token, reused, registry.routes.len())
    };
    log_executor_event(
        "local decision proxy route registered",
        &registration_log_fields(&scope_hash(scope), active_registrations, reused),
    );
    token
}

/// Releases one reference to `token`. Unknown tokens are ignored.
pub(crate) fn unregister(token: &str) {
    let now = Instant::now();
    let removed = {
        let mut registry = registry()
            .lock()
            .expect("decision proxy registry should not be poisoned");
        registry.unregister(token, now)
    };
    log_executor_event(
        "local decision proxy route unregistered",
        &[
            ("token_hash", token_hash(token)),
            ("released", removed.to_string()),
        ],
    );
}

/// Resolves a token to the credential source it should use.
pub(crate) fn lookup(token: &str) -> Option<DecisionRouteHandle> {
    registry()
        .lock()
        .expect("decision proxy registry should not be poisoned")
        .lookup(token, Instant::now())
}

fn generate_token(registry: &DecisionRouteRegistry) -> String {
    loop {
        let mut bytes = [0_u8; TOKEN_RANDOM_BYTES];
        getrandom::fill(&mut bytes).expect("secure decision proxy token generation should work");
        let suffix = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let token = format!("{TOKEN_PREFIX}{suffix}");
        if !registry.routes.contains_key(&token) {
            return token;
        }
    }
}

fn registration_log_fields(
    scope_hash: &str,
    active_registrations: usize,
    reused: bool,
) -> Vec<(&'static str, String)> {
    vec![
        ("scope_hash", scope_hash.to_owned()),
        ("active_registrations", active_registrations.to_string()),
        ("reused", reused.to_string()),
    ]
}

pub(crate) fn scope_hash(scope: &str) -> String {
    hash_hex(scope)
}

fn token_hash(token: &str) -> String {
    hash_hex(token)
}

/// Short stable digest so identifiers never reach the log in clear text.
fn hash_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::config::device::ConnectionConfig;

    fn connection(auth_token: &str) -> ConnectionConfig {
        ConnectionConfig {
            backend_url: "https://backend.example.com".to_owned(),
            socket_url: String::new(),
            auth_token: auth_token.to_owned(),
            runtime_auth_token: String::new(),
        }
    }

    fn snapshot(auth_token: &str) -> Arc<Mutex<Option<ConnectionConfig>>> {
        Arc::new(Mutex::new(Some(connection(auth_token))))
    }

    #[test]
    fn register_returns_a_prefixed_token_with_32_bytes_of_entropy() {
        let mut registry = DecisionRouteRegistry::default();
        let now = Instant::now();
        let token = registry.register("scope-a", snapshot("token-a"), now);
        let suffix = token.strip_prefix("decision-").expect("token prefix");
        assert_eq!(suffix.len(), 64);
        assert!(suffix.chars().all(|value| value.is_ascii_hexdigit()));

        let other = registry.register("scope-b", snapshot("token-b"), now);
        assert_ne!(token, other);
    }

    #[test]
    fn same_scope_reuses_the_token_and_counts_references() {
        let mut registry = DecisionRouteRegistry::default();
        let now = Instant::now();
        let first = registry.register("scope-a", snapshot("token-a"), now);
        let second = registry.register("scope-a", snapshot("token-a"), now);
        assert_eq!(first, second);
        assert_eq!(registry.active_references(&first), Some(2));
    }

    #[test]
    fn unregister_releases_references_then_kills_the_route() {
        let mut registry = DecisionRouteRegistry::default();
        let now = Instant::now();
        let token = registry.register("scope-a", snapshot("token-a"), now);
        registry.register("scope-a", snapshot("token-a"), now);

        registry.unregister(&token, now);
        assert_eq!(registry.active_references(&token), Some(1));
        assert!(registry.lookup(&token, now).is_some());

        registry.unregister(&token, now);
        assert!(
            registry.lookup(&token, now).is_none(),
            "a released route must stop authenticating immediately"
        );
    }

    #[test]
    fn unregister_of_an_unknown_token_is_idempotent() {
        let mut registry = DecisionRouteRegistry::default();
        let now = Instant::now();
        assert!(!registry.unregister("decision-missing", now));
        assert!(!registry.unregister("decision-missing", now));
    }

    #[test]
    fn a_released_scope_registers_with_a_fresh_token() {
        let mut registry = DecisionRouteRegistry::default();
        let now = Instant::now();
        let first = registry.register("scope-a", snapshot("token-a"), now);
        registry.unregister(&first, now);
        let second = registry.register("scope-a", snapshot("token-a"), now);
        assert_ne!(
            first, second,
            "a token that has been released must never be handed out again"
        );
    }

    #[test]
    fn idle_routes_are_pruned_but_live_routes_survive() {
        let mut registry = DecisionRouteRegistry::default();
        let now = Instant::now();
        let live = registry.register("scope-live", snapshot("token-a"), now);
        let released = registry.register("scope-released", snapshot("token-b"), now);
        registry.unregister(&released, now);

        let later = now + ROUTE_IDLE_TTL + Duration::from_secs(1);
        assert!(registry.lookup(&live, later).is_some());
        assert!(registry.lookup(&released, later).is_none());

        registry.prune(later);
        assert_eq!(registry.len(), 1, "only the released route should expire");
        assert!(registry.lookup(&live, later).is_some());
    }

    #[test]
    fn released_routes_expire_at_the_absolute_cap() {
        let mut registry = DecisionRouteRegistry::default();
        let now = Instant::now();
        let token = registry.register("scope-a", snapshot("token-a"), now);
        // Released routes stop authenticating immediately; the cap only decides
        // when the abandoned entry is dropped from memory.
        assert!(registry.unregister(&token, now));
        registry.prune(now + ROUTE_MAX_TTL + Duration::from_secs(1));
        assert!(registry.lookup(&token, now).is_none());
        assert_eq!(registry.len(), 0, "an abandoned route must not be kept");
    }

    #[test]
    fn a_referenced_route_survives_the_absolute_cap() {
        let mut registry = DecisionRouteRegistry::default();
        let now = Instant::now();
        let token = registry.register("scope-long-running", snapshot("token-a"), now);

        // A resident Smart App keeps one reference for as long as it runs and
        // never registers again, so its route must outlive the cap.
        let later = now + ROUTE_MAX_TTL + Duration::from_secs(1);
        assert!(registry.lookup(&token, later).is_some());
        registry.prune(later);
        assert!(
            registry.lookup(&token, later).is_some(),
            "pruning must never invalidate a route a running app still holds"
        );
    }

    #[test]
    fn routes_follow_the_shared_connection_snapshot() {
        let mut registry = DecisionRouteRegistry::default();
        let now = Instant::now();
        let snapshot = Arc::new(Mutex::new(Some(connection("old-token"))));
        let token = registry.register("scope-a", Arc::clone(&snapshot), now);

        *snapshot.lock().expect("snapshot lock") = Some(connection("new-token"));
        let handle = registry.lookup(&token, now).expect("route");
        let current = handle
            .snapshot()
            .lock()
            .expect("snapshot lock")
            .clone()
            .expect("connection");
        assert_eq!(current.auth_token, "new-token");
        assert!(Arc::ptr_eq(&handle.snapshot(), &snapshot));
    }

    #[test]
    fn registration_log_fields_are_opaque() {
        let scope = "smart-app:installation-42:9f1c2d";
        let fields = registration_log_fields(&scope_hash(scope), 3, false);
        assert_eq!(
            fields.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
            vec!["scope_hash", "active_registrations", "reused"]
        );
        for (_, value) in &fields {
            assert!(!value.contains(scope), "log leaked the scope: {value}");
        }
    }

    #[test]
    fn scope_hash_is_stable_and_opaque() {
        assert_eq!(scope_hash("scope-a"), scope_hash("scope-a"));
        assert_ne!(scope_hash("scope-a"), scope_hash("scope-b"));
        let hashed = scope_hash("smart-app:installation-42:9f1c2d");
        assert!(!hashed.contains("smart-app"));
        assert!(!hashed.contains("installation-42"));
    }
}
