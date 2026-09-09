// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    Output {
        session_id: String,
        consumer_id: Option<String>,
        sequence: u64,
        data: String,
    },
    Exit {
        session_id: String,
        consumer_id: Option<String>,
        exit_code: Option<u32>,
        error: Option<String>,
    },
}

impl TerminalUtf8Decoder {
    fn decode(&mut self, input: Vec<u8>) -> String {
        if input.is_empty() {
            return String::new();
        }
        let bytes = if self.pending_len == 0 {
            input
        } else {
            let mut combined = Vec::with_capacity(self.pending_len + input.len());
            combined.extend_from_slice(&self.pending[..self.pending_len]);
            combined.extend_from_slice(&input);
            self.pending_len = 0;
            combined
        };
        match String::from_utf8(bytes) {
            Ok(data) => data,
            Err(error) => self.decode_lossy_prefix(&error.into_bytes()),
        }
    }

    fn finish(&mut self) -> String {
        if self.pending_len == 0 {
            return String::new();
        }
        self.pending_len = 0;
        "\u{fffd}".to_owned()
    }

    fn decode_lossy_prefix(&mut self, bytes: &[u8]) -> String {
        let mut decoded = String::with_capacity(bytes.len());
        let mut remaining = bytes;
        while !remaining.is_empty() {
            match std::str::from_utf8(remaining) {
                Ok(valid) => {
                    decoded.push_str(valid);
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    decoded.push_str(
                        std::str::from_utf8(&remaining[..valid_up_to])
                            .expect("UTF-8 validator reported an invalid valid prefix"),
                    );
                    match error.error_len() {
                        Some(invalid_len) => {
                            decoded.push('\u{fffd}');
                            remaining = &remaining[valid_up_to + invalid_len..];
                        }
                        None => {
                            let incomplete = &remaining[valid_up_to..];
                            debug_assert!(incomplete.len() <= MAX_UTF8_PENDING_BYTES);
                            self.pending[..incomplete.len()].copy_from_slice(incomplete);
                            self.pending_len = incomplete.len();
                            break;
                        }
                    }
                }
            }
        }
        decoded
    }
}

impl LocalSession {
    fn attach_terminal(
        &mut self,
        protocol: TerminalProtocol,
        consumer_id: Option<&str>,
        last_acked_sequence: u64,
    ) -> Result<(), String> {
        if self
            .terminal_protocol
            .is_some_and(|pinned| pinned != protocol)
        {
            return Err("Terminal protocol cannot change on an existing session".to_owned());
        }
        if protocol == TerminalProtocol::V2
            && !consumer_id.is_some_and(|consumer| !consumer.trim().is_empty())
        {
            return Err("consumer_id is required".to_owned());
        }
        let last_acked_sequence = if protocol == TerminalProtocol::V1 {
            self.terminal_acked_sequence
        } else {
            last_acked_sequence
        };
        let was_attached = self.terminal_attached;
        let latest_sequence = self.terminal_next_sequence.saturating_sub(1);
        if last_acked_sequence < self.terminal_acked_sequence {
            return Err("Terminal replay history is no longer available".to_owned());
        }
        if last_acked_sequence > self.terminal_highest_sent_sequence
            || last_acked_sequence > latest_sequence
        {
            return Err("last_acked_sequence exceeds sent terminal output".to_owned());
        }
        self.acknowledge_terminal_output(last_acked_sequence)?;
        subtract_metric(&TERMINAL_ACK_LAG_BYTES, self.terminal_ack_lag_bytes);
        self.terminal_ack_lag_bytes = 0;
        self.terminal_last_sent_sequence = last_acked_sequence;
        self.terminal_attached = true;
        self.terminal_protocol = Some(protocol);
        self.terminal_consumer_id = consumer_id.map(str::to_owned);
        if was_attached {
            let replayed_batches = self
                .terminal_replay
                .iter()
                .filter(|record| record.sequence > last_acked_sequence)
                .count() as u64;
            TERMINAL_REPLAYED_BATCHES_TOTAL.fetch_add(replayed_batches, Ordering::Relaxed);
        }
        Ok(())
    }

