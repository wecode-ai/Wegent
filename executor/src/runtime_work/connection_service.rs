//! A remote Runtime owns a separate DSH reader, never a second task runtime.
use crate::local::app_ipc::AppIpcServer;
use serde_json::Value;
use std::{
    env,
    path::{Component, Path, PathBuf},
    process::{ExitStatus, Stdio},
};
use tokio::process::Command;

struct Delivery {
    manifest: PathBuf,
    node: PathBuf,
    entry: PathBuf,
    providers: Vec<Value>,
}

impl Delivery {
    fn load(manifest: PathBuf) -> Result<Self, String> {
        let read = |path: &Path| -> Result<Value, String> {
            serde_json::from_slice(
                &std::fs::read(path).map_err(|_| "Connection runtime package is unavailable")?,
            )
            .map_err(|_| "Connection runtime package metadata is invalid".to_owned())
        };
        let value = read(&manifest)?;
        if value["schemaVersion"] != 1 {
            return Err("Connection runtime package schema is invalid".to_owned());
        }
        let path = |value: &Value| -> Result<PathBuf, String> {
            let path = value
                .as_str()
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .filter(|path| {
                    !path
                        .components()
                        .any(|part| matches!(part, Component::ParentDir))
                })
                .ok_or_else(|| "Connection runtime delivery path is invalid".to_owned())?;
            if path.is_absolute() {
                Ok(path)
            } else {
                Ok(manifest
                    .parent()
                    .ok_or("Connection runtime delivery directory is unavailable")?
                    .join(path))
            }
        };
        let node = path(&value["nodeExecutable"])?;
        if !node.is_file() || !path(&value["runtimeRoot"])?.join("runtime.json").is_file() {
            return Err("Connection runtime package is incomplete".to_owned());
        }
        let mut entry = None;
        let mut providers = Vec::new();
        for root in value["packageRoots"]
            .as_array()
            .ok_or("Connection package roots are invalid")?
        {
            let root = path(root)?;
            let package = read(&root.join("package.json"))?;
            if package["name"] == "@wegent/dsh-connection-host"
                && entry.replace(root.join("remote-service.js")).is_some()
            {
                return Err("Connection runtime host is duplicated".to_owned());
            }
            if package["wework"]["connections"].is_object() {
                providers.push(package);
            }
        }
        let entry = entry
            .filter(|path| path.is_file())
            .ok_or("Connection runtime host is unavailable")?;
        Ok(Self {
            manifest,
            node,
            entry,
            providers,
        })
    }

    fn command(
        &self,
        data: &Path,
        owner: i64,
        endpoint: &str,
        token: &str,
    ) -> Result<Command, String> {
        let mut command = Command::new(&self.node);
        command.env_clear();
        // Clear before Node starts; NODE_OPTIONS can execute code before any JS scrubber.
        for name in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "TZ",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "NODE_EXTRA_CA_CERTS",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
        ] {
            if let Some(value) = env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .args([
                self.entry.as_os_str(),
                self.manifest.as_os_str(),
                data.as_os_str(),
            ])
            .arg(owner.to_string())
            .env("HOME", data.join("accounts").join(owner.to_string()))
            .env("USERPROFILE", data.join("accounts").join(owner.to_string()))
            .env(
                "WEWORK_CONNECTION_LOCK_EXECUTABLE",
                env::current_exe().map_err(|_| "Native lock executable is unavailable")?,
            )
            .env("WEWORK_EXECUTOR_ENDPOINT", endpoint)
            .env("WEWORK_EXECUTOR_TOKEN", token)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        Ok(command)
    }
}

