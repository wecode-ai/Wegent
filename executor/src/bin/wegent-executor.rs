// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::env;

use wegent_executor::app::cli::CliArgs;

fn main() {
    install_termination_signal_diagnostics();
    if wegent_executor::connector_mcp::is_connector_mcp_command() {
        if let Err(error) = runtime().block_on(wegent_executor::connector_mcp::run()) {
            eprintln!("connector MCP server failed: {error}");
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
    if wegent_executor::task_runtime::mcp::is_task_mcp_command() {
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
    let shell_environment = if should_hydrate_shell_environment(&args) {
        Some(wegent_executor::process_environment::hydrate_process_environment())
    } else {
        None
    };
    if let Err(error) = runtime().block_on(wegent_executor::app::run_with_shell_environment(
        args,
        shell_environment,
    )) {
        wegent_executor::logging::write_executor_error_line(&error.to_string());
        std::process::exit(error.exit_code());
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

#[cfg(target_os = "macos")]
fn install_termination_signal_diagnostics() {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = termination_signal_handler as *const () as usize;
        action.sa_flags = libc::SA_SIGINFO;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
    }
}

#[cfg(not(target_os = "macos"))]
fn install_termination_signal_diagnostics() {}

#[cfg(target_os = "macos")]
extern "C" fn termination_signal_handler(
    signal: libc::c_int,
    info: *mut libc::siginfo_t,
    _context: *mut libc::c_void,
) {
    let sender_pid = if info.is_null() {
        0
    } else {
        unsafe { (*info).si_pid() }
    };
    let process_id = unsafe { libc::getpid() };
    let mut line = [0_u8; 128];
    let mut length = 0;
    append_signal_text(
        &mut line,
        &mut length,
        b"wegent-executor received SIGTERM sender_pid=",
    );
    append_signal_number(&mut line, &mut length, sender_pid);
    append_signal_text(&mut line, &mut length, b" process_id=");
    append_signal_number(&mut line, &mut length, process_id);
    append_signal_text(&mut line, &mut length, b"\n");

    unsafe {
        libc::write(
            libc::STDERR_FILENO,
            line.as_ptr().cast::<libc::c_void>(),
            length,
        );
        libc::signal(signal, libc::SIG_DFL);
        libc::kill(process_id, signal);
        libc::_exit(128 + signal);
    }
}

#[cfg(target_os = "macos")]
fn append_signal_text(buffer: &mut [u8], length: &mut usize, value: &[u8]) {
    let available = buffer.len().saturating_sub(*length);
    let copy_length = available.min(value.len());
    buffer[*length..*length + copy_length].copy_from_slice(&value[..copy_length]);
    *length += copy_length;
}

#[cfg(target_os = "macos")]
fn append_signal_number(buffer: &mut [u8], length: &mut usize, value: libc::pid_t) {
    let mut remaining = value.max(0) as u32;
    let mut digits = [0_u8; 10];
    let mut digit_count = 0;
    loop {
        digits[digit_count] = b'0' + (remaining % 10) as u8;
        digit_count += 1;
        remaining /= 10;
        if remaining == 0 {
            break;
        }
    }
    for digit in digits[..digit_count].iter().rev() {
        append_signal_text(buffer, length, &[*digit]);
    }
}
