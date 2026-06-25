// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub fn get_version() -> String {
    std::env::var("WEGENT_EXECUTOR_VERSION")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| build_version().to_owned())
}

fn build_version() -> &'static str {
    option_env!("WEGENT_EXECUTOR_BUILD_VERSION")
        .or(option_env!("APP_VERSION"))
        .unwrap_or(env!("CARGO_PKG_VERSION"))
}
