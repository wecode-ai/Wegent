use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, State};

use crate::process_environment;

const TERMINAL_OUTPUT_EVENT: &str = "local-terminal-output";
const TERMINAL_EXIT_EVENT: &str = "local-terminal-exit";
const DEFAULT_UTF8_LANG: &str = "en_US.UTF-8";
const DEFAULT_UTF8_LC_CTYPE: &str = "UTF-8";

pub struct LocalTerminalState {
    sessions: Mutex<HashMap<String, LocalTerminalSession>>,
    next_id: AtomicU64,
}

struct LocalTerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    child_pid: Option<u32>,
}

#[derive(Serialize, Clone)]
struct LocalTerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct LocalTerminalExit {
    session_id: String,
}

impl Default for LocalTerminalState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

impl LocalTerminalState {
    pub fn active_process_ids(&self) -> Result<Vec<u32>, String> {
        Ok(self
            .sessions
            .lock()
            .map_err(|_| "Failed to lock local terminal state".to_string())?
            .values()
            .filter_map(|session| session.child_pid)
            .collect())
    }
}

fn next_session_id(state: &LocalTerminalState) -> String {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    format!("local-terminal-{id}")
}

fn normalized_cwd(cwd: Option<String>) -> Result<Option<String>, String> {
    let Some(cwd) = cwd else {
        return Ok(None);
    };
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Ok(None);
    }
    if !std::path::Path::new(cwd).exists() {
        return Err(format!("Terminal cwd does not exist: {cwd}"));
    }

    Ok(Some(cwd.to_string()))
}

fn decode_pty_output_chunk(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    let mut bytes = std::mem::take(pending);
    bytes.extend_from_slice(chunk);

    let mut output = String::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        match std::str::from_utf8(&bytes[cursor..]) {
            Ok(text) => {
                output.push_str(text);
                return output;
            }
            Err(error) => {
                let valid_end = cursor + error.valid_up_to();
                if valid_end > cursor {
                    output.push_str(
                        std::str::from_utf8(&bytes[cursor..valid_end])
                            .expect("valid_up_to marks a valid UTF-8 prefix"),
                    );
                }

                match error.error_len() {
                    Some(error_len) => {
                        output.push('\u{FFFD}');
                        cursor = valid_end + error_len;
                    }
                    None => {
                        pending.extend_from_slice(&bytes[valid_end..]);
                        return output;
                    }
                }
            }
        }
    }

    output
}

fn is_utf8_locale_value(value: &str) -> bool {
    let value = value.to_ascii_uppercase();
    value.contains("UTF-8") || value.contains("UTF8")
}

fn resolve_utf8_locale_value(value: Option<&str>, default: &str) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && is_utf8_locale_value(value))
        .unwrap_or(default)
        .to_string()
}

fn process_utf8_locale_value(name: &str, default: &str) -> String {
    resolve_utf8_locale_value(std::env::var(name).ok().as_deref(), default)
}

fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("PATH", process_environment::normalized_current_path());
    command.env("LANG", process_utf8_locale_value("LANG", DEFAULT_UTF8_LANG));
    command.env(
        "LC_CTYPE",
        process_utf8_locale_value("LC_CTYPE", DEFAULT_UTF8_LC_CTYPE),
    );
}

#[tauri::command]
pub fn start_local_terminal(
    app: tauri::AppHandle,
    state: State<'_, LocalTerminalState>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let cwd = normalized_cwd(cwd)?;
        let size = PtySize {
            rows: rows.unwrap_or(24).max(1),
            cols: cols.unwrap_or(80).max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|error| format!("Failed to create PTY: {error}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Failed to create PTY reader: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Failed to create PTY writer: {error}"))?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut command = CommandBuilder::new(shell);
        configure_terminal_environment(&mut command);
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Failed to spawn shell: {error}"))?;
        drop(pair.slave);

        let session_id = next_session_id(&state);
        let session = LocalTerminalSession {
            master: pair.master,
            writer,
            child_pid: child.process_id(),
            child,
        };
        state
            .sessions
            .lock()
            .map_err(|_| "Failed to lock local terminal state".to_string())?
            .insert(session_id.clone(), session);

        let output_session_id = session_id.clone();
        let exit_session_id = session_id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(80));
            let mut buffer = [0_u8; 8192];
            let mut pending_utf8 = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let data = decode_pty_output_chunk(&mut pending_utf8, &buffer[..size]);
                        if data.is_empty() {
                            continue;
                        }
                        let _ = app.emit(
                            TERMINAL_OUTPUT_EVENT,
                            LocalTerminalOutput {
                                session_id: output_session_id.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            let _ = app.emit(
                TERMINAL_EXIT_EVENT,
                LocalTerminalExit {
                    session_id: exit_session_id,
                },
            );
        });

        Ok(session_id)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = state;
        let _ = cwd;
        let _ = rows;
        let _ = cols;
        Err("Local terminal is supported only on macOS".to_string())
    }
}

#[tauri::command]
pub fn write_local_terminal(
    state: State<'_, LocalTerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Failed to lock local terminal state".to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Local terminal session not found: {session_id}"))?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("Failed to write to terminal: {error}"))?;
    session
        .writer
        .flush()
        .map_err(|error| format!("Failed to flush terminal input: {error}"))
}

#[tauri::command]
pub fn resize_local_terminal(
    state: State<'_, LocalTerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "Failed to lock local terminal state".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Local terminal session not found: {session_id}"))?;

    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to resize terminal: {error}"))
}

#[tauri::command]
pub fn close_local_terminal(
    state: State<'_, LocalTerminalState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Failed to lock local terminal state".to_string())?;
    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.child.kill();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_output_across_read_boundaries() {
        let mut pending = Vec::new();
        let mut output = String::new();
        let bytes = "修复".as_bytes();

        output.push_str(&decode_pty_output_chunk(&mut pending, &bytes[..2]));
        output.push_str(&decode_pty_output_chunk(&mut pending, &bytes[2..]));

        assert_eq!(output, "修复");
        assert!(pending.is_empty());
    }

    #[test]
    fn resolves_utf8_locale_for_terminal_processes() {
        assert_eq!(
            resolve_utf8_locale_value(None, "en_US.UTF-8"),
            "en_US.UTF-8"
        );
        assert_eq!(
            resolve_utf8_locale_value(Some("C"), "en_US.UTF-8"),
            "en_US.UTF-8"
        );
        assert_eq!(
            resolve_utf8_locale_value(Some("zh_CN.UTF-8"), "en_US.UTF-8"),
            "zh_CN.UTF-8"
        );
    }
}
