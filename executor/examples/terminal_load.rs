// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, VecDeque},
    env,
    path::PathBuf,
    process,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tokio::sync::Notify;
use wegent_executor::local::session::{
    LocalSession, LocalSessionHandler, PtySpawnRequest, SessionPtyManager, TerminalEvent,
    TerminalPty,
};

const DEFAULT_SESSIONS: usize = 32;
const DEFAULT_BYTES_PER_SESSION: usize = 1024 * 1024;
const DEFAULT_CHUNK_BYTES: usize = 8 * 1024;
const DEFAULT_ACK_DELAY_MS: u64 = 50;
const PRODUCTION_PTY_CHUNK_BYTES: usize = 8 * 1024;
const REPLAY_LOW_WATERMARK_BYTES: usize = 128 * 1024;
const REPLAY_HIGH_WATERMARK_BYTES: usize = 384 * 1024;
const REPLAY_LIMIT_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy)]
struct Config {
    sessions: usize,
    bytes_per_session: usize,
    chunk_bytes: usize,
    ack_delay_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            sessions: DEFAULT_SESSIONS,
            bytes_per_session: DEFAULT_BYTES_PER_SESSION,
            chunk_bytes: DEFAULT_CHUNK_BYTES,
            ack_delay_ms: DEFAULT_ACK_DELAY_MS,
        }
    }
}

#[derive(Serialize)]
struct LoadReport {
    status: &'static str,
    sessions: usize,
    bytes_per_session: usize,
    chunk_bytes: usize,
    ack_delay_ms: u64,
    total_bytes: usize,
    delivered_bytes: usize,
    output_events: usize,
    drain_cycles: usize,
    elapsed_ms: f64,
    throughput_mib_per_second: f64,
    max_replay_bytes_per_session: usize,
    replay_limit_bytes: usize,
    replay_high_watermark_bytes: usize,
    replay_low_watermark_bytes: usize,
    backpressure_sessions: usize,
    resumed_sessions: usize,
    reconnect_replay_validated: bool,
}

#[derive(Serialize)]
struct FailureReport<'a> {
    status: &'static str,
    error: &'a str,
}

struct PendingAck {
    sequence: u64,
    bytes: usize,
    due_at: Instant,
}

struct SessionState {
    session_id: String,
    consumer_id: String,
    remaining_bytes: Arc<AtomicUsize>,
    next_sequence: u64,
    delivered_bytes: usize,
    acknowledged_bytes: usize,
    replay_bytes: usize,
    max_replay_bytes: usize,
    output_events: usize,
    pending_acks: VecDeque<PendingAck>,
    backpressure_observed: bool,
    waiting_for_resume: bool,
    resumed_after_low_watermark: bool,
}

impl SessionState {
    fn new(session_id: String, consumer_id: String, remaining_bytes: Arc<AtomicUsize>) -> Self {
        Self {
            session_id,
            consumer_id,
            remaining_bytes,
            next_sequence: 1,
            delivered_bytes: 0,
            acknowledged_bytes: 0,
            replay_bytes: 0,
            max_replay_bytes: 0,
            output_events: 0,
            pending_acks: VecDeque::new(),
            backpressure_observed: false,
            waiting_for_resume: false,
            resumed_after_low_watermark: false,
        }
    }

    fn is_complete(&self, bytes_per_session: usize) -> bool {
        self.delivered_bytes == bytes_per_session
            && self.acknowledged_bytes == bytes_per_session
            && self.replay_bytes == 0
            && self.pending_acks.is_empty()
    }
}

struct LoadTerminal {
    remaining_bytes: Arc<AtomicUsize>,
    chunk_bytes: usize,
}

impl TerminalPty for LoadTerminal {
    fn pid(&self) -> u32 {
        process::id()
    }