    fn acknowledge_terminal_output(&mut self, sequence: u64) -> Result<bool, String> {
        if sequence <= self.terminal_acked_sequence {
            return Ok(false);
        }
        if sequence > self.terminal_highest_sent_sequence {
            return Err("Terminal output sequence has not been sent".to_owned());
        }
        let mut acknowledged_bytes = 0;
        while self
            .terminal_replay
            .front()
            .is_some_and(|record| record.sequence <= sequence)
        {
            if let Some(record) = self.terminal_replay.pop_front() {
                acknowledged_bytes += record.data.len();
                self.terminal_replay_bytes =
                    self.terminal_replay_bytes.saturating_sub(record.data.len());
            }
        }
        self.terminal_ack_lag_bytes = self
            .terminal_ack_lag_bytes
            .saturating_sub(acknowledged_bytes);
        subtract_metric(&TERMINAL_REPLAY_BYTES, acknowledged_bytes);
        subtract_metric(&TERMINAL_ACK_LAG_BYTES, acknowledged_bytes);
        self.terminal_acked_sequence = sequence;
        let resumed = self.terminal_backpressured
            && self.terminal_replay_bytes <= TERMINAL_REPLAY_LOW_WATERMARK_BYTES;
        if resumed {
            self.terminal_backpressured = false;
            subtract_metric(&TERMINAL_BACKPRESSURED_SESSIONS, 1);
        }
        Ok(resumed)
    }

    fn unsent_terminal_output(&self, limit: usize) -> Vec<TerminalEvent> {
        self.terminal_replay
            .iter()
            .filter(|record| record.sequence > self.terminal_last_sent_sequence)
            .take(limit)
            .map(|record| TerminalEvent::Output {
                session_id: self.session_id.clone(),
                consumer_id: self.terminal_consumer_id.clone(),
                sequence: record.sequence,
                data: record.data.clone(),
            })
            .collect()
    }

    fn record_terminal_output(&mut self, data: String) -> Result<TerminalEvent, String> {
        if self.terminal_replay_bytes.saturating_add(data.len()) > TERMINAL_REPLAY_MAX_BYTES {
            return Err("Terminal output exceeded the bounded replay capacity".to_owned());
        }
        let sequence = self.terminal_next_sequence;
        self.terminal_next_sequence = self
            .terminal_next_sequence
            .checked_add(1)
            .ok_or_else(|| "Terminal output sequence exhausted".to_owned())?;
        self.terminal_replay_bytes += data.len();
        TERMINAL_OUTPUT_BATCHES_TOTAL.fetch_add(1, Ordering::Relaxed);
        TERMINAL_OUTPUT_BYTES_TOTAL.fetch_add(data.len() as u64, Ordering::Relaxed);
        TERMINAL_REPLAY_BYTES.fetch_add(data.len() as u64, Ordering::Relaxed);
        self.terminal_replay.push_back(TerminalOutputRecord {
            sequence,
            data: data.clone(),
        });
        if !self.terminal_backpressured
            && self.terminal_replay_bytes >= TERMINAL_REPLAY_HIGH_WATERMARK_BYTES
        {
            self.terminal_backpressured = true;
            TERMINAL_BACKPRESSURED_SESSIONS.fetch_add(1, Ordering::Relaxed);
        }
        Ok(TerminalEvent::Output {
            session_id: self.session_id.clone(),
            consumer_id: self.terminal_consumer_id.clone(),
            sequence,
            data,
        })
    }

    fn begin_terminal_output_delivery(&mut self, sequence: u64) -> Result<(), String> {
        let expected_sequence = self.terminal_last_sent_sequence.saturating_add(1);
        let Some(record) = self
            .terminal_replay
            .iter()
            .find(|record| record.sequence == sequence)
        else {
            return Err("Terminal output delivery sequence is out of order".to_owned());
        };
        if sequence != expected_sequence {
            return Err("Terminal output delivery sequence is out of order".to_owned());
        }
        self.terminal_ack_lag_bytes += record.data.len();
        TERMINAL_ACK_LAG_BYTES.fetch_add(record.data.len() as u64, Ordering::Relaxed);
        self.terminal_last_sent_sequence = sequence;
        self.terminal_highest_sent_sequence = self.terminal_highest_sent_sequence.max(sequence);
        Ok(())
    }

