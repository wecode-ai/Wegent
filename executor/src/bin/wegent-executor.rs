// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[tokio::main]
async fn main() {
    if let Err(error) = wegent_executor::app::run_from_env().await {
        eprintln!("{error}");
        std::process::exit(error.exit_code());
    }
}
