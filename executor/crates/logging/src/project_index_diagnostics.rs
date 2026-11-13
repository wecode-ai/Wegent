// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Opt-in stage timing without state contents, paths or process command lines.
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct Stage {
    name: &'static str,
    timing: Option<(u64, Instant)>,
}

impl Stage {
    pub fn start(name: &'static str) -> Self {
        let timing = (std::env::var("WEWORK_PROJECT_INDEX_DIAGNOSTICS").as_deref() == Ok("1"))
            .then(|| (NEXT_ID.fetch_add(1, Ordering::Relaxed), Instant::now()));
        let stage = Self { name, timing };
        stage.log("begin");
        stage
    }

    fn log(&self, status: &str) {
        if let Some((id, started)) = self.timing {
            crate::log_executor_event(
                "project index stage",
                &[
                    ("id", id.to_string()),
                    ("thread", format!("{:?}", std::thread::current().id())),
                    ("stage", self.name.into()),
                    ("status", status.into()),
                    ("elapsed_ms", started.elapsed().as_millis().to_string()),
                ],
            );
        }
    }
}

impl Drop for Stage {
    fn drop(&mut self) {
        self.log("end")
    }
}

pub fn trace<T>(name: &'static str, action: impl FnOnce() -> T) -> T {
    let _stage = Stage::start(name);
    action()
}

#[cfg(test)]
mod tests {
    use super::trace;

    #[test]
    fn tracing_preserves_the_operation_result_and_invokes_it_once() {
        let mut calls = 0;
        let result: Result<usize, &str> = trace("test.operation", || {
            calls += 1;
            Ok(7)
        });
        assert_eq!(calls, 1);
        assert_eq!(result, Ok(7));
        assert_eq!(
            trace("test.failure", || Err::<(), _>("original")),
            Err("original")
        );
    }
}
