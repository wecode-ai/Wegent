//! Native-only HTTP sessions are bound to the exact active account profile.
use super::{
    automation::PendingLogins,
    transport::{completes_side_effect, is_write, PluginAuthFuture, PluginAuthTransport},
};
use crate::{
    agents::backend_url::backend_http_client,
    config::device::ConnectionConfig,
    local::{app_ipc::AppIpcError, backend::SocketIoTransport},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::{poll_fn, Future},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{sync::watch, time::Instant};

const CONTENTION_HEADER: &str = "x-wegent-plugin-auth-contention";
const RESULT_HEADER: &str = "x-wegent-plugin-auth-result";
const BUSY_DETAIL: &str = "plugin_auth_exchange_failed";
const BUSY_CODE: &str = "plugin_write_busy";
const LEASE_TIMEOUT_CODE: &str = "plugin_write_lease_timeout";
const BUSY_BEFORE_WRITE: &str = "busy-before-write";
const BACKEND_UNAVAILABLE: &str = "plugin_auth_backend_unavailable";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const RETRY_DELAYS_MS: [u64; 2] = [100, 200];
const RETRY_WINDOW: Duration = Duration::from_secs(1);
const LEASE_TIMEOUT_RETRY_WINDOW: Duration = Duration::from_secs(3);
const LEASE_TIMEOUT_FINAL_RETRY: Duration = Duration::from_millis(2700);
const MAX_RESULT_CONFIRMATION_BUDGET: Duration = Duration::from_secs(2);

pub(crate) fn account_scope(connection: &ConnectionConfig) -> String {
    // This is only a local cancellation key, never an authorization decision.
    let identity = token_claims(&connection.auth_token)
        .map(|v| json!([v["user_id"], v["sub"]]).to_string())
        .unwrap_or_else(|| format!("{:x}", Sha256::digest(connection.auth_token.as_bytes())));
    format!("{}:{identity}", connection.backend_url)
}

fn token_claims(token: &str) -> Option<Value> {
    token
        .split('.')
        .nth(1)
        .and_then(|p| URL_SAFE_NO_PAD.decode(p).ok())
        .and_then(|p| serde_json::from_slice::<Value>(&p).ok())
}

#[derive(Deserialize, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
struct Session {
    backend_url: String,
    account_token: String,
    native_token: String,
    expires_at: i64,
}

struct SessionSnapshot {
    session: Session,
    generation: u64,
    owner_generation: u64,
}

impl Session {
    fn bound_to(&self, connection: Option<&ConnectionConfig>) -> bool {
        connection.is_some_and(|profile| {
            profile.backend_url == self.backend_url && profile.auth_token == self.account_token
        }) && self.expires_at > chrono::Utc::now().timestamp()
    }

    fn same_owner(&self, next: &Self) -> bool {
        // The host supplies a Backend-issued token. These claims only fence local
        // work across renewal; the Backend still verifies the token on every call.
        self.backend_url == next.backend_url
            && self.same_account(next)
            && self.native_owner().is_some_and(|owner| {
                next.native_owner()
                    .is_some_and(|next_owner| owner == next_owner)
            })
    }

    fn same_account(&self, next: &Self) -> bool {
        self.account_token == next.account_token
            || token_claims(&self.account_token)
                .zip(token_claims(&next.account_token))
                .is_some_and(|(previous, next)| {
                    previous["sub"].as_str().is_some_and(|sub| !sub.is_empty())
                        && previous["sub"] == next["sub"]
                        && previous["user_id"] == next["user_id"]
                })
    }

    fn native_owner(&self) -> Option<(i64, String, String)> {
        let claims = token_claims(&self.native_token)?;
        let user_id = claims["user_id"].as_i64().filter(|id| *id > 0)?;
        let subject = claims["sub"].as_str().filter(|s| !s.is_empty())?;
        let thumbprint = claims["thumbprint"].as_str().filter(|s| !s.is_empty())?;
        (claims["token_use"] == "plugin_native" && claims["scope"] == "plugin_native")
            .then(|| (user_id, subject.to_owned(), thumbprint.to_owned()))
    }
}

#[derive(Default)]
struct State {
    session: Option<Session>,
    socket: Option<SocketIoTransport>,
    remote: bool,
    generation: u64,
    owner_generation: u64,
    socket_generation: u64,
    configuration_revision: u64,
    foreground_writes: HashMap<u64, usize>,
    pending_logins: Weak<PendingLogins>,
}

impl State {
    fn route(&self) -> AuthRoute {
        if self.session.is_some() && !self.remote {
            AuthRoute::Native(self.owner_generation)
        } else {
            AuthRoute::Socket(self.socket_generation)
        }
    }

    fn change_owner(&mut self) {
        self.owner_generation += 1;
        self.foreground_writes.clear();
        if let Some(logins) = self.pending_logins.upgrade() {
            logins.clear_owner();
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AuthRoute {
    Native(u64),
    Socket(u64),
}

#[derive(Clone, Copy)]
struct PluginOperation {
    installed_id: u64,
    route: Option<AuthRoute>,
    foreground: bool,
}

#[derive(Clone)]
pub(crate) struct LocalAuthContext {
    state: Arc<Mutex<State>>,
    connection: Arc<Mutex<Option<ConnectionConfig>>>,
    session_changes: watch::Sender<()>,
    operation: Option<PluginOperation>,
    pending_logins: Option<Arc<PendingLogins>>,
}
impl LocalAuthContext {
    pub(crate) fn new(connection: Arc<Mutex<Option<ConnectionConfig>>>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            connection,
            session_changes: watch::channel(()).0,
            operation: None,
            pending_logins: None,
        }
    }
    pub(super) fn with_pending_logins(mut self, pending_logins: Arc<PendingLogins>) -> Self {
        if let Ok(mut state) = self.state.lock() {
            if let Some(previous) = state.pending_logins.upgrade() {
                previous.clear_owner();
            }
            state.pending_logins = Arc::downgrade(&pending_logins);
        }
        self.pending_logins = Some(pending_logins);
        self
    }
    pub(crate) fn configure(&self, params: Value) -> Result<Value, AppIpcError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Configuration {
            configuration_revision: u64,
            session: Option<Session>,
        }
        let input: Configuration = serde_json::from_value(params).map_err(|_| unavailable())?;
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        if input.configuration_revision <= state.configuration_revision {
            return Err(unavailable());
        }
        let session = if let Some(mut session) = input.session {
            let url = reqwest::Url::parse(&session.backend_url).map_err(|_| unavailable())?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || session.account_token.is_empty()
                || session.native_token.is_empty()
                || session.expires_at <= chrono::Utc::now().timestamp()
            {
                return Err(unavailable());
            }
            session.backend_url = session.backend_url.trim_end_matches('/').into();
            Some(session)
        } else {
            None
        };
        let same_owner = state
            .session
            .as_ref()
            .zip(session.as_ref())
            .is_some_and(|(previous, next)| previous.same_owner(next));
        if !same_owner {
            state.change_owner();
        }
        if !state.remote && state.session.is_some() != session.is_some() {
            state.socket_generation += 1;
        }
        state.generation += 1;
        state.configuration_revision = input.configuration_revision;
        state.session = session;
        self.session_changes.send_replace(());
        if let Some(logins) = state.pending_logins.upgrade() {
            logins.wake();
        }
        Ok(json!({"enabled":state.session.is_some()}))
    }
    pub(crate) fn socket(&self, socket: Option<SocketIoTransport>, remote: bool) {
        if let Ok(mut state) = self.state.lock() {
            if state.remote != remote {
                state.generation += 1;
                state.change_owner();
                self.session_changes.send_replace(());
            }
            state.socket = socket;
            state.remote = remote;
            state.socket_generation += 1;
        }
    }
    pub(crate) fn clear(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.session = None;
            state.socket = None;
            state.generation += 1;
            state.socket_generation += 1;
            state.change_owner();
            self.session_changes.send_replace(());
        }
    }
    fn bound(&self, session: &Session) -> bool {
        self.connection
            .lock()
            .is_ok_and(|profile| session.bound_to(profile.as_ref()))
    }

    fn still_bound(&self, session: &Session, generation: u64) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.generation == generation && !state.remote)
            && self.bound(session)
    }

    fn owner_bound(&self, owner_generation: u64) -> bool {
        self.state.lock().is_ok_and(|state| {
            state.owner_generation == owner_generation
                && !state.remote
                && state
                    .session
                    .as_ref()
                    .is_some_and(|session| self.bound(session))
        })
    }

    fn route_matches(&self, state: &State) -> bool {
        !self
            .operation
            .is_some_and(|scope| scope.route != Some(state.route()))
    }

    fn admit_write(
        &self,
        generation: u64,
        completing_side_effect: bool,
    ) -> Result<Option<ForegroundWrite>, &'static str> {
        let Some(operation) = self.operation else {
            return Ok(None);
        };
        let mut state = self.state.lock().map_err(|_| BACKEND_UNAVAILABLE)?;
        if state.generation != generation || state.remote {
            return Err(BACKEND_UNAVAILABLE);
        }
        if operation.foreground {
            *state
                .foreground_writes
                .entry(operation.installed_id)
                .or_default() += 1;
            return Ok(Some(ForegroundWrite {
                state: self.state.clone(),
                installed_id: operation.installed_id,
                owner_generation: state.owner_generation,
            }));
        }
        let foreground_pending = if operation.installed_id == 0 {
            !state.foreground_writes.is_empty()
        } else {
            state
                .foreground_writes
                .contains_key(&operation.installed_id)
        };
        if !completing_side_effect
            && (foreground_pending
                || self
                    .pending_logins
                    .as_ref()
                    .is_some_and(|logins| logins.contains_installation(operation.installed_id)))
        {
            return Err("plugin_auth_background_deferred");
        }
        Ok(None)
    }

    fn queue_login(&self, guard: &ForegroundWrite, connector_slug: String) {
        let Some(logins) = &self.pending_logins else {
            return;
        };
        let Ok(state) = self.state.lock() else {
            return;
        };
        let Ok(profile) = self.connection.lock() else {
            return;
        };
        if state.owner_generation == guard.owner_generation
            && Weak::ptr_eq(&state.pending_logins, &Arc::downgrade(logins))
            && !state.remote
            && state
                .session
                .as_ref()
                .is_some_and(|session| session.bound_to(profile.as_ref()))
        {
            logins.submit(guard.installed_id, connector_slug);
        }
    }

    async fn native_exchange(
        &self,
        snapshot: SessionSnapshot,
        operation: &str,
        payload: Value,
        timeout: Duration,
        foreground: bool,
    ) -> Result<Value, String> {
        let SessionSnapshot {
            mut session,
            mut generation,
            owner_generation,
        } = snapshot;
        // These results finish an existing provider operation or staged migration.
        let completing_side_effect = completes_side_effect(operation);
        let client = backend_http_client().map_err(|_| BACKEND_UNAVAILABLE)?;
        let url = format!("{}/api/plugins/native-auth/exchange", session.backend_url);
        let mut body =
            json!({"operation":operation,"native_token":session.native_token,"data":payload});
        let started = Instant::now();
        let deadline = started + timeout;
        let renewing_result_owner = (completing_side_effect
            || operation == "plugin.auth.oauth.finish")
            .then_some(owner_generation);
        let replay_safe_result =
            renewing_result_owner.is_some() || operation == "plugin.auth.transfer.stage";
        let result_owner = replay_safe_result.then_some(owner_generation);
        let mut unconfirmed_result = None;
        let mut lease_timeout_observed = false;
        let mut session_changes = self.session_changes.subscribe();
        let mut retry: Option<(Instant, Option<u64>)> = None;
        for attempt in 0..=RETRY_DELAYS_MS.len() {
            let pending_retry = retry.take();
            let retry_owner = pending_retry.and_then(|(_, owner)| owner);
            let response = loop {
                if let Some(owner) = retry_owner {
                    (session, generation) = self.renewed_session(owner, &mut session_changes)?;
                    body["native_token"] = json!(session.native_token);
                }
                let now = Instant::now();
                if pending_retry.is_some_and(|(until, _)| now >= until) {
                    return Ok(failed("plugin_auth_busy_retry_later"));
                }
                if now >= deadline {
                    return Err(BACKEND_UNAVAILABLE.into());
                }
                if !self.still_bound(&session, generation) {
                    if retry_owner.is_some() {
                        continue;
                    }
                    return Err(BACKEND_UNAVAILABLE.into());
                }
                let confirmation_at = (replay_safe_result
                    && unconfirmed_result.is_none()
                    && attempt < RETRY_DELAYS_MS.len())
                .then(|| {
                    let reserve = ((deadline - now) / 3).min(MAX_RESULT_CONFIRMATION_BUDGET);
                    let soft_deadline = deadline - reserve;
                    if lease_timeout_observed {
                        soft_deadline.max(started + LEASE_TIMEOUT_FINAL_RETRY)
                    } else {
                        soft_deadline
                    }
                })
                .filter(|when| *when < deadline);
                let mut confirmation_changes = session_changes.clone();
                let response = self.await_native_response(
                    native_response(&client, &url, &body, deadline - now),
                    &mut session_changes,
                    result_owner.filter(|_| unconfirmed_result.is_none()),
                );
                tokio::pin!(response);
                let response = if let Some(when) = confirmation_at {
                    tokio::select! {
                        biased;
                        result = &mut response => result,
                        _ = tokio::time::sleep_until(when) => {
                            let remaining = deadline.saturating_duration_since(Instant::now());
                            if !remaining.is_zero() && self.still_bound(&session, generation) {
                                // Keep the original request alive. Its transaction may still
                                // hold the lease when the idempotent confirmation arrives.
                                let confirmation = self.await_native_response(
                                    native_response(&client, &url, &body, remaining),
                                    &mut confirmation_changes,
                                    None,
                                );
                                return self.confirm_in_flight(
                                    response,
                                    confirmation,
                                    &session,
                                    generation,
                                    owner_generation,
                                    |offset, response| {
                                        if let Some(reason) = response.retry_before_write {
                                            self.log_contention(
                                                operation, attempt + offset, response, reason, false,
                                            );
                                        }
                                    },
                                ).await;
                            }
                            response.await
                        }
                    }
                } else {
                    response.await
                };
                match response {
                    Ok(Some(response)) => break Ok(response),
                    Err(error) => break Err(error),
                    // A watch update canceled the unsent future. Rebind within this attempt.
                    Ok(None) if retry_owner.is_some() => continue,
                    Ok(None) => return Err(BACKEND_UNAVAILABLE.into()),
                }
            };
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    if !replay_safe_result
                        || unconfirmed_result.is_some()
                        || attempt == RETRY_DELAYS_MS.len()
                        || !self.still_bound(&session, generation)
                    {
                        return Err(error.into());
                    }
                    // Confirm an idempotent result within the dispatching session and call deadline.
                    let now = Instant::now();
                    let next = if lease_timeout_observed {
                        now.max(started + LEASE_TIMEOUT_FINAL_RETRY)
                    } else {
                        now
                    };
                    if next >= deadline {
                        return Err(error.into());
                    }
                    unconfirmed_result = Some(error);
                    self.wait_for_retry(next, &mut session_changes, None)
                        .await?;
                    continue;
                }
            };
            let response_owner = if unconfirmed_result.is_some() {
                None
            } else if response.retry_before_write.is_some() {
                renewing_result_owner
            } else {
                result_owner
            };
            if !self.still_bound(&session, generation)
                && !response_owner.is_some_and(|owner| self.owner_bound(owner))
            {
                return Err(BACKEND_UNAVAILABLE.into());
            }
            let Some(reason) = response.retry_before_write else {
                return Ok(response.value);
            };
            lease_timeout_observed |= reason == RetryBeforeWrite::LeaseTimeout;
            let next = if unconfirmed_result.is_none() && (foreground || completing_side_effect) {
                retry_at(attempt, started, deadline, lease_timeout_observed)
            } else {
                None
            };
            self.log_contention(operation, attempt, &response, reason, next.is_some());
            let Some((next, retry_until)) = next else {
                if let Some(error) = unconfirmed_result {
                    return Err(error.into());
                }
                return Ok(failed("plugin_auth_busy_retry_later"));
            };
            self.wait_for_retry(next, &mut session_changes, renewing_result_owner)
                .await?;
            retry = Some((retry_until, renewing_result_owner));
        }
        Ok(failed("plugin_auth_busy_retry_later"))
    }

    async fn confirm_in_flight(
        &self,
        original: impl Future<Output = NativeResponseResult>,
        confirmation: impl Future<Output = NativeResponseResult>,
        session: &Session,
        generation: u64,
        owner_generation: u64,
        log_response: impl Fn(usize, &NativeResponse),
    ) -> Result<Value, String> {
        let bound = || self.still_bound(session, generation);
        let original_bound = || bound() || self.owner_bound(owner_generation);
        let original_reply = |response: NativeResponseResult| {
            response
                .ok()
                .flatten()
                .filter(|_| original_bound())
                .inspect(|response| log_response(0, response))
        };
        let confirmation_reply = |response: NativeResponseResult| {
            response
                .ok()
                .flatten()
                .filter(|_| bound())
                .inspect(|response| log_response(1, response))
        };
        tokio::pin!(original, confirmation);
        let mut confirmation_polled = false;
        let (original, confirmation) = tokio::select! {
            biased;
            first = &mut original => match original_reply(first) {
                Some(first)
                    if first.value["success"] == true
                        || !confirmation_polled && first.retry_before_write.is_none() =>
                {
                    return Ok(first.value);
                }
                first => (first, confirmation_reply(confirmation.await)),
            },
            second = poll_fn(|cx| {
                confirmation_polled = true;
                confirmation.as_mut().poll(cx)
            }) => match confirmation_reply(second) {
                Some(second) if second.value["success"] == true => return Ok(second.value),
                second => (original_reply(original.await), second),
            },
        };
        match (original, confirmation) {
            (Some(original), _) if original_bound() && original.value["success"] == true => {
                Ok(original.value)
            }
            (_, Some(confirmation)) if bound() && confirmation.value["success"] == true => {
                Ok(confirmation.value)
            }
            (Some(original), _) if original_bound() && original.retry_before_write.is_none() => {
                Ok(original.value)
            }
            (Some(original), Some(confirmation))
                if bound()
                    && original.retry_before_write.is_some()
                    && confirmation.retry_before_write.is_some() =>
            {
                Ok(failed("plugin_auth_busy_retry_later"))
            }
            _ => Err(BACKEND_UNAVAILABLE.into()),
        }
    }

    fn renewed_session(
        &self,
        owner_generation: u64,
        session_changes: &mut watch::Receiver<()>,
    ) -> Result<(Session, u64), &'static str> {
        let state = self.state.lock().map_err(|_| BACKEND_UNAVAILABLE)?;
        if state.owner_generation != owner_generation || state.remote {
            return Err(BACKEND_UNAVAILABLE);
        }
        let session = state
            .session
            .as_ref()
            .filter(|session| self.bound(session))
            .ok_or(BACKEND_UNAVAILABLE)?;
        // Acknowledge only changes covered by this snapshot. A later update
        // must still be observed by await_native_response before it sends.
        session_changes.mark_unchanged();
        Ok((session.clone(), state.generation))
    }

    async fn wait_for_retry(
        &self,
        next: Instant,
        session_changes: &mut watch::Receiver<()>,
        retry_owner: Option<u64>,
    ) -> Result<(), &'static str> {
        loop {
            tokio::select! {
                biased;
                _ = session_changes.changed() => {
                    if !retry_owner.is_some_and(|owner| self.owner_bound(owner)) {
                        return Err(BACKEND_UNAVAILABLE);
                    }
                }
                _ = tokio::time::sleep_until(next) => return Ok(()),
            }
        }
    }

    async fn await_native_response(
        &self,
        response: impl Future<Output = Result<NativeResponse, &'static str>>,
        session_changes: &mut watch::Receiver<()>,
        result_owner: Option<u64>,
    ) -> NativeResponseResult {
        tokio::pin!(response);
        let mut started = false;
        loop {
            tokio::select! {
                biased;
                _ = session_changes.changed() => {
                    if !started {
                        return Ok(None);
                    }
                    // An already-started idempotent result can finish on its
                    // original credential while the same owner renews it.
                    if !result_owner.is_some_and(|owner| self.owner_bound(owner)) {
                        return Err(BACKEND_UNAVAILABLE);
                    }
                }
                result = poll_fn(|cx| {
                    started = true;
                    response.as_mut().poll(cx)
                }) => return result.map(Some),
            }
        }
    }

    fn log_contention(
        &self,
        operation: &str,
        attempt: usize,
        response: &NativeResponse,
        reason: RetryBeforeWrite,
        will_retry: bool,
    ) {
        crate::logging::log_executor_event(
            "Native plugin authorization lock contention",
            &[
                ("operation", operation.to_owned()),
                ("attempt", (attempt + 1).to_string()),
                (
                    "installed_plugin_id",
                    self.operation
                        .map(|operation| operation.installed_id.to_string())
                        .unwrap_or_default(),
                ),
                ("request_id", response.request_id.clone()),
                ("http_status", response.status.as_u16().to_string()),
                (
                    "error",
                    match reason {
                        RetryBeforeWrite::Busy => BUSY_CODE,
                        RetryBeforeWrite::LeaseTimeout => LEASE_TIMEOUT_CODE,
                    }
                    .to_owned(),
                ),
                ("will_retry", will_retry.to_string()),
            ],
        );
    }
}

