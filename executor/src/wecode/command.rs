// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub async fn run_from_args() -> Option<Result<(), String>> {
    run(std::env::args().nth(1).as_deref()).await
}

pub async fn run(command: Option<&str>) -> Option<Result<(), String>> {
    match command {
        Some("file-change-sender") => Some(crate::wecode::file_change_sender::run_from_env().await),
        _ => None,
    }
}