    fn fd(&self) -> Option<i32> {
        None
    }

    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        Ok(data.len())
    }

    fn read_available(&mut self, _timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
        let remaining = self.remaining_bytes.load(Ordering::Relaxed);
        if remaining == 0 {
            return Ok(None);
        }
        let bytes = remaining.min(self.chunk_bytes);
        self.remaining_bytes.fetch_sub(bytes, Ordering::Relaxed);
        Ok(Some(vec![b'x'; bytes]))
    }

    fn set_event_notifier(&mut self, _notifier: Arc<Notify>) {}

    fn output_closed(&self) -> bool {
        false
    }

    fn resize(&mut self, _rows: u16, _cols: u16) -> Result<(), String> {
        Ok(())
    }

    fn poll(&mut self) -> std::io::Result<Option<u32>> {
        Ok(None)
    }

    fn terminate(&mut self, _force: bool) {}

    fn close(&mut self) {}
}

struct LoadPtyManager;

impl SessionPtyManager for LoadPtyManager {
    fn is_available(&self) -> bool {
        false
    }

    fn spawn(&self, _request: PtySpawnRequest) -> Result<Box<dyn TerminalPty>, String> {
        Err("load harness inserts terminal sessions directly".to_owned())
    }
}

fn main() {
    match parse_config().and_then(run_load) {
        Ok(report) => {
            println!(
                "{}",
                serde_json::to_string(&report).expect("load report must serialize")
            );
        }
        Err(error) => {
            println!(
                "{}",
                serde_json::to_string(&FailureReport {
                    status: "failed",
                    error: &error,
                })
                .expect("failure report must serialize")
            );
            process::exit(1);
        }
    }
}

fn parse_config() -> Result<Config, String> {
    let mut config = Config::default();
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        let (name, value) = match argument.split_once('=') {
            Some((name, value)) => (name, value.to_owned()),
            None => {
                let value = args
                    .next()
                    .ok_or_else(|| format!("missing value for {argument}"))?;
                (argument.as_str(), value)
            }
        };
        match name {
            "--sessions" => config.sessions = parse_usize(name, &value)?,
            "--bytes-per-session" => config.bytes_per_session = parse_usize(name, &value)?,
            "--chunk-bytes" => config.chunk_bytes = parse_usize(name, &value)?,
            "--ack-delay-ms" => config.ack_delay_ms = parse_u64(name, &value)?,
            _ => return Err(format!("unknown argument: {name}")),
        }
    }
    validate_config(config)?;
    Ok(config)
}

fn parse_usize(name: &str, value: &str) -> Result<usize, String> {
    value
        .parse()
        .map_err(|_| format!("{name} must be a non-negative integer"))
}

fn parse_u64(name: &str, value: &str) -> Result<u64, String> {
    value
        .parse()
        .map_err(|_| format!("{name} must be a non-negative integer"))
}

fn validate_config(config: Config) -> Result<(), String> {
    if config.sessions == 0 {
        return Err("--sessions must be greater than zero".to_owned());
    }
    if config.bytes_per_session == 0 {
        return Err("--bytes-per-session must be greater than zero".to_owned());
    }
    if config.chunk_bytes == 0 || config.chunk_bytes > PRODUCTION_PTY_CHUNK_BYTES {
        return Err(format!(
            "--chunk-bytes must be between 1 and {PRODUCTION_PTY_CHUNK_BYTES}"
        ));
    }
    config
        .sessions
        .checked_mul(config.bytes_per_session)
        .ok_or_else(|| "total output bytes overflow usize".to_owned())?;
    Ok(())
}

fn insert_replay_validation_session(
    handler: &mut LocalSessionHandler,
    session_id: &str,
    chunk_bytes: usize,
) {
    handler.sessions.insert(
        session_id.to_owned(),
        LocalSession::terminal(
            session_id,
            "load-token",
            u64::MAX,
            PathBuf::from("/tmp"),
            Box::new(LoadTerminal {
                remaining_bytes: Arc::new(AtomicUsize::new(chunk_bytes)),
                chunk_bytes,
            }),
            u64::MAX,
        ),
    );
}

fn deliver_single_output(
    handler: &mut LocalSessionHandler,
    session_id: &str,
    consumer_id: &str,
) -> Result<(u64, String), String> {
    let (sequence, data) = match handler.drain_terminal_events().as_slice() {
        [TerminalEvent::Output {
            session_id: actual_session_id,
            consumer_id: actual_consumer_id,
            sequence,
            data,
        }] if actual_session_id == session_id
            && actual_consumer_id.as_deref() == Some(consumer_id) =>
        {
            (*sequence, data.clone())
        }
        _ => return Err("replay validation did not emit one matching output batch".to_owned()),
    };
    if !handler.begin_terminal_output_delivery(session_id, consumer_id, sequence)? {
        return Err("replay validation session closed during delivery".to_owned());
    }
    Ok((sequence, data))
}