struct ForegroundWrite {
    state: Arc<Mutex<State>>,
    installed_id: u64,
    owner_generation: u64,
}

impl Drop for ForegroundWrite {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            if state.owner_generation != self.owner_generation {
                return;
            }
            if let std::collections::hash_map::Entry::Occupied(mut entry) =
                state.foreground_writes.entry(self.installed_id)
            {
                if *entry.get() == 1 {
                    entry.remove();
                } else {
                    *entry.get_mut() -= 1;
                }
            }
        }
    }
}

fn retry_at(
    attempt: usize,
    started: Instant,
    deadline: Instant,
    lease_timeout_observed: bool,
) -> Option<(Instant, Instant)> {
    let delay = Duration::from_millis(*RETRY_DELAYS_MS.get(attempt)?);
    let mut next = Instant::now() + delay;
    let window = if lease_timeout_observed {
        if attempt + 1 == RETRY_DELAYS_MS.len() {
            // Allow a slow Redis reply and its token-checked cleanup to finish.
            next = next.max(started + LEASE_TIMEOUT_FINAL_RETRY);
        }
        LEASE_TIMEOUT_RETRY_WINDOW
    } else {
        RETRY_WINDOW
    };
    let mut entropy = [0];
    let _ = getrandom::fill(&mut entropy);
    next += Duration::from_millis(u64::from(entropy[0] % 21));
    let retry_until = (started + window).min(deadline);
    (next < retry_until).then_some((next, retry_until))
}

