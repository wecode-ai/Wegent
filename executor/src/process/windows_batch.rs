// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Windows batch shim resolution.
//!
//! `CreateProcess` cannot execute `.cmd`/`.bat` files, so `std::process::Command`
//! routes them through `cmd.exe /c`. cmd.exe, however, rejects arguments that
//! contain newlines with `batch file arguments are invalid`. Agent prompts
//! routinely contain newlines, so npm/node-style shims are resolved to their
//! native executable before spawning. Non-shim batch files keep the std
//! cmd.exe behavior.

use std::{
    env,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
};

const WINDOWS_EXECUTABLE_EXTENSIONS: [&str; 4] = ["exe", "cmd", "bat", "com"];

/// Resolves a bare program name through PATH using Windows executable
/// extensions. Returning the concrete batch path lets the caller inspect and
/// unwrap node-style shims before invoking `CreateProcess`.
pub fn resolve_program_path(program: &Path, search_path: Option<&OsStr>) -> PathBuf {
    if program.components().count() > 1 || program.extension().is_some() {
        return program.to_path_buf();
    }
    let Some(search_path) = search_path else {
        return program.to_path_buf();
    };
    env::split_paths(search_path)
        .flat_map(|directory| {
            let candidate = directory.join(program);
            WINDOWS_EXECUTABLE_EXTENSIONS
                .iter()
                .map(move |extension| candidate.with_extension(extension))
        })
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| program.to_path_buf())
}

/// Returns whether `program` is a Windows batch file.
pub fn is_batch_file(program: &Path) -> bool {
    program
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
        .unwrap_or(false)
}

/// Native launch target resolved from a batch shim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchTarget {
    pub program: PathBuf,
    /// Arguments that must precede the original arguments (for example a node
    /// script path).
    pub prefix_args: Vec<String>,
}

/// Resolves an npm/node-style `.cmd`/`.bat` shim to its native executable.
///
/// Recognized shapes (all forward their original arguments via `%*`):
///
/// - npm native shim: `"<dp0>\...\tool.exe" %*`
/// - npm node shim: `"%_prog%" "<dp0>\...\tool.js" %*`
/// - plain node shim: `node "C:\...\tool.js" %*`
///
/// Returns `None` for imperative batch files that must run under cmd.exe.
pub fn resolve_batch_target(program: &Path) -> Option<BatchTarget> {
    let content = fs::read_to_string(program).ok()?;
    let shim_dir = program.parent()?;
    let prog = resolve_prog_var(&content, shim_dir);
    content
        .lines()
        .filter_map(|line| parse_shim_line(line.trim(), shim_dir, prog.as_deref()))
        .find(target_is_runnable)
}

fn target_is_runnable(target: &BatchTarget) -> bool {
    let program_runnable = if target.program.is_absolute() {
        target.program.is_file()
    } else {
        // A bare name (for example `node`) is resolved from PATH by the OS.
        !target.program.as_os_str().to_string_lossy().is_empty()
    };
    program_runnable
        && target
            .prefix_args
            .iter()
            .all(|argument| !Path::new(argument).is_absolute() || Path::new(argument).is_file())
}

fn parse_shim_line(line: &str, shim_dir: &Path, prog: Option<&str>) -> Option<BatchTarget> {
    // Only the launcher line forwards the original arguments through `%*`;
    // variable assignment lines (`SET "_prog=..."`) must be ignored.
    if !line.contains("%*") {
        return None;
    }
    let tokens = split_quoted_tokens(line);
    if tokens.is_empty() {
        return None;
    }

    // Launcher line: a quoted `<tool>.exe` (or bare `node`) optionally
    // followed by a quoted `<script>.js`.
    for (index, token) in tokens.iter().enumerate() {
        let expanded = expand_dp0(token, shim_dir, prog);
        if !is_executable_path(&expanded) && !is_node_launcher(&expanded) {
            continue;
        }
        let mut prefix_args = Vec::new();
        if let Some(next) = tokens.get(index + 1) {
            let next_expanded = expand_dp0(next, shim_dir, prog);
            if is_script_path(&next_expanded) {
                prefix_args.push(next_expanded);
            }
        }
        return Some(BatchTarget {
            program: PathBuf::from(expanded),
            prefix_args,
        });
    }
    None
}

fn split_quoted_tokens(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    for character in line.chars() {
        match character {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            ' ' | '\t' if !in_quotes => {
                if has_token {
                    tokens.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            _ => {
                current.push(character);
                has_token = true;
            }
        }
    }
    if has_token {
        tokens.push(current);
    }
    tokens
}

fn expand_dp0(token: &str, shim_dir: &Path, prog: Option<&str>) -> String {
    let mut expanded = token
        .replace("%~dp0", &format!("{}\\", shim_dir.to_string_lossy()))
        .replace("%dp0%", &shim_dir.to_string_lossy());
    if let Some(prog) = prog {
        expanded = expanded.replace("%_prog%", prog);
    }
    if expanded == token && token.starts_with('%') && token.ends_with('%') {
        return token.to_owned();
    }
    expanded
}

/// Resolves the `_prog` variable used by npm node shims.
fn resolve_prog_var(content: &str, shim_dir: &Path) -> Option<String> {
    let mut bare_fallback = None;
    for line in content.lines() {
        let Some(rest) = line.trim().strip_prefix("SET") else {
            continue;
        };
        let rest = rest.trim();
        let value = rest
            .strip_prefix("_prog=")
            .or_else(|| {
                rest.strip_prefix("\"_prog=")
                    .map(|value| value.trim_end_matches('"'))
            })
            .map(str::trim);
        let Some(value) = value else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        let expanded = expand_dp0(value, shim_dir, None);
        if expanded == value && value.contains('%') {
            continue;
        }
        let path = Path::new(&expanded);
        if path.is_absolute() && path.is_file() {
            // npm prefers a node.exe sitting next to the shim when present.
            return Some(expanded);
        }
        if !path.is_absolute() && bare_fallback.is_none() {
            bare_fallback = Some(expanded);
        }
    }
    bare_fallback
}

fn is_executable_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("exe"))
        .unwrap_or(false)
}

