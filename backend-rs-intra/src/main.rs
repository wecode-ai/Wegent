use std::sync::Arc;

use wegent_backend_rs::{Application, HybridConfig, run_hybrid};

#[cfg(test)]
mod json_contract_tests;
mod wecode;

#[tokio::main]
async fn main() -> Result<(), wegent_backend_rs::BoxError> {
    // Keep the guard alive until the gateway has stopped so its worker can
    // flush the final events before process exit.
    let logs = brz_logs::init_default()?;

    // Resolve `--env-file` / `WEGENT_ENV_FILE` before any configuration is read.
    wegent_backend_rs::config::init_env_file();

    let public_state = wegent_backend_rs::build_app_state().await?;
    let state = wecode::build_app_state(public_state).await?;
    let public = Application::build(Arc::clone(state.public())).await?;
    let application = public.with_routes(wecode::routes(state)?);
    let config = HybridConfig::from_env()?;
    let result = run_hybrid(config, application).await;
    logs.flush()?;
    result
}
