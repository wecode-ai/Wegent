use std::sync::Arc;

use wegent_backend_rs::{AppState, HybridConfig, PublicApi, run_hybrid};

#[tokio::main]
async fn main() -> Result<(), wegent_backend_rs::BoxError> {
    // Keep the guard alive until the gateway has stopped so its worker can
    // flush the final events before process exit.
    let logs = brz_logs::init_default()?;

    let config = HybridConfig::from_env()?;
    let state = Arc::new(AppState::default());
    let api = PublicApi::new(state);
    let result = run_hybrid(config, api).await;
    logs.flush()?;
    result
}
