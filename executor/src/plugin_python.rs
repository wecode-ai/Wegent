// SPDX-License-Identifier: Apache-2.0

//! Run a plugin's Python script without changing the surrounding task environment.

use std::{env, ffi::OsString, fs, path::Path, path::PathBuf, process::Stdio};

use tokio::process::Command;

pub(crate) const INSTRUCTIONS: &str = r#"Wework Python plugin execution:
When a plugin skill needs to execute a bundled Python script, use the host runner:
  "$WEGENT_EXECUTOR_BINARY" plugin-python /absolute/plugin/path/scripts/example.py [script arguments]
In PowerShell use: & $env:WEGENT_EXECUTOR_BINARY plugin-python <script-path> <arguments>.
This host rule overrides python/python3/uv invocation examples in plugin skills. Read the skill first, resolve its actual script path, and pass script arguments unchanged. Keep the task's working directory. The runner checks the plugin script, prepares Wework Python on demand, shows preparation progress in the desktop UI, selects a ready interpreter, and runs only that plugin child with it. Managed Python is preferred; during preparation the host may temporarily select a validated local Python only when the plugin explicitly declares compatible, dependency-free execution. Use the shell tool's background/session support when preparation takes time, and wait for the same process to finish. Do not start a second preparation or switch to system Python after a preparation error; report the failure and let the user retry from the progress notice or execution environment settings.
Use this runner only for scripts belonging to a plugin package. Ordinary project scripts and shell commands keep their existing Python environment. Do not export PATH, PYTHONHOME or PYTHONPATH for the task, install system Python, or install packages into the shared managed interpreter. Plugin-specific dependency environments remain the plugin's responsibility.
"#;

pub fn is_plugin_python_command() -> bool {
    env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("plugin-python"))
}

pub async fn run() -> Result<i32, String> {
    let mut args = env::args_os().skip(2);
    let script = args
        .next()
        .ok_or("usage: wegent-executor plugin-python <plugin-script.py> [script arguments]")?;
    run_script(Path::new(&script), args).await
}

async fn run_script(
    script: &Path,
    args: impl IntoIterator<Item = OsString>,
) -> Result<i32, String> {
    let script = plugin_script(script)?;
    if !crate::python_runtime::managed_python_bridge_configured() {
        return Err("Wework managed Python is unavailable on this execution device".to_owned());
    }
    let interpreter =
        crate::python_runtime::prepare_plugin_python(&plugin_root(&script)?, true).await?;
    let mut command = plugin_command(&interpreter, &script, args)?;
    let status = command
        .status()
        .await
        .map_err(|error| format!("Failed to execute the plugin Python script: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

fn plugin_command(
    interpreter: &crate::python_runtime::PluginPythonInterpreter,
    script: &Path,
    args: impl IntoIterator<Item = OsString>,
) -> Result<Command, String> {
    let mut command = Command::new(&interpreter.path);
    interpreter.configure(&mut command)?;
    command
        .arg(script)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    // The installation bridge is a host capability, not a plugin credential.
    command.env_remove("WEWORK_PYTHON_RUNTIME_URL");
    command.env_remove("WEWORK_PYTHON_RUNTIME_TOKEN");
    Ok(command)
}

fn plugin_script(path: &Path) -> Result<PathBuf, String> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    };
    if path.extension().and_then(|value| value.to_str()) != Some("py") {
        return Err("The plugin runner requires a Python script path".to_owned());
    }
    let script = path
        .canonicalize()
        .map_err(|error| format!("Plugin Python script is unavailable: {error}"))?;
    if !script.is_file() {
        return Err("The plugin Python script must be a regular file".to_owned());
    }
    let root = plugin_root(&path)?;
    if !script.starts_with(&root) {
        return Err("The Python script resolves outside its plugin package".to_owned());
    }
    if !valid_plugin_manifest(&root) {
        return Err("The Python script's plugin manifest is invalid".to_owned());
    }
    Ok(script)
}

fn plugin_root(path: &Path) -> Result<PathBuf, String> {
    path.ancestors()
        .skip(1)
        .find(|directory| {
            [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]
                .iter()
                .any(|manifest| directory.join(manifest).is_file())
        })
        .ok_or("The Python script must belong to a plugin package")?
        .canonicalize()
        .map_err(|error| error.to_string())
}

fn valid_plugin_manifest(root: &Path) -> bool {
    [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]
        .iter()
        .filter_map(|path| fs::read(root.join(path)).ok())
        .filter_map(|content| serde_json::from_slice::<serde_json::Value>(&content).ok())
        .any(|manifest| {
            manifest["name"]
                .as_str()
                .is_some_and(|name| !name.trim().is_empty())
        })
}

#[cfg(test)]
#[path = "plugin_python_tests.rs"]
mod tests;