fn validate_reconnect_replay(
    handler: &mut LocalSessionHandler,
    chunk_bytes: usize,
) -> Result<(), String> {
    const SESSION_ID: &str = "load-reconnect-validation";
    const INITIAL_CONSUMER_ID: &str = "load-consumer-initial";
    const RECONNECTED_CONSUMER_ID: &str = "load-consumer-reconnected";

    insert_replay_validation_session(handler, SESSION_ID, chunk_bytes);
    let initial_attach = handler.handle_terminal_attach(SESSION_ID, INITIAL_CONSUMER_ID, 0);
    if !initial_attach.success {
        return Err("failed to attach replay validation session".to_owned());
    }

    let initial_output = deliver_single_output(handler, SESSION_ID, INITIAL_CONSUMER_ID)?;
    if initial_output.0 != 1 {
        return Err("replay validation initial sequence was not one".to_owned());
    }

    // Backend registration resets delivery without replacing the active consumer.
    handler.prepare_terminal_reconnect();
    let backend_replay = deliver_single_output(handler, SESSION_ID, INITIAL_CONSUMER_ID)?;
    if backend_replay != initial_output {
        return Err("backend reconnect did not replay the unacknowledged output".to_owned());
    }

    let reconnect = handler.handle_terminal_attach(SESSION_ID, RECONNECTED_CONSUMER_ID, 0);
    if !reconnect.success {
        return Err("failed to replace replay validation consumer".to_owned());
    }
    let replay_output = deliver_single_output(handler, SESSION_ID, RECONNECTED_CONSUMER_ID)?;
    if replay_output != initial_output {
        return Err("reconnected consumer did not receive ordered replay".to_owned());
    }

    let stale_ack = handler.handle_terminal_ack(SESSION_ID, INITIAL_CONSUMER_ID, replay_output.0);
    if stale_ack.success {
        return Err("stale replay consumer ACK was accepted".to_owned());
    }
    let replay_ack =
        handler.handle_terminal_ack(SESSION_ID, RECONNECTED_CONSUMER_ID, replay_output.0);
    if !replay_ack.success {
        return Err("reconnected consumer could not acknowledge replay".to_owned());
    }
    handler.prepare_terminal_reconnect();
    if !handler.drain_terminal_events().is_empty() {
        return Err("backend reconnect replayed acknowledged output".to_owned());
    }
    if !handler
        .handle_terminal_close(SESSION_ID, RECONNECTED_CONSUMER_ID)
        .success
    {
        return Err("failed to close replay validation session".to_owned());
    }
    Ok(())
}

