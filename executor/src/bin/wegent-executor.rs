// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[tokio::main]
async fn main() {
    if wegent_executor::browser_mcp::is_browser_mcp_command() {
        if let Err(error) = wegent_executor::browser_mcp::run().await {
            eprintln!("browser MCP server failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = wegent_executor::app::run_from_env().await {
        wegent_executor::logging::write_executor_error_line(&error.to_string());
        std::process::exit(error.exit_code());
    }
}
