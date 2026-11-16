//! Native harness executable lookup using configured names and platform search paths.

use std::{env, path::PathBuf};

const MACOS_CODEX_APP_BINARIES: [&str; 2] = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
];
const CLAUDE_USER_BINARY_SUFFIX: &str = ".local/bin/claude";

#[cfg(target_os = "windows")]
const WINDOWS_EXECUTABLE_EXTENSIONS: [&str; 4] = [".exe", ".cmd", ".bat", ".com"];

pub fn resolve_codex_binary() -> String {
    read_binary("CODEX_BINARY_PATH", "CODEX_BIN", "codex")
}

/// Resolve a codex binary name/path to an absolute executable path.
///
/// Explicit paths are returned unchanged. A bare `codex` name prefers the
/// macOS app bundle when present, otherwise it is looked up on `PATH`.
pub fn resolve_codex_binary_path(value: &str) -> String {
    let app_candidates = if cfg!(target_os = "macos") {
        MACOS_CODEX_APP_BINARIES
            .iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut search_paths = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();
    search_paths.extend(windows_fallback_search_paths());

    resolve_codex_binary_path_from_candidates(value, &app_candidates, &search_paths)
}

fn resolve_codex_binary_path_from_candidates(
    value: &str,
    app_candidates: &[PathBuf],
    search_paths: &[PathBuf],
) -> String {
    let trimmed = value.trim();
    if trimmed.contains('/') || trimmed.contains('\\') {
        return trimmed.to_owned();
    }

    if trimmed == "codex" {
        if let Some(path) = app_candidates.iter().find(|path| path.is_file()) {
            return path.display().to_string();
        }
    }

    find_executable_in_paths(trimmed, search_paths)
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| trimmed.to_owned())
}

pub fn resolve_claude_binary() -> String {
    let binary = read_binary("CLAUDE_BINARY_PATH", "CLAUDE_BIN", "claude");
    resolve_claude_binary_path(&binary)
}

/// Resolve a Claude Code binary name/path to an executable path.
///
/// GUI-launched local executors may not inherit a user's shell PATH.
/// `~/.local/bin` is a common user-level Claude Code installation location,
/// so check it before falling back to PATH lookup.
pub fn resolve_claude_binary_path(value: &str) -> String {
    let user_binary = dirs::home_dir().map(|home| home.join(CLAUDE_USER_BINARY_SUFFIX));
    let mut search_paths = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();
    search_paths.extend(windows_fallback_search_paths());

    resolve_claude_binary_path_from_candidates(value, user_binary.as_ref(), &search_paths)
}

fn resolve_claude_binary_path_from_candidates(
    value: &str,
    user_binary: Option<&PathBuf>,
    search_paths: &[PathBuf],
) -> String {
    let trimmed = value.trim();
    if trimmed.contains('/') || trimmed.contains('\\') {
        return trimmed.to_owned();
    }

    if trimmed == "claude" {
        if let Some(path) = user_binary.filter(|path| path.is_file()) {
            return path.display().to_string();
        }
    }

    find_executable_in_paths(trimmed, search_paths)
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| trimmed.to_owned())
}

fn read_binary(primary: &str, secondary: &str, default: &str) -> String {
    env::var(primary)
        .ok()
        .or_else(|| env::var(secondary).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_owned())
}

/// Returns common user-level binary directories that GUI-launched processes may
/// not have on PATH.
#[cfg(target_os = "windows")]
fn windows_fallback_search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join("AppData").join("Roaming").join("npm"));
        paths.push(home.join(".cargo").join("bin"));
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        paths.push(PathBuf::from(local_app_data).join("npm"));
    }
    paths
}

#[cfg(not(target_os = "windows"))]
fn windows_fallback_search_paths() -> Vec<PathBuf> {
    Vec::new()
}

/// Looks for `name` in `search_paths`, respecting Windows executable
/// extensions when no extension is provided.
fn find_executable_in_paths(name: &str, search_paths: &[PathBuf]) -> Option<PathBuf> {
    search_paths
        .iter()
        .flat_map(|path| executable_candidates(path.join(name)))
        .find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn executable_candidates(path: PathBuf) -> Vec<PathBuf> {
    if path.extension().is_some() {
        return vec![path];
    }
    WINDOWS_EXECUTABLE_EXTENSIONS
        .iter()
        .map(|ext| path.with_extension(&ext[1..]))
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn executable_candidates(path: PathBuf) -> Vec<PathBuf> {
    vec![path]
}
