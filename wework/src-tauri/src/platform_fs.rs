//! Platform-dispatched "reveal / open in file manager" and "open with default
//! app", so the desktop app works on macOS (Finder), Windows (Explorer) and
//! Linux (xdg-open). All child processes are spawned with CREATE_NO_WINDOW on
//! Windows so they never flash a console window.

#[cfg(any(target_os = "windows", target_os = "linux"))]
use crate::process::hide_windows_console;

pub fn reveal_file_in_manager(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        run_open(&["-R", path], "reveal file in Finder")
    }

    #[cfg(target_os = "windows")]
    {
        // `/select,` must stay glued to the path in a single argument, or
        // Explorer treats the comma as a separator.
        run_explorer(&format!("/select,{path}"))
    }

    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(path)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| "Path has no parent directory".to_string())?;
        run_xdg_open(&parent.to_string_lossy())
    }
}

pub fn open_directory(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        run_open(&[path], "open in Finder")
    }

    #[cfg(target_os = "windows")]
    {
        run_explorer(path)
    }

    #[cfg(target_os = "linux")]
    {
        run_xdg_open(path)
    }
}

pub fn open_with_default_app(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        run_open(&[path], "open with default app")
    }

    #[cfg(target_os = "windows")]
    {
        run_windows_default_app(path)
    }

    #[cfg(target_os = "linux")]
    {
        run_xdg_open(path)
    }
}

#[cfg(target_os = "macos")]
fn run_open(args: &[&str], description: &str) -> Result<(), String> {
    let output = std::process::Command::new("open")
        .args(args)
        .output()
        .map_err(|error| format!("Failed to {description}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!("Failed to {description}"))
    } else {
        Err(stderr)
    }
}

#[cfg(target_os = "windows")]
fn run_explorer(argument: &str) -> Result<(), String> {
    let mut command = std::process::Command::new("explorer");
    command.arg(argument);
    hide_windows_console(&mut command);
    // Explorer hands off to a running instance and reports success as exit 1,
    // so spawn it and do not check the exit status.
    let _ = command
        .spawn()
        .map_err(|error| format!("Failed to launch Explorer: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_windows_default_app(path: &str) -> Result<(), String> {
    let mut command = std::process::Command::new("cmd");
    // The empty string occupies the window title slot so the quoted path is
    // not parsed as the title.
    command.args(["/C", "start", "", path]);
    hide_windows_console(&mut command);
    let status = command
        .status()
        .map_err(|error| format!("Failed to launch default app: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Failed to open with default app (exit {status})"))
    }
}

#[cfg(target_os = "linux")]
fn run_xdg_open(path: &str) -> Result<(), String> {
    let mut command = std::process::Command::new("xdg-open");
    command.arg(path);
    hide_windows_console(&mut command);
    let status = command
        .status()
        .map_err(|error| format!("Failed to run xdg-open: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("xdg-open exited with {status}"))
    }
}
