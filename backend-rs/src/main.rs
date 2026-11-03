// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Arc, Mutex};
use std::time::Instant;

use wegent_backend_rs::{
    Application, HybridConfig, ReporterRuntime, build_app_state, serve_hybrid_application,
    shutdown_signal,
};

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
    let process_deadline = Arc::new(Mutex::new(None));
    let signal_deadline = Arc::clone(&process_deadline);
    let shutdown_grace = config.shutdown_grace;
    let shutdown = async move {
        shutdown_signal().await;
        if let Ok(mut deadline) = signal_deadline.lock() {
            *deadline = Some(Instant::now() + shutdown_grace);
        }
    };

    // Event reporting is optional and never turns a configuration or Kafka
    // failure into an application startup failure.
    let reporter_runtime = ReporterRuntime::from_env("backend");
    let reporter = reporter_runtime.handle();
    let app_result = async {
        let state = Arc::new(build_app_state(reporter).await?);
        let application = Application::build(state).await?;
        serve_hybrid_application(config, application, shutdown).await
    }
    .await;

    let deadline = process_deadline
        .lock()
        .ok()
        .and_then(|deadline| *deadline)
        .unwrap_or_else(|| Instant::now() + reporter_runtime.shutdown_timeout());
    let health = reporter_runtime.shutdown(deadline).await;
    tracing::info!(
        ?health,
        implementation = "backend-rs",
        "event reporter stopped"
    );
    app_result
}
