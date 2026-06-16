use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, State};

const TERMINAL_OUTPUT_EVENT: &str = "local-terminal-output";
const TERMINAL_EXIT_EVENT: &str = "local-terminal-exit";

pub struct LocalTerminalState {
    sessions: Mutex<HashMap<String, LocalTerminalSession>>,
    next_id: AtomicU64,
}

struct LocalTerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
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
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
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
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let data = String::from_utf8_lossy(&buffer[..size]).to_string();
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
