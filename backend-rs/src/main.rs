// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use wegent_backend_rs::{Application, HybridConfig, build_app_state, run_hybrid};

#[tokio::main]
async fn main() -> Result<(), wegent_backend_rs::BoxError> {
    // Keep the guard alive until the gateway has stopped so its worker can
    // flush the final events before process exit.
    let logs = brz_logs::init_default()?;

    // Resolve `--env-file` / `WEGENT_ENV_FILE` before any configuration is read.
    wegent_backend_rs::config::init_env_file();

    let config = HybridConfig::from_env()?;
    let state = Arc::new(build_app_state().await?);
    let application = Application::build(state).await?;
    let result = run_hybrid(config, application).await;
    logs.flush()?;
    result
}