fn run_load(config: Config) -> Result<LoadReport, String> {
    let mut handler = LocalSessionHandler::new(
        "http://localhost",
        true,
        0,
        env::temp_dir(),
        Arc::new(LoadPtyManager),
    );
    validate_reconnect_replay(&mut handler, config.chunk_bytes)?;
    let mut states = Vec::with_capacity(config.sessions);
    let mut state_indexes = HashMap::with_capacity(config.sessions);

    for index in 0..config.sessions {
        let session_id = format!("load-terminal-{index}");
        let consumer_id = format!("load-consumer-{index}");
        let remaining_bytes = Arc::new(AtomicUsize::new(config.bytes_per_session));
        handler.sessions.insert(
            session_id.clone(),
            LocalSession::terminal(
                &session_id,
                "load-token",
                index as u64,
                PathBuf::from("/tmp"),
                Box::new(LoadTerminal {
                    remaining_bytes: Arc::clone(&remaining_bytes),
                    chunk_bytes: config.chunk_bytes,
                }),
                u64::MAX,
            ),
        );
        let attach = handler.handle_terminal_attach(&session_id, &consumer_id, 0);
        if !attach.success {
            return Err(format!(
                "failed to attach {session_id}: {}",
                attach.error.unwrap_or_else(|| "unknown error".to_owned())
            ));
        }
        state_indexes.insert(session_id.clone(), index);
        states.push(SessionState::new(session_id, consumer_id, remaining_bytes));
    }

    let expected_total_bytes = config.sessions * config.bytes_per_session;
    let ack_delay = Duration::from_millis(config.ack_delay_ms);
    let started_at = Instant::now();
    let deadline = started_at + load_timeout(config);
    let mut drain_cycles = 0;

    while !states
        .iter()
        .all(|state| state.is_complete(config.bytes_per_session))
    {
        if Instant::now() >= deadline {
            return Err(format!(
                "load timed out with {} of {expected_total_bytes} bytes delivered",
                states
                    .iter()
                    .map(|state| state.delivered_bytes)
                    .sum::<usize>()
            ));
        }

        drain_cycles += 1;
        let events = handler.drain_terminal_events();
        let mut emitted = vec![false; config.sessions];
        let mut made_progress = !events.is_empty();
        let delivered_at = Instant::now();

        for event in events {
            let TerminalEvent::Output {
                session_id,
                consumer_id,
                sequence,
                data,
            } = event
            else {
                return Err("terminal exited during load".to_owned());
            };
            let index = *state_indexes
                .get(&session_id)
                .ok_or_else(|| format!("received output for unknown session {session_id}"))?;
            let state = &mut states[index];
            if consumer_id.as_deref() != Some(state.consumer_id.as_str()) {
                return Err(format!(
                    "{} consumer mismatch: expected {}, received {consumer_id:?}",
                    state.session_id, state.consumer_id
                ));
            }
            if sequence != state.next_sequence {
                return Err(format!(
                    "{} sequence mismatch: expected {}, received {sequence}",
                    state.session_id, state.next_sequence
                ));
            }
            if data.is_empty() {
                return Err(format!("{} emitted empty output", state.session_id));
            }
            if state.delivered_bytes.saturating_add(data.len()) > config.bytes_per_session {
                return Err(format!(
                    "{} delivered more than {} bytes",
                    state.session_id, config.bytes_per_session
                ));
            }

            let started = handler
                .begin_terminal_output_delivery(&session_id, consumer_id.as_deref(), sequence)
                .map_err(|error| format!("{session_id} delivery failed: {error}"))?;
            if !started {
                return Err(format!("{session_id} closed during delivery"));
            }
            state.next_sequence += 1;
            state.delivered_bytes += data.len();
            state.replay_bytes += data.len();
            state.max_replay_bytes = state.max_replay_bytes.max(state.replay_bytes);
            state.output_events += 1;
            state.pending_acks.push_back(PendingAck {
                sequence,
                bytes: data.len(),
                due_at: delivered_at + ack_delay,
            });
            emitted[index] = true;

            if state.waiting_for_resume {
                state.resumed_after_low_watermark = true;
                state.waiting_for_resume = false;
            }
            if state.replay_bytes > REPLAY_LIMIT_BYTES {
                return Err(format!(
                    "{} replay reached {} bytes, above the {} byte limit",
                    state.session_id, state.replay_bytes, REPLAY_LIMIT_BYTES
                ));
            }
        }

        for (index, state) in states.iter_mut().enumerate() {
            let remaining = state.remaining_bytes.load(Ordering::Relaxed);
            if !emitted[index] && remaining > 0 && state.replay_bytes >= REPLAY_HIGH_WATERMARK_BYTES
            {
                state.backpressure_observed = true;
            }
        }

        let ack_time = Instant::now();
        for state in &mut states {
            let mut acknowledged_sequence = None;
            let mut acknowledged_bytes = 0;
            while state
                .pending_acks
                .front()
                .is_some_and(|ack| ack.due_at <= ack_time)
            {
                let ack = state
                    .pending_acks
                    .pop_front()
                    .expect("front ACK was checked");
                acknowledged_sequence = Some(ack.sequence);
                acknowledged_bytes += ack.bytes;
            }
            let Some(sequence) = acknowledged_sequence else {
                continue;
            };
            let result =
                handler.handle_terminal_ack(&state.session_id, &state.consumer_id, sequence);
            if !result.success {
                return Err(format!(
                    "{} ACK {} failed: {}",
                    state.session_id,
                    sequence,
                    result.error.unwrap_or_else(|| "unknown error".to_owned())
                ));
            }
            made_progress = true;
            state.acknowledged_bytes += acknowledged_bytes;
            state.replay_bytes = state.replay_bytes.saturating_sub(acknowledged_bytes);
            if state.backpressure_observed
                && state.remaining_bytes.load(Ordering::Relaxed) > 0
                && state.replay_bytes <= REPLAY_LOW_WATERMARK_BYTES
            {
                state.waiting_for_resume = true;
            }
        }

        if !made_progress {
            thread::sleep(Duration::from_millis(1));
        }
    }

    let elapsed = started_at.elapsed();
    validate_results(config, &states, expected_total_bytes)?;
    let delivered_bytes = states
        .iter()
        .map(|state| state.delivered_bytes)
        .sum::<usize>();
    let output_events = states.iter().map(|state| state.output_events).sum();
    let max_replay_bytes_per_session = states
        .iter()
        .map(|state| state.max_replay_bytes)
        .max()
        .unwrap_or_default();
    let elapsed_seconds = elapsed.as_secs_f64().max(f64::EPSILON);

    Ok(LoadReport {
        status: "passed",
        sessions: config.sessions,
        bytes_per_session: config.bytes_per_session,
        chunk_bytes: config.chunk_bytes,
        ack_delay_ms: config.ack_delay_ms,
        total_bytes: expected_total_bytes,
        delivered_bytes,
        output_events,
        drain_cycles,
        elapsed_ms: elapsed_seconds * 1000.0,
        throughput_mib_per_second: delivered_bytes as f64 / (1024.0 * 1024.0) / elapsed_seconds,
        max_replay_bytes_per_session,
        replay_limit_bytes: REPLAY_LIMIT_BYTES,
        replay_high_watermark_bytes: REPLAY_HIGH_WATERMARK_BYTES,
        replay_low_watermark_bytes: REPLAY_LOW_WATERMARK_BYTES,
        backpressure_sessions: states
            .iter()
            .filter(|state| state.backpressure_observed)
            .count(),
        resumed_sessions: states
            .iter()
            .filter(|state| state.resumed_after_low_watermark)
            .count(),
        reconnect_replay_validated: true,
    })
}

