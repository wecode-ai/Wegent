// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use wegent_executor::agents::{CodexCancellationState, CodexTurnInterrupter};

#[tokio::test]
async fn codex_cancel_interrupts_active_turn() {
    let interrupter = RecordingInterrupter::default();
    let mut state = CodexCancellationState::default();
    state.mark_turn_started("thread-1", "turn-1");

    let cancelled = state.cancel(&interrupter).await;

    assert!(cancelled);
    assert_eq!(
        interrupter.calls.lock().unwrap().as_slice(),
        [("thread-1".to_owned(), "turn-1".to_owned())]
    );
    assert!(!state.cancel_requested());
}

#[tokio::test]
async fn codex_cancel_records_pending_request_without_active_turn() {
    let interrupter = RecordingInterrupter::default();
    let mut state = CodexCancellationState::default();

    let cancelled = state.cancel(&interrupter).await;

    assert!(cancelled);
    assert!(state.cancel_requested());
    assert!(interrupter.calls.lock().unwrap().is_empty());
    assert!(state.consume_pending_cancel());
    assert!(!state.cancel_requested());
}

#[derive(Debug, Clone, Default)]
struct RecordingInterrupter {
    calls: Arc<Mutex<Vec<(String, String)>>>,
}

impl CodexTurnInterrupter for RecordingInterrupter {
    fn interrupt_turn<'a>(
        &'a self,
        thread_id: &'a str,
        turn_id: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push((thread_id.to_owned(), turn_id.to_owned()));
            Ok(())
        })
    }
}
