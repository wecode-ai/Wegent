//! Opt-in stage timing without state contents, paths or process command lines.
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub(super) struct Stage {
    name: &'static str,
    timing: Option<(u64, Instant)>,
}

impl Stage {
    pub(super) fn start(name: &'static str) -> Self {
        let timing = (std::env::var("WEWORK_PROJECT_INDEX_DIAGNOSTICS").as_deref() == Ok("1"))
            .then(|| (NEXT_ID.fetch_add(1, Ordering::Relaxed), Instant::now()));
        let stage = Self { name, timing };
        stage.log("begin");
        stage
    }

    fn log(&self, status: &str) {
        if let Some((id, started)) = self.timing {
            crate::logging::log_executor_event(
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

pub(super) fn trace<T>(name: &'static str, action: impl FnOnce() -> T) -> T {
    let _stage = Stage::start(name);
    action()
}
