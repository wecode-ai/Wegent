use std::sync::Arc;

use wegent_backend_rs::{Application, HybridConfig, run_hybrid};

#[cfg(test)]
mod json_contract_tests;
mod wecode;

fn main() -> Result<(), wegent_backend_rs::BoxError> {
    // Export the dotenv entries before anything spawns a thread: `env::set_var`
    // races with concurrent environment reads, and both the logging writer and
    // the Tokio runtime start their own threads. Modules that read the
    // environment directly, such as the remote-workspace status config, only
    // observe settings like REDIS_URL through this export.
    wegent_backend_rs::config::init_env();

    // Keep the guard alive until the gateway has stopped so its worker can
    // flush the final events before process exit.
    let logs = brz_logs::init_default()?;

    let runtime = tokio::runtime::Runtime::new()?;
    let result = runtime.block_on(run());
    logs.flush()?;
    result
}

async fn run() -> Result<(), wegent_backend_rs::BoxError> {
    let public_state = wegent_backend_rs::build_app_state().await?;
    let state = wecode::build_app_state(public_state).await?;
    let public = Application::build(Arc::clone(state.public())).await?;
    let application = public.with_routes(wecode::routes(state)?);
    let config = HybridConfig::from_env()?;
    run_hybrid(config, application).await
}
