// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, time::Duration};

#[cfg(unix)]
use std::thread;

use wegent_executor::app::cli::CliArgs;

/// Upper bound for tearing the runtime down once the app side is gone.
///
/// Tokio's runtime shutdown waits for the blocking pool without a timeout, and
/// the blocking pool holds the child stdio reads that keep this process alive.
/// The bound keeps the exit deterministic instead of relying on the app to
/// force-kill the tree.
const RUNTIME_SHUTDOWN_BUDGET: Duration = Duration::from_secs(2);

/// How long the app sidecar lifecycle watchdog waits for the shutdown it
/// requests before exiting the process unconditionally. Nothing is left to ask
/// again once the desktop app is gone, so the exit stays bounded.
#[cfg(unix)]
const WATCHDOG_EXIT_GRACE: Duration = Duration::from_secs(3);

#[cfg(any(target_os = "macos", test))]
const OPEN_FILES_SOFT_LIMIT: libc::rlim_t = 65_536;

#[cfg(any(target_os = "macos", test))]
fn open_files_soft_limit_target(
    hard_limit: libc::rlim_t,
    kernel_limit: Option<libc::rlim_t>,
) -> libc::rlim_t {
    let target = OPEN_FILES_SOFT_LIMIT.min(hard_limit);
    kernel_limit.map_or(target, |limit| target.min(limit))
}

#[cfg(target_os = "macos")]
fn raise_open_files_soft_limit() {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    let result = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) };
    if result != 0 {
        eprintln!(
            "failed to read wegent-executor open files limit: {}",
            std::io::Error::last_os_error()
        );
        return;
    }

    let target = open_files_soft_limit_target(limit.rlim_max, macos_max_files_per_process());
    if limit.rlim_cur >= target {
        return;
    }

    let previous = limit.rlim_cur;
    limit.rlim_cur = target;
    let result = unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) };
    if result != 0 {
        eprintln!(
            "failed to raise wegent-executor open files soft limit from {previous} to {target}: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(target_os = "macos")]
fn macos_max_files_per_process() -> Option<libc::rlim_t> {
    let name = b"kern.maxfilesperproc\0";
    let mut value: libc::c_int = 0;
    let mut value_size = std::mem::size_of_val(&value);
    let result = unsafe {
        libc::sysctlbyname(
            name.as_ptr().cast(),
            (&mut value as *mut libc::c_int).cast(),
            &mut value_size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        eprintln!(
            "failed to read macOS max open files per process: {}",
            std::io::Error::last_os_error()
        );
        return None;
    }

    (value > 0).then_some(value as libc::rlim_t)
}

#[cfg(not(target_os = "macos"))]
fn raise_open_files_soft_limit() {}

fn main() {
    raise_open_files_soft_limit();
    if wegent_executor::plugin_workspace_cli::is_plugin_workspace_command() {
        if let Err(error) = runtime().block_on(wegent_executor::plugin_workspace_cli::run()) {
            eprintln!("plugin workspace command failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if wegent_executor::connector_mcp::is_connector_mcp_command() {
        if let Err(error) = runtime().block_on(wegent_executor::connector_mcp::run()) {
            eprintln!("connector MCP server failed: {error}");
            std::process::exit(1);
        }
        return;
    }

    if let Some(result) = runtime().block_on(wegent_executor::wecode::command::run_from_args()) {
        if let Err(error) = result {
            eprintln!("Warning: wecode command failed: {error}");
            std::process::exit(1);
        }
        return;
    }

    if wegent_executor::browser_mcp::is_browser_mcp_command() {
        if let Err(error) = runtime().block_on(wegent_executor::browser_mcp::run()) {
            eprintln!("browser MCP server failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if wegent_executor::computer_use_mcp::is_computer_use_mcp_command() {
        if let Err(error) = runtime().block_on(wegent_executor::computer_use_mcp::run()) {
            eprintln!("computer use MCP server failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if wegent_executor::task_runtime::mcp::is_space_mcp_command() {
        if let Err(error) = runtime().block_on(wegent_executor::task_runtime::mcp::run()) {
            eprintln!("task MCP server failed: {error}");
            std::process::exit(1);
        }
        return;
    }

    let args = match CliArgs::parse_from(env::args()) {
        Ok(args) => args,
        Err(error) => {
            wegent_executor::logging::write_executor_error_line(&error.to_string());
            std::process::exit(2);
        }
    };
    install_app_sidecar_lifecycle_watchdog();
    let shell_environment = if should_hydrate_shell_environment(&args) {
        Some(wegent_executor::process_environment::hydrate_process_environment())
    } else {
        None
    };
    let runtime_instance = runtime();
    let outcome = runtime_instance.block_on(wegent_executor::app::run_with_shell_environment(
        args,
        shell_environment,
    ));
    shutdown_runtime(runtime_instance);
    if let Err(error) = outcome {
        wegent_executor::logging::write_executor_error_line(&error.to_string());
        std::process::exit(error.exit_code());
    }
}

fn shutdown_runtime(runtime_instance: tokio::runtime::Runtime) {
    let started = std::time::Instant::now();
    runtime_instance.shutdown_timeout(RUNTIME_SHUTDOWN_BUDGET);
    if started.elapsed() >= RUNTIME_SHUTDOWN_BUDGET {
        wegent_executor::logging::write_executor_log_line(&format!(
            "executor runtime shutdown exceeded {}ms; exiting without draining blocking tasks",
            RUNTIME_SHUTDOWN_BUDGET.as_millis()
        ));
    }
}

fn should_hydrate_shell_environment(args: &CliArgs) -> bool {
    !args.help && !args.version && !args.upgrade
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Tokio runtime should initialize")
}

#[cfg(unix)]
fn install_app_sidecar_lifecycle_watchdog() {
    let Some(lifecycle_fd) = env::var("WEGENT_APP_LIFECYCLE_FD")
        .ok()
        .and_then(|value| value.trim().parse::<libc::c_int>().ok())
        .filter(|value| *value >= 3)
    else {
        return;
    };
    wegent_executor::logging::write_executor_log_line(&format!(
        "app sidecar lifecycle watchdog armed fd={lifecycle_fd}"
    ));
    thread::spawn(move || {
        let mut byte = 0_u8;
        loop {
            let read_result = unsafe { libc::read(lifecycle_fd, (&mut byte as *mut u8).cast(), 1) };
            if read_result > 0 {
                continue;
            }
            if read_result < 0
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
            {
                continue;
            }
            break;
        }
        // The owner is gone: request the same shutdown an owner disconnect
        // performs, so the agent processes this executor drove are stopped by
        // their owner. Nothing is left to request it again, so exit anyway if
        // the request cannot complete.
        unsafe {
            libc::killpg(libc::getpgrp(), libc::SIGTERM);
        }
        thread::sleep(WATCHDOG_EXIT_GRACE);
        unsafe {
            libc::_exit(0);
        }
    });
}

#[cfg(not(unix))]
fn install_app_sidecar_lifecycle_watchdog() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_files_target_uses_configured_limit_when_supported() {
        assert_eq!(
            open_files_soft_limit_target(libc::RLIM_INFINITY, Some(245_760)),
            OPEN_FILES_SOFT_LIMIT
        );
    }

    #[test]
    fn open_files_target_respects_process_hard_limit() {
        assert_eq!(open_files_soft_limit_target(4_096, Some(245_760)), 4_096);
    }

    #[test]
    fn open_files_target_respects_macos_kernel_limit() {
        assert_eq!(
            open_files_soft_limit_target(libc::RLIM_INFINITY, Some(24_576)),
            24_576
        );
    }
}
