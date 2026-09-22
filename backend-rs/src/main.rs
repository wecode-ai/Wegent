// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use wegent_backend_rs::{Application, HybridConfig, build_app_state, run_hybrid};

fn main() -> Result<(), wegent_backend_rs::BoxError> {
    // Resolve `--env-file` / `WEGENT_BACKEND_RS_ENV_FILE` and export the dotenv
    // entries before anything spawns a thread: `env::set_var` races with
    // concurrent environment reads, and both the logging writer and the Tokio
    // runtime start their own threads.
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
    let config = HybridConfig::from_env()?;
    let state = Arc::new(build_app_state().await?);
    let application = Application::build(state).await?;
    run_hybrid(config, application).await
}
