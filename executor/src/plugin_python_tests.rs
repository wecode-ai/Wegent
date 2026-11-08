// SPDX-License-Identifier: Apache-2.0

use super::*;

struct Environment(Vec<(&'static str, Option<OsString>)>);

impl Environment {
    fn set(values: &[(&'static str, &str)]) -> Self {
        let previous = values
            .iter()
            .map(|(key, _)| (*key, env::var_os(key)))
            .collect();
        for (key, value) in values {
            env::set_var(key, value);
        }
        Self(previous)
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            if let Some(value) = value {
                env::set_var(key, value);
            } else {
                env::remove_var(key);
            }
        }
    }
}

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join(".codex-plugin")).unwrap();
    fs::create_dir_all(root.path().join("skills/example/scripts")).unwrap();
    fs::write(
        root.path().join(".codex-plugin/plugin.json"),
        r#"{"name":"example"}"#,
    )
    .unwrap();
    let script = root.path().join("skills/example/scripts/read data.py");
    fs::write(&script, "print('plugin')").unwrap();
    (root, script)
}

#[test]
fn accepts_plugin_scripts_but_rejects_project_scripts_and_interpreter_flags() {
    let (root, script) = fixture();
    assert_eq!(
        plugin_script(&script).unwrap(),
        script.canonicalize().unwrap()
    );
    assert!(plugin_script(Path::new("-c")).is_err());
    fs::remove_file(root.path().join(".codex-plugin/plugin.json")).unwrap();
    assert!(plugin_script(&script)
        .unwrap_err()
        .contains("plugin package"));
    fs::write(root.path().join(".codex-plugin/plugin.json"), "{}").unwrap();
    assert!(plugin_script(&script)
        .unwrap_err()
        .contains("manifest is invalid"));
}

#[cfg(unix)]
#[test]
fn rejects_scripts_linked_outside_the_plugin() {
    let (_root, script) = fixture();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::remove_file(&script).unwrap();
    std::os::unix::fs::symlink(outside.path(), &script).unwrap();
    assert!(plugin_script(&script).unwrap_err().contains("outside"));
}

#[test]
fn managed_environment_and_arguments_are_scoped_to_the_plugin_child() {
    let _lock = crate::test_env::lock();
    let runtime = tempfile::tempdir().unwrap();
    let interpreter = runtime.path().join("python3");
    let interpreter_text = interpreter.to_str().unwrap();
    let _environment = Environment::set(&[
        ("WEGENT_PYTHON_PATH", interpreter_text),
        ("PYTHONHOME", "ordinary-python-home"),
        ("PYTHONPATH", "ordinary-python-path"),
        ("WEWORK_PYTHON_RUNTIME_TOKEN", "private-host-token"),
    ]);
    let original_path = env::var_os("PATH");
    let (_root, script) = fixture();
    let args = ["--output", "a b.json", "$(must-not-run)"];
    let selected = crate::python_runtime::PluginPythonInterpreter {
        path: interpreter.clone(),
        source: "managed".into(),
        version: "3.12.12".into(),
    };
    let command = plugin_command(&selected, &script, args.map(OsString::from)).unwrap();
    assert_eq!(command.as_std().get_program(), interpreter);
    assert_eq!(command.as_std().get_current_dir(), None);
    let expected = std::iter::once(script.into_os_string())
        .chain(args.map(OsString::from))
        .collect::<Vec<_>>();
    assert_eq!(
        command
            .as_std()
            .get_args()
            .map(OsString::from)
            .collect::<Vec<_>>(),
        expected
    );
    let child_env = command
        .as_std()
        .get_envs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(child_env[std::ffi::OsStr::new("PYTHONHOME")], None);
    assert_eq!(child_env[std::ffi::OsStr::new("PYTHONPATH")], None);
    assert_eq!(
        child_env[std::ffi::OsStr::new("WEWORK_PYTHON_RUNTIME_TOKEN")],
        None
    );
    let child_path = child_env[std::ffi::OsStr::new("PATH")].unwrap();
    assert_eq!(env::split_paths(child_path).next().unwrap(), runtime.path());
    assert_eq!(env::var_os("PATH"), original_path);
    assert_eq!(env::var("PYTHONHOME").unwrap(), "ordinary-python-home");
    assert_eq!(env::var("PYTHONPATH").unwrap(), "ordinary-python-path");
}

#[test]
fn preparation_failure_stops_before_script_execution() {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(assert_preparation_failure());
}

async fn assert_preparation_failure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/runtime/python/ensure",
        listener.local_addr().unwrap()
    );
    let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = hits.clone();
    let router = axum::Router::new().route(
        "/runtime/python/resolve",
        axum::routing::post(move || {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { axum::http::StatusCode::SERVICE_UNAVAILABLE }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let runtime = tempfile::tempdir().unwrap();
    let interpreter = runtime.path().join("nonexistent-python");
    let _environment = Environment::set(&[
        ("WEWORK_PYTHON_RUNTIME_URL", &endpoint),
        ("WEWORK_PYTHON_RUNTIME_TOKEN", "test-token"),
        ("WEGENT_PYTHON_PATH", interpreter.to_str().unwrap()),
    ]);
    let (_root, script) = fixture();
    let error = run_script(&script, []).await.unwrap_err();
    server.abort();
    assert_eq!(error, "Plugin Python preparation request failed");
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
}