fn is_script_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            extension.eq_ignore_ascii_case("js")
                || extension.eq_ignore_ascii_case("cjs")
                || extension.eq_ignore_ascii_case("mjs")
        })
        .unwrap_or(false)
}

fn is_node_launcher(token: &str) -> bool {
    token.eq_ignore_ascii_case("node") || token.eq_ignore_ascii_case("node.exe")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    fn write_shim(directory: &Path, name: &str, content: &str) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, content).unwrap();
        path
    }

    fn binary(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, b"not really an executable").unwrap();
        path
    }

    #[test]
    fn resolves_npm_native_shim() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let node_modules = root.join("node_modules").join("@scope").join("tool");
        fs::create_dir_all(node_modules.join("bin")).unwrap();
        let exe = binary(&node_modules.join("bin"), "tool.exe");
        let shim = write_shim(
            root,
            "tool.cmd",
            "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@scope\\tool\\bin\\tool.exe\"   %*\r\n",
        );

        let target = resolve_batch_target(&shim).unwrap();
        assert_eq!(target.program, exe);
        assert!(target.prefix_args.is_empty());
    }

    #[test]
    fn resolves_npm_node_shim() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let node_modules = root.join("node_modules").join("tool");
        fs::create_dir_all(node_modules.join("bin")).unwrap();
        let script = node_modules.join("bin").join("tool.js");
        fs::write(&script, b"// script").unwrap();
        let node = binary(root, "node.exe");
        let shim = write_shim(
            root,
            "tool.cmd",
            "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\tool\\bin\\tool.js\" %*\r\n",
        );

        let target = resolve_batch_target(&shim).unwrap();
        assert_eq!(target.program, node);
        assert_eq!(
            target.prefix_args,
            vec![script.to_string_lossy().to_string()]
        );
    }

    #[test]
    fn resolves_plain_node_shim() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let script = root.join("tool.js");
        fs::write(&script, b"// script").unwrap();
        let shim = write_shim(
            root,
            "tool.cmd",
            &format!("@echo off\nnode \"{}\" %*\n", script.display()),
        );

        let target = resolve_batch_target(&shim).unwrap();
        assert_eq!(target.program, PathBuf::from("node"));
        assert_eq!(
            target.prefix_args,
            vec![script.to_string_lossy().to_string()]
        );
    }

    #[test]
    fn resolves_bare_program_to_path_batch_shim() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let script = root.join("gh.mjs");
        fs::write(&script, b"// script").unwrap();
        let shim = write_shim(
            root,
            "gh.cmd",
            &format!("@echo off\r\nnode \"{}\" %*\r\n", script.display()),
        );
        let search_path = env::join_paths([root]).unwrap();

        let resolved = resolve_program_path(Path::new("gh"), Some(&search_path));
        assert_eq!(resolved, shim);
        let target = resolve_batch_target(&resolved).unwrap();
        assert_eq!(target.program, PathBuf::from("node"));
        assert_eq!(
            target.prefix_args,
            vec![script.to_string_lossy().to_string()]
        );
    }

    #[test]
    fn resolves_npm_node_shim_with_path_node_fallback() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let script = root.join("tool.js");
        fs::write(&script, b"// script").unwrap();
        let shim = write_shim(
            root,
            "tool.cmd",
            "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\tool.js\" %*\r\n",
        );

        let target = resolve_batch_target(&shim).unwrap();
        assert_eq!(target.program, PathBuf::from("node"));
        assert_eq!(
            target.prefix_args,
            vec![script.to_string_lossy().to_string()]
        );
    }

    #[test]
    fn ignores_imperative_batch_files() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let shim = write_shim(
            root,
            "setup.bat",
            "@ECHO off\r\nSETLOCAL\r\nSET FOO=bar\r\nECHO %FOO%\r\n",
        );

        assert_eq!(resolve_batch_target(&shim), None);
    }

    #[test]
    fn ignores_shims_with_missing_targets() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        let shim = write_shim(
            root,
            "missing.cmd",
            "@ECHO off\r\n:start\r\n\"%dp0%\\node_modules\\missing\\bin\\missing.exe\" %*\r\n",
        );

        assert_eq!(resolve_batch_target(&shim), None);
    }

    #[test]
    fn is_batch_file_matches_extensions_case_insensitively() {
        assert!(is_batch_file(Path::new("tool.cmd")));
        assert!(is_batch_file(Path::new("tool.CMD")));
        assert!(is_batch_file(Path::new("setup.bat")));
        assert!(!is_batch_file(Path::new("tool.exe")));
        assert!(!is_batch_file(Path::new("tool")));
    }
}
