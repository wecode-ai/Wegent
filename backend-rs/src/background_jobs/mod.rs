//! Rust background jobs, assembled after deployment-specific state injection.

mod cleanup;
pub(crate) use wegent_job_runtime::client;
pub use wegent_job_runtime::config;
mod device;
mod download;
pub(crate) mod execution;
pub(crate) mod git_credentials;

mod maintenance;
pub mod notifications;

mod stale_executor;
pub use stale_executor::cleanup_stale_task_executor;
pub(crate) mod robot;
pub(crate) mod subscription;

pub(crate) mod knowledge;
pub(crate) mod plugins;
pub(crate) mod project;
pub mod video;

pub use brz_schedule::{Completion, HandlerOptions, JobContext, SubmitResult};
pub use wegent_job_runtime::BackgroundJobRegistry;
pub use wegent_job_runtime::BackgroundJobsClient;
pub(crate) use wegent_job_runtime::BackgroundJobsRuntime;
pub use wegent_job_runtime::with_lock_watchdog;

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
