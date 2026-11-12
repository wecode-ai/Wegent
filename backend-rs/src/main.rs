// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use wegent_backend_rs::{
    Application, HybridConfig, build_app_state_with_clients, build_database_clients,
    prepare_database, run_hybrid,
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
    let mut args = std::env::args().skip(1);
    let mut command = Vec::new();
    while let Some(arg) = args.next() {
        if arg == "--env-file" {
            args.next();
        } else if !arg.starts_with("--env-file=") {
            command.push(arg);
        }
    }
    if !command.is_empty() {
        return database_command(&command).await;
    }
    let config = HybridConfig::from_env()?;
    let (mysql, redis) = build_database_clients().await?;
    let database = wegent_backend_rs::config::DatabaseConfig::from_env()?;
    let migration_mysql = wegent_backend_rs::migrations::connect(&database.mysql_url())?;
    let prepared = prepare_database(&migration_mysql, redis.as_ref()).await;
    migration_mysql.close().await;
    prepared?;
    let state = Arc::new(build_app_state_with_clients(mysql, redis).await?);
    let application = Application::build(state).await?;
    run_hybrid(config, application).await
}

async fn database_command(command: &[String]) -> Result<(), wegent_backend_rs::BoxError> {
    use wegent_backend_rs::{config::DatabaseConfig, migrations};
    if command.iter().map(String::as_str).eq(["db", "validate"]) {
        let graph = migrations::graph::Graph::load()?;
        println!(
            "{} migrations; latest revision {}",
            graph.revisions.len(),
            graph.head
        );
        return Ok(());
    }
    let config = DatabaseConfig::from_env()?;
    let mysql = migrations::connect(&config.mysql_url())?;
    match command.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["db", "status" | "current"] => {
            migrations::status(&mysql).await?;
            println!("current: {:?}; latest: {}",migrations::current(&mysql).await?,migrations::graph::Graph::load()?.head);
        }
        ["db", "upgrade"] => migrations::upgrade(&mysql).await?,
        ["db", "downgrade", target] => migrations::downgrade(&mysql, target).await?,
        ["db", "init"] => {
            wegent_backend_rs::initialization::yaml(&mysql).await?;
            wegent_backend_rs::initialization::plugins(&mysql).await?;
        }
        _ => return Err("usage: wegent-backend-rs [--env-file PATH] [db status|upgrade|downgrade REVISION|init]".into()),
    }
    mysql.close().await;
    Ok(())
}