pub(crate) async fn run(server: &AppIpcServer, owner: i64) -> Result<(), String> {
    let executable = env::current_exe().map_err(|_| "Runtime executable is unavailable")?;
    let delivery = Delivery::load(
        executable
            .parent()
            .ok_or("Runtime directory is unavailable")?
            .join("connection-runtime/connection-runtime.json"),
    )?;
    let server = server
        .clone()
        .with_connection_provider_manifests(&delivery.providers)
        .map_err(|_| "Delivered connection provider declarations are invalid")?;
    if owner <= 0 {
        return Err("Connected account is unavailable".into());
    }
    let data = crate::config::paths::executor_home().join("connections");
    let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let owner_token = uuid::Uuid::new_v4().to_string();
    #[cfg(unix)]
    let endpoint_directory = tempfile::Builder::new()
        .prefix("wconn-")
        .tempdir()
        .map_err(|_| "Connection service socket directory is unavailable")?;
    #[cfg(unix)]
    let endpoint = endpoint_directory
        .path()
        .join("read.sock")
        .to_string_lossy()
        .into_owned();
    #[cfg(windows)]
    let endpoint = format!(
        r"\\.\pipe\wegent-connection-{}",
        uuid::Uuid::new_v4().simple()
    );
    tokio::select! {
        biased;
        // Poll the server first: binding precedes the first accept await, before Node starts.
        result = server.serve_local_endpoint(&endpoint, &token, &owner_token) => result,
        result = async {
            let status = wait_service(delivery.command(&data, owner, &endpoint, &token)?).await?;
            Err(format!("Connection service exited with {status}"))
        } => result,
    }
}

