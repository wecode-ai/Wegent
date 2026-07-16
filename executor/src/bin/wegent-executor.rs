// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[tokio::main]
async fn main() {
    install_termination_signal_diagnostics();
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
