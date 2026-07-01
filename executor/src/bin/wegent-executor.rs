// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[tokio::main]
async fn main() {
    wegent_executor::custom_runtime::prestart::run();

    if let Err(error) = wegent_executor::app::run_from_env().await {
        wegent_executor::logging::write_executor_error_line(&error.to_string());
        std::process::exit(error.exit_code());
    }
}