async fn wait_service(mut command: Command) -> Result<ExitStatus, String> {
    let mut child = command
        .spawn()
        .map_err(|_| "Connection service could not start")?;
    // Child::wait closes an owned stdin handle. Keep the parent-liveness pipe
    // outside Child so awaiting its exit cannot stop a healthy service.
    let _parent_lifetime = child
        .stdin
        .take()
        .ok_or("Connection service lifetime pipe is unavailable")?;
    child
        .wait()
        .await
        .map_err(|_| "Connection service process failed".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    // Inside the project's own Electron runtime host, `node` on PATH can be
    // the host's Electron helper (or a shim execing it), which cannot run as a
    // plain child process under the synthetic authority below. Resolve a real
    // Node.js binary by probing candidates for an empty
    // process.versions.electron (#4740). Keep the probe environment untouched:
    // stripping ELECTRON_RUN_AS_NODE would boot a helper candidate as a full
    // application.
    async fn real_node_executable() -> PathBuf {
        let mut directories: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        #[cfg(target_os = "macos")]
        for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            directories.push(PathBuf::from(dir));
        }
        #[cfg(target_os = "linux")]
        for dir in ["/usr/bin", "/usr/local/bin"] {
            directories.push(PathBuf::from(dir));
        }
        #[cfg(target_os = "windows")]
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            directories.push(PathBuf::from(program_files).join("nodejs"));
        }
        let names: &[&str] = if cfg!(windows) {
            &["node.exe"]
        } else {
            &["node"]
        };
        for directory in directories {
            for name in names {
                let candidate = directory.join(name);
                if !candidate.is_file() {
                    continue;
                }
                let candidate = std::path::absolute(&candidate).unwrap_or(candidate);
                let mut command = tokio::process::Command::new(&candidate);
                command
                    .args([
                        "-p",
                        "JSON.stringify([process.versions.electron ?? \"\", process.versions.node, process.execPath])",
                    ])
                    .kill_on_drop(true);
                let output =
                    match tokio::time::timeout(Duration::from_secs(10), command.output()).await {
                        Ok(Ok(output)) if output.status.success() => output,
                        _ => continue,
                    };
                let response: Option<Vec<String>> = serde_json::from_slice(&output.stdout).ok();
                if let Some([electron, _node, executable]) = response.and_then(|value| {
                    let mut iterator = value.into_iter();
                    Some([iterator.next()?, iterator.next()?, iterator.next()?])
                }) {
                    if electron.is_empty() && !executable.is_empty() {
                        return PathBuf::from(executable);
                    }
                }
            }
        }
        panic!("a real Node.js executable is required for this test")
    }

    #[tokio::test]
    async fn native_wait_preserves_the_parent_pipe_and_starts_node_with_only_reader_authority() {
        let root = tempfile::tempdir().unwrap();
        let node = real_node_executable().await;
        let entry = root.path().join("service.js");
        // A positive checkpoint requires the real child to remain alive while Native awaits it.
        std::fs::write(
            &entry,
            r#"
          const expectedHome = require('node:path').join(process.argv[3], 'accounts', '7')
          if (process.env.HOME !== expectedHome || process.env.USERPROFILE !== expectedHome ||
              process.env.WEWORK_EXECUTOR_TOKEN !== 'synthetic-reader' ||
              process.env.WEWORK_EXECUTOR_ENDPOINT !== 'synthetic-endpoint' ||
              ['NODE_OPTIONS','WEGENT_AUTH_TOKEN','BACKEND_INTERNAL_TOKEN','OPENAI_API_KEY']
                .some(name => process.env[name] !== undefined)) process.exit(43)
          process.stdin.on('end', () => process.exit(42))
          process.stdin.resume()
          setTimeout(() => process.exit(17), 100)
        "#,
        )
        .unwrap();
        let delivery = Delivery {
            manifest: root.path().join("manifest.json"),
            node,
            entry,
            providers: vec![],
        };
        let command = delivery
            .command(root.path(), 7, "synthetic-endpoint", "synthetic-reader")
            .unwrap();
        let status = tokio::time::timeout(Duration::from_secs(10), wait_service(command))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            status.code(),
            Some(17),
            "Native must keep the parent pipe open through the child checkpoint"
        );
    }

    #[test]
    fn missing_or_corrupt_delivery_cannot_supply_provider_authority() {
        let root = tempfile::tempdir().unwrap();
        let manifest = root.path().join("connection-runtime.json");
        assert!(Delivery::load(manifest.clone()).is_err());
        std::fs::write(
            &manifest,
            r#"{"schemaVersion":1,"runtimeRoot":"relative","packageRoots":[]}"#,
        )
        .unwrap();
        assert!(Delivery::load(manifest.clone()).is_err());
        assert_eq!(
            std::fs::read_to_string(manifest).unwrap(),
            r#"{"schemaVersion":1,"runtimeRoot":"relative","packageRoots":[]}"#
        );
    }

    #[test]
    fn delivered_relative_paths_follow_the_package_after_relocation() {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("original");
        for path in ["runtime", "node", "packages/host"] {
            std::fs::create_dir_all(original.join(path)).unwrap();
        }
        for path in [
            "runtime/runtime.json",
            "node/node",
            "packages/host/remote-service.js",
        ] {
            std::fs::write(original.join(path), "delivery fixture").unwrap();
        }
        std::fs::write(
            original.join("packages/host/package.json"),
            r#"{"name":"@wegent/dsh-connection-host"}"#,
        )
        .unwrap();
        let manifest = json!({"schemaVersion":1,"runtimeRoot":"runtime","nodeExecutable":"node/node","packageRoots":["packages/host"]});
        std::fs::write(
            original.join("connection-runtime.json"),
            manifest.to_string(),
        )
        .unwrap();
        let moved = root.path().join("moved");
        std::fs::rename(original, &moved).unwrap();
        let delivery = Delivery::load(moved.join("connection-runtime.json")).unwrap();
        assert_eq!(delivery.node, moved.join("node/node"));
        assert_eq!(
            delivery.entry,
            moved.join("packages/host/remote-service.js")
        );
        for invalid in ["../outside", "packages/../../outside", ""] {
            let mut rejected = manifest.clone();
            rejected["packageRoots"] = json!([invalid]);
            std::fs::write(moved.join("connection-runtime.json"), rejected.to_string()).unwrap();
            assert!(Delivery::load(moved.join("connection-runtime.json")).is_err());
        }
    }
}
