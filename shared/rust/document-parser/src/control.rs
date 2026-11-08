//! Cooperative controls supplied by the host, independent of any runtime or account.
use std::{sync::Arc, time::Instant};

#[derive(Clone, Default)]
pub struct ParseControl {
    deadline: Option<Instant>,
    cancelled: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl ParseControl {
    pub fn new(
        deadline: Option<Instant>,
        cancelled: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            deadline,
            cancelled: Some(Arc::new(cancelled)),
        }
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        if self.cancelled.as_ref().is_some_and(|cancelled| cancelled()) {
            return Err("Document parsing cancelled".into());
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err("Document parsing deadline exceeded".into());
        }
        Ok(())
    }
}