fn validate_results(
    config: Config,
    states: &[SessionState],
    expected_total_bytes: usize,
) -> Result<(), String> {
    let delivered_bytes = states
        .iter()
        .map(|state| state.delivered_bytes)
        .sum::<usize>();
    if delivered_bytes != expected_total_bytes {
        return Err(format!(
            "delivered {delivered_bytes} bytes, expected {expected_total_bytes}"
        ));
    }
    if let Some(state) = states
        .iter()
        .find(|state| state.max_replay_bytes > REPLAY_LIMIT_BYTES)
    {
        return Err(format!(
            "{} exceeded the bounded replay capacity",
            state.session_id
        ));
    }

    let backpressure_expected =
        config.ack_delay_ms > 0 && config.bytes_per_session > REPLAY_HIGH_WATERMARK_BYTES;
    if backpressure_expected {
        if let Some(state) = states.iter().find(|state| !state.backpressure_observed) {
            return Err(format!(
                "{} did not stop at the replay high watermark",
                state.session_id
            ));
        }
        if let Some(state) = states
            .iter()
            .find(|state| !state.resumed_after_low_watermark)
        {
            return Err(format!(
                "{} did not resume after ACK reduced replay below the low watermark",
                state.session_id
            ));
        }
    }
    Ok(())
}

fn load_timeout(config: Config) -> Duration {
    let replay_windows = config
        .bytes_per_session
        .div_ceil(REPLAY_HIGH_WATERMARK_BYTES) as u64;
    let ack_budget_ms = config
        .ack_delay_ms
        .saturating_mul(replay_windows.saturating_add(2))
        .saturating_mul(4);
    Duration::from_millis(ack_budget_ms.max(10_000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_report_requires_reconnect_replay_validation() {
        let report = run_load(Config {
            sessions: 2,
            ack_delay_ms: 0,
            ..Config::default()
        })
        .expect("load validation must pass");

        assert!(report.reconnect_replay_validated);
        assert_eq!(report.status, "passed");
        assert_eq!(report.delivered_bytes, report.total_bytes);
    }
}