fn failed(code: &str) -> Value {
    json!({"success":false,"error":code})
}

struct NativeResponse {
    value: Value,
    retry_before_write: Option<RetryBeforeWrite>,
    request_id: String,
    status: reqwest::StatusCode,
}

type NativeResponseResult = Result<Option<NativeResponse>, &'static str>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RetryBeforeWrite {
    Busy,
    LeaseTimeout,
}

fn retry_before_write(
    status: reqwest::StatusCode,
    marked: bool,
    body: &Value,
) -> Option<RetryBeforeWrite> {
    if !marked {
        return None;
    }
    match status {
        reqwest::StatusCode::OK if body["success"] == false && body["retryable"] == true => {
            match body["error"].as_str() {
                Some(BUSY_CODE) => Some(RetryBeforeWrite::Busy),
                Some(LEASE_TIMEOUT_CODE) => Some(RetryBeforeWrite::LeaseTimeout),
                _ => None,
            }
        }
        reqwest::StatusCode::SERVICE_UNAVAILABLE if body["detail"] == BUSY_DETAIL => {
            Some(RetryBeforeWrite::Busy)
        }
        _ => None,
    }
}

async fn native_response(
    client: &reqwest::Client,
    url: &str,
    body: &Value,
    timeout: Duration,
) -> Result<NativeResponse, &'static str> {
    let mut response = client
        .post(url)
        .header(CONTENTION_HEADER, "1")
        .header(RESULT_HEADER, "2")
        .json(body)
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| BACKEND_UNAVAILABLE)?;
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
    {
        return Err(BACKEND_UNAVAILABLE);
    }
    let status = response.status();
    let marked = response
        .headers()
        .get(CONTENTION_HEADER)
        .is_some_and(|header| header == BUSY_BEFORE_WRITE);
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|header| header.to_str().ok())
        .filter(|id| {
            id.len() <= 128
                && id
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-' || ch == b'_')
        })
        .unwrap_or_default()
        .to_owned();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| BACKEND_UNAVAILABLE)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(BACKEND_UNAVAILABLE);
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| BACKEND_UNAVAILABLE)?;
    let retry_before_write = retry_before_write(status, marked, &value);
    let value = if status.is_success() {
        value
    } else {
        failed(
            value["detail"]
                .as_str()
                .unwrap_or("plugin_auth_exchange_rejected"),
        )
    };
    Ok(NativeResponse {
        value,
        retry_before_write,
        request_id,
        status,
    })
}
fn unavailable() -> AppIpcError {
    AppIpcError::new(
        "plugin_auth_backend_unavailable",
        "Plugin account transport is unavailable",
    )
}
impl PluginAuthTransport for LocalAuthContext {
    fn account_scope(&self) -> Option<Value> {
        let state = self.state.lock().ok()?;
        if !self.route_matches(&state) {
            return None;
        }
        let connection = self.connection.lock().ok()?;
        let connection = connection.as_ref()?;
        let native_user = state
            .session
            .as_ref()
            .filter(|session| session.bound_to(Some(connection)))
            .and_then(Session::native_owner)
            .map(|(user_id, _, _)| user_id);
        super::author_source::current_scope(connection, native_user)
    }

