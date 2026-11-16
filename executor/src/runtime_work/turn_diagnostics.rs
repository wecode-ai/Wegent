// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::Instant;

use crate::logging::log_executor_event;

pub(crate) struct TurnStage<'a> {
    task_id: &'a str,
    phase: &'static str,
    started: Instant,
}

impl<'a> TurnStage<'a> {
    pub(crate) fn start(task_id: &'a str, phase: &'static str) -> Self {
        Self::since(task_id, phase, Instant::now())
    }

    pub(crate) fn since(task_id: &'a str, phase: &'static str, started: Instant) -> Self {
        Self {
            task_id,
            phase,
            started,
        }
    }
}

impl Drop for TurnStage<'_> {
    fn drop(&mut self) {
        let elapsed = self.started.elapsed().as_millis();
        if elapsed >= 250 {
            log_executor_event(
                "runtime work turn slow stage",
                &[
                    ("local_task_id", self.task_id.to_owned()),
                    ("phase", self.phase.to_owned()),
                    ("elapsed_ms", elapsed.to_string()),
                ],
            );
        }
    }
}
