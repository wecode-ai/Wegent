//! Rust background jobs, assembled after deployment-specific state injection.

mod cleanup;
mod configuration;
pub(crate) use configuration::client_from_env;
pub use wegent_job_runtime::config;
mod device;
pub(crate) mod execution;
pub(crate) mod git_credentials;

mod maintenance;
pub mod notifications;

mod stale_executor;
pub use stale_executor::cleanup_stale_task_executor;
pub(crate) mod robot;
pub(crate) mod subscription;

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
    wegent_runtime_observations::register_jobs(
        registry,
        Arc::new(crate::runtime_observations::job_state(state.clone())),
    )?;
    project::register(registry, state.clone())?;
    robot::register(registry, state.clone())?;
    subscription::register(registry, state.clone())?;
    wegent_knowledge_jobs::register(
        registry,
        Arc::new(wegent_knowledge_jobs::KnowledgeJobState {
            mysql: state.mysql.clone(),
            redis: state.redis.clone(),
            background_jobs: state.background_jobs.clone(),
            attachment_upload: Arc::clone(&state.attachment_upload),
            entity_resolvers: state.entity_resolvers.clone(),
            celery: state.celery.clone(),
            jwt_key: state.auth.jwt_key.clone(),
            jwt_algorithm: state.auth.algorithm.clone(),
            attachment_http: state.attachment_http.clone(),
            chat: Arc::new(execution::AppBackgroundChat(Arc::clone(&state))),
        }),
    )?;
    plugins::register(registry, state.clone())?;
    video::register(registry, state)?;
    Ok(())
}
