//! Rust background jobs, assembled after deployment-specific state injection.

mod cleanup;
mod client;
pub mod config;
mod device;
mod download;
pub(crate) mod execution;
pub(crate) mod git_credentials;
mod lock;
mod maintenance;
pub mod notifications;
mod registry;
mod runtime;
mod stale_executor;
pub use stale_executor::cleanup_stale_task_executor;
pub(crate) mod robot;
pub(crate) mod subscription;

pub(crate) mod knowledge;
mod plugins;
pub(crate) mod project;
pub mod video;

pub use brz_schedule::{Completion, HandlerOptions, JobContext, SubmitResult};
pub use client::BackgroundJobsClient;
pub use lock::with_lock_watchdog;
pub use registry::BackgroundJobRegistry;
pub(crate) use runtime::BackgroundJobsRuntime;

use std::sync::Arc;

pub(crate) fn register_public_jobs(
    registry: &mut BackgroundJobRegistry,
    state: Arc<crate::AppState>,
) -> anyhow::Result<()> {
    maintenance::register(registry, state.clone())?;
    cleanup::register(registry, state.clone())?;
    device::register(registry, state.clone())?;
    project::register(registry, state.clone())?;
    robot::register(registry, state.clone())?;
    subscription::register(registry, state.clone())?;
    knowledge::register(registry, state.clone())?;
    plugins::register(registry, state.clone())?;
    video::register(registry, state)?;
    Ok(())
}
