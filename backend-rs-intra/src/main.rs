use std::sync::Arc;

use wegent_backend_rs::{Application, HybridConfig, run_hybrid};

use crate::wecode::WecodeAppState;

mod wecode;

#[tokio::main]
async fn main() -> Result<(), wegent_backend_rs::BoxError> {
    // Keep the guard alive until the gateway has stopped so its worker can
    // flush the final events before process exit.
    let logs = brz_logs::init_default()?;

    // Resolve `--env-file` / `WEGENT_ENV_FILE` before any configuration is read.
    wegent_backend_rs::config::init_env_file();

    let state = Arc::new(WecodeAppState::from_env()?);
    let public = Application::build(Arc::clone(state.public()))?;
    let application = public.with_routes(wecode::routes(state)?);
    let config = HybridConfig::from_env()?;
    let result = run_hybrid(config, application).await;
    logs.flush()?;
    result
}