    fn available(&self, registered: bool) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        if !self.route_matches(&state) {
            return false;
        }
        match state.session.as_ref().filter(|_| !state.remote) {
            Some(session) => self.bound(session),
            None => registered && state.socket.is_some(),
        }
    }
    fn for_plugin(&self, installed_id: u64, foreground: bool) -> Self {
        let mut scoped = self.clone();
        if let Some(operation) = &mut scoped.operation {
            operation.installed_id = installed_id;
            operation.foreground = foreground;
            return scoped;
        }
        scoped.operation = Some(PluginOperation {
            installed_id,
            route: self.state.lock().ok().map(|state| state.route()),
            foreground,
        });
        scoped
    }

    fn uses_native_http(&self) -> bool {
        let route = match self.operation {
            Some(scope) => scope.route,
            None => self.state.lock().ok().map(|state| state.route()),
        };
        matches!(route, Some(AuthRoute::Native(_)))
    }

    fn exchange<'a>(
        &'a self,
        operation: &'a str,
        payload: Value,
        timeout: Duration,
    ) -> PluginAuthFuture<'a> {
        Box::pin(async move {
            let (session, socket, generation, owner_generation) = {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| "plugin_auth_backend_unavailable".to_string())?;
                if !self.route_matches(&state) {
                    return Err(BACKEND_UNAVAILABLE.into());
                }
                (
                    state.session.clone().filter(|_| !state.remote),
                    state.socket.clone(),
                    state.generation,
                    state.owner_generation,
                )
            };
            let Some(session) = session else {
                let socket = socket.ok_or("plugin_auth_backend_unavailable")?;
                return PluginAuthTransport::exchange(&socket, operation, payload, timeout).await;
            };
            let foreground = if is_write(operation, &payload) {
                match self.admit_write(generation, completes_side_effect(operation)) {
                    Ok(guard) => guard,
                    Err("plugin_auth_background_deferred") => {
                        return Ok(failed("plugin_auth_background_deferred"));
                    }
                    Err(error) => return Err(error.into()),
                }
            } else {
                None
            };
            let login_connector = payload["connector_slug"]
                .as_str()
                .filter(|_| {
                    foreground.is_some()
                        && operation == "plugin.auth.local_lifecycle"
                        && payload["action"] == "login"
                })
                .map(str::to_owned);
            let started = Instant::now();
            let result = self
                .native_exchange(
                    SessionSnapshot {
                        session,
                        generation,
                        owner_generation,
                    },
                    operation,
                    payload,
                    timeout,
                    foreground.is_some(),
                )
                .await;
            if let Some(guard) = foreground {
                if let Some(connector_slug) = login_connector.filter(|_| {
                    result
                        .as_ref()
                        .is_ok_and(|value| value["success"] == true && value["status"] == "ok")
                }) {
                    self.queue_login(&guard, connector_slug);
                }
                let outcome = match &result {
                    Ok(value) if value["success"] == true => "completed",
                    Ok(value) if value["error"] == "plugin_auth_busy_retry_later" => "busy",
                    Ok(_) => "rejected",
                    Err(_) => "unavailable",
                };
                crate::logging::log_executor_event(
                    "Native plugin authorization write completed",
                    &[
                        ("operation", operation.to_owned()),
                        ("installed_plugin_id", guard.installed_id.to_string()),
                        ("outcome", outcome.to_owned()),
                        ("elapsed_ms", started.elapsed().as_millis().to_string()),
                    ],
                );
            }
            result
        })
    }
}

#[cfg(test)]
mod tests;