    fn require_terminal_consumer(&self, consumer_id: &str) -> Result<(), String> {
        if self.terminal_protocol != Some(TerminalProtocol::V2) {
            return Err("Terminal consumer ACK requires protocol v2".to_owned());
        }
        self.require_terminal_control(Some(consumer_id))
    }

    fn require_terminal_control(&self, consumer_id: Option<&str>) -> Result<(), String> {
        if !self.terminal_attached
            || (self.terminal_protocol != Some(TerminalProtocol::V1)
                && (consumer_id.is_none() || self.terminal_consumer_id.as_deref() != consumer_id))
        {
            return Err("Terminal consumer is no longer active".to_owned());
        }
        Ok(())
    }
}

impl LocalSessionHandler {
    pub fn handle_terminal_input<'a>(
        &mut self,
        session_id: &str,
        consumer_id: impl Into<Option<&'a str>>,
        data: &str,
    ) -> SessionResult {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::error("Terminal session not found");
        };
        if let Err(error) = session.require_terminal_control(consumer_id.into()) {
            return SessionResult::error(error);
        }
        let Some(terminal) = session.terminal.as_mut() else {
            return SessionResult::error("Terminal session not found");
        };
        if terminal.write(data.as_bytes()).is_err() {
            return SessionResult::error("Terminal session is not writable");
        }
        SessionResult::success()
    }

    pub fn handle_terminal_attach(
        &mut self,
        session_id: &str,
        consumer_id: &str,
        last_acked_sequence: u64,
    ) -> SessionResult {
        self.attach_terminal_session(
            session_id,
            TerminalProtocol::V2,
            Some(consumer_id),
            last_acked_sequence,
        )
    }

    pub fn handle_legacy_terminal_attach(&mut self, session_id: &str) -> SessionResult {
        self.attach_terminal_session(session_id, TerminalProtocol::V1, None, 0)
    }

    fn attach_terminal_session(
        &mut self,
        session_id: &str,
        protocol: TerminalProtocol,
        consumer_id: Option<&str>,
        last_acked_sequence: u64,
    ) -> SessionResult {
        let notifier = Arc::clone(&self.terminal_event_notifier);
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::error("Terminal session not found");
        };
        if let Err(error) = session.attach_terminal(protocol, consumer_id, last_acked_sequence) {
            return SessionResult::error(error);
        }
        if let Some(terminal) = session.terminal.as_mut() {
            terminal.set_event_notifier(Arc::clone(&notifier));
        }
        notifier.notify_one();
        SessionResult::success()
    }

    pub fn handle_terminal_ack(
        &mut self,
        session_id: &str,
        consumer_id: &str,
        sequence: u64,
    ) -> SessionResult {
        let notifier = Arc::clone(&self.terminal_event_notifier);
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::error("Terminal session not found");
        };
        if let Err(error) = session.require_terminal_consumer(consumer_id) {
            return SessionResult::error(error);
        }
        let had_replay = !session.terminal_replay.is_empty();
        let resumed = match session.acknowledge_terminal_output(sequence) {
            Ok(resumed) => resumed,
            Err(error) => return SessionResult::error(error),
        };
        if resumed
            || (had_replay && session.terminal_replay.is_empty() && session.terminal_exit.is_some())
        {
            notifier.notify_one();
        }
        SessionResult::success()
    }

    pub fn begin_terminal_output_delivery<'a>(
        &mut self,
        session_id: &str,
        consumer_id: impl Into<Option<&'a str>>,
        sequence: u64,
    ) -> Result<bool, String> {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return Ok(false);
        };
        if session
            .require_terminal_control(consumer_id.into())
            .is_err()
        {
            self.terminal_event_notifier.notify_one();
            return Ok(false);
        }
        session.begin_terminal_output_delivery(sequence)?;
        Ok(true)
    }

    /// V1 confirms only Backend acceptance, never browser consumption. V2 ignores this ACK.
    pub fn complete_terminal_output_delivery(
        &mut self,
        session_id: &str,
        sequence: u64,
    ) -> Result<(), String> {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return Ok(());
        };
        if session.terminal_protocol == Some(TerminalProtocol::V1) {
            session.acknowledge_terminal_output(sequence)?;
            session.terminal_last_sent_sequence = session.terminal_last_sent_sequence.max(sequence);
            self.terminal_event_notifier.notify_one();
        }
        Ok(())
    }

    pub fn retry_terminal_output_delivery(&mut self, session_id: &str, sequence: u64) -> bool {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return false;
        };
        if session.terminal_acked_sequence >= sequence {
            session.terminal_last_sent_sequence = session.terminal_acked_sequence;
            return true;
        }
        let Some(record) = session
            .terminal_replay
            .iter()
            .find(|record| record.sequence == sequence)
        else {
            return true;
        };
        session.terminal_last_sent_sequence = sequence.saturating_sub(1);
        session.terminal_ack_lag_bytes = session
            .terminal_ack_lag_bytes
            .saturating_sub(record.data.len());
        subtract_metric(&TERMINAL_ACK_LAG_BYTES, record.data.len());
        true
    }

    pub fn complete_terminal_exit<'a>(
        &mut self,
        session_id: &str,
        consumer_id: impl Into<Option<&'a str>>,
    ) -> Result<(), String> {
        let Some(session) = self.sessions.get(session_id) else {
            return Ok(());
        };
        session.require_terminal_control(consumer_id.into())?;
        if session.session_type != SessionType::Terminal
            || session.terminal_exit.is_none()
            || !session.terminal_replay.is_empty()
        {
            return Err("Terminal exit is not ready for completion".to_owned());
        }
        self.sessions.remove(session_id);
        Ok(())
    }

    pub fn prepare_terminal_reconnect(&mut self) {
        let mut should_notify = false;
        for session in self.sessions.values_mut().filter(|session| {
            session.session_type == SessionType::Terminal && session.terminal_attached
        }) {
            subtract_metric(&TERMINAL_ACK_LAG_BYTES, session.terminal_ack_lag_bytes);
            session.terminal_ack_lag_bytes = 0;
            session.terminal_last_sent_sequence = session.terminal_acked_sequence;
            should_notify |= !session.terminal_replay.is_empty() || session.terminal_exit.is_some();
        }
        if should_notify {
            self.terminal_event_notifier.notify_one();
        }
    }

    pub fn reap_expired_sessions(&mut self) -> usize {
        let now = epoch_seconds();
        let expired = self
            .sessions
            .values()
            .filter(|session| session.expires_at <= now)
            .map(|session| session.session_id.clone())
            .collect::<Vec<_>>();
        for session_id in &expired {
            let _ = self.close_terminal_session(session_id);
        }
        expired.len()
    }

    pub fn handle_terminal_resize<'a>(
        &mut self,
        session_id: &str,
        consumer_id: impl Into<Option<&'a str>>,
        rows: u16,
        cols: u16,
    ) -> SessionResult {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::error("Terminal session not found");
        };
        if let Err(error) = session.require_terminal_control(consumer_id.into()) {
            return SessionResult::error(error);
        }
        let Some(terminal) = session.terminal.as_mut() else {
            return SessionResult::error("Terminal session not found");
        };
        if terminal.resize(rows.max(1), cols.max(1)).is_err() {
            return SessionResult::error("Terminal session is not resizable");
        }
        SessionResult::success()
    }

    pub fn handle_terminal_close<'a>(
        &mut self,
        session_id: &str,
        consumer_id: impl Into<Option<&'a str>>,
    ) -> SessionResult {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::success();
        };
        if let Err(error) = session.require_terminal_control(consumer_id.into()) {
            return SessionResult::error(error);
        }
        self.close_terminal_session(session_id)
    }

    fn close_terminal_session(&mut self, session_id: &str) -> SessionResult {
        let Some(mut session) = self.sessions.remove(session_id) else {
            return SessionResult::success();
        };
        if let Some(mut terminal) = session.terminal.take() {
            let _ = terminal.poll();
            terminal.terminate(false);
            terminal.close();
        }
        SessionResult::success()
    }

    pub fn drain_terminal_events(&mut self) -> Vec<TerminalEvent> {
        let notifier = Arc::clone(&self.terminal_event_notifier);
        let mut session_ids = self
            .sessions
            .values()
            .filter(|session| {
                session.session_type == SessionType::Terminal && session.terminal_attached
            })
            .map(|session| session.session_id.clone())
            .collect::<Vec<_>>();
        session_ids.sort();
        if session_ids.len() > MAX_TERMINAL_SESSIONS_PER_DRAIN {
            let session_count = session_ids.len();
            let start = self.terminal_drain_offset % session_count;
            session_ids.rotate_left(start);
            session_ids.truncate(MAX_TERMINAL_SESSIONS_PER_DRAIN);
            self.terminal_drain_offset = (start + MAX_TERMINAL_SESSIONS_PER_DRAIN) % session_count;
            notifier.notify_one();
        } else {
            self.terminal_drain_offset = 0;
        }
        let mut events = Vec::new();

        for session_id in session_ids {
            let Some(session) = self.sessions.get_mut(&session_id) else {
                continue;
            };
            let mut session_events = session.unsent_terminal_output(MAX_TERMINAL_READS_PER_DRAIN);
            let mut remaining_capacity =
                MAX_TERMINAL_READS_PER_DRAIN.saturating_sub(session_events.len());
            let unsent_count = session
                .terminal_replay
                .iter()
                .filter(|record| record.sequence > session.terminal_last_sent_sequence)
                .count();
            if unsent_count > 0 {
                if unsent_count > session_events.len() {
                    notifier.notify_one();
                }
                events.extend(session_events);
                continue;
            }

            let mut data = String::new();
            let mut terminal_error = None;
            let mut read_limit_reached = false;

            while remaining_capacity > 0
                && !session.terminal_backpressured
                && session.terminal_replay_bytes.saturating_add(data.len())
                    < TERMINAL_REPLAY_HIGH_WATERMARK_BYTES
            {
                let read_result = match session.terminal.as_mut() {
                    Some(terminal) => terminal.read_available(Duration::ZERO),
                    None => break,
                };
                match read_result {
                    Ok(Some(chunk)) if chunk.is_empty() => {
                        break;
                    }
                    Ok(Some(chunk)) => {
                        data.push_str(&session.terminal_utf8_decoder.decode(chunk));
                        remaining_capacity -= 1;
                        read_limit_reached = remaining_capacity == 0;
                    }
                    Ok(None) => break,
                    Err(error) => {
                        terminal_error = Some(format!("Failed to read terminal output: {error}"));
                        break;
                    }
                }
            }

            if read_limit_reached && !session.terminal_backpressured {
                notifier.notify_one();
            }

            let mut exit_code = None;
            if session.terminal_exit.is_none() {
                let exit_result = session.terminal.as_mut().map(|terminal| {
                    let output_closed = terminal.output_closed();
                    (terminal.poll(), output_closed)
                });
                exit_code = match exit_result {
                    Some((Ok(Some(exit_code)), true)) => Some(exit_code),
                    Some((Ok(_), _)) | None => None,
                    Some((Err(error), _)) => {
                        terminal_error =
                            Some(format!("Failed to poll terminal process status: {error}"));
                        None
                    }
                };
            }

            let terminal_finished = exit_code.is_some() || terminal_error.is_some();
            if terminal_finished {
                data.push_str(&session.terminal_utf8_decoder.finish());
            }
            if !data.is_empty() {
                match session.record_terminal_output(data) {
                    Ok(event) => session_events.push(event),
                    Err(error) => terminal_error = Some(error),
                }
            }

            if session.terminal_exit.is_none() && (exit_code.is_some() || terminal_error.is_some())
            {
                if terminal_error.is_some() {
                    if let Some(terminal) = session.terminal.as_mut() {
                        terminal.terminate(false);
                    }
                }
                if let Some(mut terminal) = session.terminal.take() {
                    terminal.close();
                }
                session.terminal_exit = Some(TerminalExitRecord {
                    exit_code,
                    error: terminal_error,
                });
            }

            events.extend(session_events);
            if session.terminal_replay.is_empty() {
                if let Some(exit) = &session.terminal_exit {
                    events.push(TerminalEvent::Exit {
                        session_id: session_id.clone(),
                        consumer_id: session.terminal_consumer_id.clone(),
                        exit_code: exit.exit_code,
                        error: exit.error.clone(),
                    });
                }
            }
        }

        events
    }
}
