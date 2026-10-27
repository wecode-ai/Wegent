// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

#![cfg_attr(windows, windows_subsystem = "windows")]

#[path = "wework_launcher/mod.rs"]
mod launcher;

fn main() {
    if let Err(error) = launcher::run(std::env::args_os().skip(1).collect()) {
        eprintln!("Wework launcher: {error}");
        std::process::exit(1);
    }
}
