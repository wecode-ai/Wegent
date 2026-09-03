// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
};

use serde_json::{json, Value};
use sha2::Digest;
use wegent_executor::local::{
    app_ipc::{app_ipc_stdio_ready_log_line, AppIpcError, AppIpcServer, RuntimeWorkHandler},
    command::{CommandRequest, CommandResult, DeviceCommandHandler},
};

const LOCAL_GIT_ENV_VARS: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
];

struct EnvLockGuard {
    _guard: MutexGuard<'static, ()>,
}

async fn env_lock() -> EnvLockGuard {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    EnvLockGuard {
        _guard: LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("environment lock should be available"),
    }
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[tokio::test]
async fn app_ipc_routes_runtime_rpc_request() {
    let server = AppIpcServer::new().with_runtime_work_handler(RuntimeHandler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-1",
                "method": "runtime.tasks.list",
                "params": {"workspacePath": "/tmp/project"}
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(
        response,
        json!({
            "type": "response",
            "id": "req-1",
            "ok": true,
            "result": {"success": true, "workspaces": []}
        })
    );
}

#[tokio::test]
async fn app_ipc_routes_codex_app_server_request() {
    let server = AppIpcServer::new().with_runtime_work_handler(CodexRuntimeHandler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-codex",
                "method": "codex.app_server_request",
                "params": {
                    "method": "plugin/installed",
                    "params": {"cwds": null}
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(
        response,
        json!({
            "type": "response",
            "id": "req-codex",
            "ok": true,
            "result": {"marketplaces": []}
        })
    );
}

#[tokio::test]
async fn app_ipc_initializes_the_bundled_plugin_marketplace() {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("bundled-plugins/wework-personal");
    let executor_home = root.path().join("executor-home");
    fs::create_dir_all(source.join(".agents/plugins")).unwrap();
    fs::create_dir_all(source.join(".claude-plugin")).unwrap();
    fs::create_dir_all(source.join("plugins/smart-app-builder")).unwrap();
    fs::write(
        source.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[{"name":"smart-app-builder","policy":{"installation":"INSTALLED_BY_DEFAULT"}},{"name":"wework-space"}]}"#,
    )
    .unwrap();
    fs::write(
        source.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[{"name":"wework-space"},{"name":"smart-app-builder"}]}"#,
    )
    .unwrap();
    fs::write(
        source.join("plugins/smart-app-builder/README.md"),
        "builder",
    )
    .unwrap();
    let _source = EnvGuard::set(
        "WEGENT_BUNDLED_PLUGIN_MARKETPLACE_DIR",
        &source.display().to_string(),
    );
    let _executor_home =
        EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());

    let result = AppIpcServer::new()
        .dispatch("executor.plugins.initialize_bundled_marketplace", json!({}))
        .await
        .unwrap();

    let destination = executor_home.join("capabilities/bundled-marketplaces/wework-personal");
    assert_eq!(result["id"], "wework-personal");
    assert_eq!(result["path"], destination.display().to_string());
    assert_eq!(result["pluginCount"], 2);
    assert_eq!(result["defaultPluginNames"], json!(["smart-app-builder"]));
    assert_eq!(
        fs::read_to_string(destination.join("plugins/smart-app-builder/README.md")).unwrap(),
        "builder"
    );
}

#[tokio::test]
async fn app_ipc_lists_ensures_and_packages_personal_plugins() {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let executor_home = root.path().join("executor-home");
    let source = root.path().join("source-marketplace");
    let destination = executor_home.join("capabilities/bundled-marketplaces/wework-personal");
    let source_plugin = source.join("plugins/example-plugin");
    fs::create_dir_all(source_plugin.join(".codex-plugin")).unwrap();
    fs::create_dir_all(source.join(".agents/plugins")).unwrap();
    fs::write(
        source_plugin.join(".codex-plugin/plugin.json"),
        r#"{"name":"example-plugin","version":"1.2.3","description":"Personal plugin","interface":{"displayName":"Example Plugin","category":"development"}}"#,
    )
    .unwrap();
    let mut state = 0x1234_5678_u32;
    let incompressible = (0..11 * 1024 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect::<Vec<_>>();
    fs::write(source_plugin.join("payload.bin"), incompressible).unwrap();
    fs::write(
        source.join(".agents/plugins/marketplace.json"),
        r#"{"name":"wework-personal","plugins":[{"name":"example-plugin","source":{"source":"local","path":"./plugins/example-plugin"}}]}"#,
    )
    .unwrap();
    let _executor_home =
        EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let server = AppIpcServer::new();

    let ensured = server
        .dispatch(
            "executor.plugins.personal.ensure",
            json!({
                "sourceMarketplacePath": source.display().to_string(),
                "destinationMarketplacePath": destination.display().to_string(),
                "pluginName": "example-plugin"
            }),
        )
        .await
        .unwrap();
    assert_eq!(ensured["pluginName"], "example-plugin");
    assert_eq!(ensured["migrated"], true);
    assert!(destination
        .join("plugins/example-plugin/.codex-plugin/plugin.json")
        .is_file());

    let listed = server
        .dispatch(
            "executor.plugins.personal.list",
            json!({"marketplacePath": destination.display().to_string()}),
        )
        .await
        .unwrap();
    assert_eq!(listed["marketplaceId"], "wework-personal");
    assert_eq!(listed["plugins"][0]["name"], "example-plugin");
    assert_eq!(listed["plugins"][0]["displayName"], "Example Plugin");

    let package = server
        .dispatch(
            "executor.plugins.personal.package",
            json!({
                "marketplacePath": destination.display().to_string(),
                "pluginName": "example-plugin"
            }),
        )
        .await
        .unwrap();
    assert_eq!(package["name"], "example-plugin.zip");
    assert!(package.get("bytes").is_none());
    let package_path = package["path"].as_str().unwrap();
    let package_size = package["size"].as_u64().unwrap();
    assert!(package_size > 10 * 1024 * 1024);
    assert_eq!(fs::metadata(package_path).unwrap().len(), package_size);
    let package_bytes = fs::read(package_path).unwrap();
    assert_eq!(
        format!("{:x}", sha2::Sha256::digest(&package_bytes)),
        package["sha256"].as_str().unwrap()
    );
    let cleanup_token = package["cleanupToken"].as_str().unwrap().to_owned();
    server
        .dispatch(
            "executor.plugins.personal.package.cleanup",
            json!({"cleanupToken": cleanup_token}),
        )
        .await
        .unwrap();
    assert!(!Path::new(package_path).exists());

    let escaped_cleanup = server
        .dispatch(
            "executor.plugins.personal.package.cleanup",
            json!({"cleanupToken": "../example-plugin"}),
        )
        .await
        .unwrap_err();
    assert_eq!(
        escaped_cleanup.code,
        "plugin_personal_package_cleanup_failed"
    );

    let escaped = server
        .dispatch(
            "executor.plugins.personal.ensure",
            json!({
                "sourceMarketplacePath": source.display().to_string(),
                "destinationMarketplacePath": root.path().join("outside").display().to_string(),
                "pluginName": "example-plugin"
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(escaped.code, "plugin_personal_ensure_failed");
    assert!(escaped
        .message
        .contains("Personal marketplace path must be"));
}

#[tokio::test]
async fn app_ipc_lists_store_reads_manifest_and_saves_plugin_example() {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let executor_home = root.path().join("executor-home");
    let capabilities = executor_home.join("capabilities");
    let store_plugin = capabilities.join("store/plugins/example@wegent");
    fs::create_dir_all(store_plugin.join(".codex-plugin")).unwrap();
    fs::write(
        store_plugin.join(".codex-plugin/plugin.json"),
        r#"{"name":"example","version":"1.2.3","description":"Example plugin","interface":{"displayName":"Example Plugin"},"connectors":[{"id":"oauth"}]}"#,
    )
    .unwrap();
    fs::write(
        capabilities.join("manifest.json"),
        r#"{"plugins":{"example@wegent":{"name":"example","marketplace":"wegent","store_path":"store/plugins/example@wegent"}}}"#,
    )
    .unwrap();

    let local_marketplace = root.path().join("local-marketplace");
    let local_plugin = local_marketplace.join("plugins/example");
    fs::create_dir_all(local_plugin.join(".codex-plugin")).unwrap();
    fs::write(
        local_plugin.join(".codex-plugin/plugin.json"),
        r#"{"name":"example","version":"1.2.3","connectors":[{"id":"oauth"}]}"#,
    )
    .unwrap();

    let bundled_root = root.path().join("bundled-plugins");
    let bundled_marketplace = bundled_root.join("wework-personal");
    let example_source = bundled_root.join("wework-plugin-example");
    fs::create_dir_all(&bundled_marketplace).unwrap();
    fs::create_dir_all(example_source.join(".codex-plugin")).unwrap();
    fs::write(
        example_source.join(".codex-plugin/plugin.json"),
        r#"{"name":"wework-plugin-example","version":"0.1.0"}"#,
    )
    .unwrap();
    fs::write(example_source.join("README.md"), "example").unwrap();
    let destination = root.path().join("downloads/wework-plugin-example.zip");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();

    let _executor_home =
        EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _bundled_marketplace = EnvGuard::set(
        "WEGENT_BUNDLED_PLUGIN_MARKETPLACE_DIR",
        &bundled_marketplace.display().to_string(),
    );
    let server = AppIpcServer::new();

    let listed = server
        .dispatch("executor.plugins.store.list", json!({}))
        .await
        .unwrap();
    assert_eq!(listed["plugins"][0]["name"], "example");
    assert_eq!(listed["plugins"][0]["packageId"], "example@wegent");

    let manifest = server
        .dispatch(
            "executor.plugins.manifest.read",
            json!({
                "marketplacePath": local_marketplace.display().to_string(),
                "pluginName": "example"
            }),
        )
        .await
        .unwrap();
    assert_eq!(manifest["connectors"][0]["id"], "oauth");

    let saved = server
        .dispatch(
            "executor.plugins.example.save",
            json!({"destinationPath": destination.display().to_string()}),
        )
        .await
        .unwrap();
    assert_eq!(
        saved,
        destination.canonicalize().unwrap().display().to_string()
    );
    let bytes = fs::read(destination).unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    assert!(archive.by_name(".codex-plugin/plugin.json").is_ok());
}

#[tokio::test]
async fn app_ipc_imports_and_rolls_back_a_bounded_personal_plugin_copy() {
    use sha2::{Digest, Sha256};
    use std::io::Write as _;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use zip::{write::FileOptions, ZipWriter};

    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let executor_home = root.path().join("executor-home");
    let destination = executor_home.join("capabilities/bundled-marketplaces/wework-personal");
    let cursor = std::io::Cursor::new(Vec::new());
    let mut archive = ZipWriter::new(cursor);
    archive
        .start_file(".codex-plugin/plugin.json", FileOptions::default())
        .unwrap();
    archive
        .write_all(
            br#"{"name":"source-plugin","version":"2.0.0","interface":{"displayName":"Source Plugin"}}"#,
        )
        .unwrap();
    archive
        .start_file("skills/review/SKILL.md", FileOptions::default())
        .unwrap();
    archive.write_all(b"# Review\n").unwrap();
    let package = archive.finish().unwrap().into_inner();
    let sha256 = format!("{:x}", Sha256::digest(&package));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let response_package = package.clone();
    let download_task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request).await.unwrap();
        let headers = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            response_package.len()
        );
        stream.write_all(headers.as_bytes()).await.unwrap();
        stream.write_all(&response_package).await.unwrap();
    });
    let _executor_home =
        EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let server = AppIpcServer::new();

    let imported = server
        .dispatch(
            "executor.plugins.personal.import_copy",
            json!({
                "marketplacePath": destination.display().to_string(),
                "downloadUrl": format!("http://{address}/source-plugin.zip?signature=test"),
                "sha256": sha256,
                "sourcePluginId": 41,
                "sourceReleaseId": 52,
                "sourcePluginName": "source-plugin",
                "sourceDisplayName": "Source Plugin",
                "version": "2.0.0",
                "expiresAt": "2026-08-31T00:00:00Z"
            }),
        )
        .await
        .unwrap();
    download_task.await.unwrap();

    assert_eq!(imported["pluginName"], "source-plugin-copy");
    assert_eq!(imported["version"], "0.1.0");
    let plugin_manifest = destination.join("plugins/source-plugin-copy/.codex-plugin/plugin.json");
    assert!(plugin_manifest.is_file());
    let manifest: Value = serde_json::from_slice(&fs::read(plugin_manifest).unwrap()).unwrap();
    assert_eq!(manifest["name"], "source-plugin-copy");
    assert!(destination
        .join(".agents/plugins/marketplace.json")
        .is_file());

    let escaped = server
        .dispatch(
            "executor.plugins.personal.import_copy",
            json!({
                "marketplacePath": root.path().join("outside").display().to_string(),
                "downloadUrl": "file:///tmp/plugin.zip",
                "sha256": "0".repeat(64),
                "sourcePluginId": 41,
                "sourceReleaseId": 52,
                "sourcePluginName": "source-plugin",
                "sourceDisplayName": "Source Plugin"
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(escaped.code, "plugin_personal_copy_import_failed");
    assert!(escaped
        .message
        .contains("Personal marketplace path must be"));

    server
        .dispatch(
            "executor.plugins.personal.rollback_copy",
            json!({
                "marketplacePath": destination.display().to_string(),
                "pluginName": "source-plugin-copy"
            }),
        )
        .await
        .unwrap();
    assert!(!destination.join("plugins/source-plugin-copy").exists());
}

#[tokio::test]
async fn app_ipc_initializes_a_blank_codex_home() {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let executor_home = root.path().join("executor-home");
    let codex_home = executor_home.join("codex");
    let native_home = root.path().join("native-codex");
    fs::create_dir_all(&native_home).unwrap();
    fs::write(native_home.join("config.toml"), "# native marker\n").unwrap();
    let _executor_home =
        EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _codex_home = EnvGuard::set("WEGENT_CODEX_HOME", &codex_home.display().to_string());
    let _e2e = EnvGuard::set("VITE_WEWORK_E2E", "true");
    let _native_home = EnvGuard::set(
        "WEWORK_E2E_NATIVE_CODEX_HOME",
        &native_home.display().to_string(),
    );

    let server = AppIpcServer::new();
    let status = server
        .dispatch("executor.codex_home.status", json!({}))
        .await
        .unwrap();
    assert_eq!(status["shouldPromptMigration"], true);

    let initialized = server
        .dispatch(
            "executor.codex_home.initialize",
            json!({
                "migrateNativeHome": false,
                "remoteAppsEnabled": true
            }),
        )
        .await
        .unwrap();

    assert_eq!(initialized["shouldPromptMigration"], false);
    let config = fs::read_to_string(codex_home.join("config.toml")).unwrap();
    assert!(!config.contains("native marker"));
    assert!(config.contains("apps = true"));
}

#[tokio::test]
async fn app_ipc_reads_and_updates_codex_local_config() {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let codex_home = root.path().join("codex");
    fs::create_dir_all(&codex_home).unwrap();
    fs::write(
        codex_home.join("config.toml"),
        "model = \"gpt-5\"\n\n[features]\napps = false\n",
    )
    .unwrap();
    let _codex_home = EnvGuard::set("WEGENT_CODEX_HOME", &codex_home.display().to_string());
    let server = AppIpcServer::new();

    let current = server
        .dispatch("executor.codex_home.config.read", json!({}))
        .await
        .unwrap();
    assert_eq!(current["codexHome"], codex_home.display().to_string());
    assert_eq!(
        current["configPath"],
        codex_home.join("config.toml").display().to_string()
    );
    assert_eq!(current["remoteAppsEnabled"], false);

    let updated = server
        .dispatch(
            "executor.codex_home.config.update",
            json!({"patch": {"remoteAppsEnabled": true}}),
        )
        .await
        .unwrap();
    assert_eq!(updated["remoteAppsEnabled"], true);
    let current = server
        .dispatch("executor.codex_home.config.read", json!({}))
        .await
        .unwrap();
    assert_eq!(current["remoteAppsEnabled"], true);
    let config = fs::read_to_string(codex_home.join("config.toml")).unwrap();
    assert!(config.contains("model = \"gpt-5\""));
    assert!(config.contains("[features]\napps = true"));
}

#[tokio::test]
async fn app_ipc_imports_external_codex_content() {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let codex_home = root.path().join("wework-codex");
    fs::create_dir_all(home.join(".codex/skills/example")).unwrap();
    fs::write(home.join(".codex/config.toml"), "model = \"gpt-5\"\n").unwrap();
    fs::write(home.join(".codex/skills/example/SKILL.md"), "example").unwrap();
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _codex_home = EnvGuard::set("WEGENT_CODEX_HOME", &codex_home.display().to_string());

    let result = AppIpcServer::new()
        .dispatch(
            "executor.codex_home.import_external_content",
            json!({"source": "codex"}),
        )
        .await
        .unwrap();

    assert_eq!(result["source"], "codex");
    assert_eq!(
        result["sourcePath"],
        home.join(".codex").display().to_string()
    );
    assert_eq!(result["destinationPath"], codex_home.display().to_string());
    assert_eq!(result["importedEntries"], json!(["config.toml", "skills"]));
    assert_eq!(
        fs::read_to_string(codex_home.join("config.toml")).unwrap(),
        "model = \"gpt-5\"\n"
    );
    assert_eq!(
        fs::read_to_string(codex_home.join("skills/example/SKILL.md")).unwrap(),
        "example"
    );
}

#[tokio::test]
async fn app_ipc_routes_local_first_plugin_install_as_runtime_rpc() {
    let server = AppIpcServer::new().with_runtime_work_handler(LocalPluginInstallRuntimeHandler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-local-plugin",
                "method": "runtime.codex.plugin.install_local_first",
                "params": {
                    "marketplacePath": "/tmp/wework-personal/.agents/plugins/marketplace.json",
                    "pluginName": "example-plugin"
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(
        response,
        json!({
            "type": "response",
            "id": "req-local-plugin",
            "ok": true,
            "result": {
                "pluginKey": "example-plugin@wework-personal",
                "localCommitted": true
            }
        })
    );
}

#[tokio::test]
async fn app_ipc_routes_local_plugin_uninstall_as_runtime_rpc() {
    let server = AppIpcServer::new().with_runtime_work_handler(LocalPluginUninstallRuntimeHandler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-local-plugin-uninstall",
                "method": "runtime.codex.plugin.uninstall_local",
                "params": {
                    "marketplacePath": "/tmp/wework-personal/.agents/plugins/marketplace.json",
                    "pluginName": "example-plugin"
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(
        response,
        json!({
            "type": "response",
            "id": "req-local-plugin-uninstall",
            "ok": true,
            "result": {
                "pluginKey": "example-plugin@wework-personal",
                "localCommitted": true
            }
        })
    );
}

#[tokio::test]
async fn app_ipc_manages_local_projects_and_nested_todos() {
    let _lock = env_lock().await;
    let executor_home = tempfile::tempdir().unwrap();
    let _executor_home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &executor_home.path().display().to_string(),
    );
    let server = AppIpcServer::new();

    let project = server
        .dispatch(
            "projects.create",
            json!({
                "name": "Local Work",
                "project_key": "LOCAL",
                "description": "Stored by Executor",
                "task_provider": "local"
            }),
        )
        .await
        .unwrap();
    let project_id = project["id"].as_str().unwrap();
    let updated_project = server
        .dispatch(
            "projects.update",
            json!({
                "project_id": project_id,
                "project": {
                    "version": project["version"],
                    "name": "Renamed Local Work",
                    "tags": ["desktop"]
                }
            }),
        )
        .await
        .unwrap();
    assert_eq!(updated_project["name"], "Renamed Local Work");
    assert_eq!(updated_project["metadata"]["tags"], json!(["desktop"]));

    let parent = server
        .dispatch(
            "todos.create",
            json!({
                "project_id": project_id,
                "todo": {
                    "title": "Parent",
                    "status": "inbox",
                    "priority": "high"
                }
            }),
        )
        .await
        .unwrap();
    let parent_id = parent["id"].as_str().unwrap();

    let child = server
        .dispatch(
            "todos.create",
            json!({
                "project_id": project_id,
                "todo": {
                    "title": "Child",
                    "parent_id": parent_id
                }
            }),
        )
        .await
        .unwrap();

    let todos = server
        .dispatch("todos.list", json!({"project_id": project_id}))
        .await
        .unwrap();
    assert_eq!(todos.as_array().unwrap().len(), 2);
    assert_eq!(child["parent_id"], parent["id"]);

    let updated = server
        .dispatch(
            "todos.update",
            json!({
                "project_id": project_id,
                "task_id": parent_id,
                "todo": {
                    "version": parent["version"],
                    "status": "completed"
                }
            }),
        )
        .await
        .unwrap();
    assert_eq!(updated["status"], "completed");
    assert!(updated["completed_at"].is_string());

    let conflict = server
        .dispatch(
            "todos.update",
            json!({
                "project_id": project_id,
                "task_id": parent_id,
                "todo": {
                    "version": parent["version"],
                    "title": "Stale update"
                }
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(conflict.code, "version_conflict");

    server
        .dispatch(
            "todos.archive",
            json!({"project_id": project_id, "task_id": parent_id}),
        )
        .await
        .unwrap();
    let todos = server
        .dispatch("todos.list", json!({"project_id": project_id}))
        .await
        .unwrap();
    assert!(todos.as_array().unwrap().is_empty());

    let projects = server.dispatch("projects.list", json!({})).await.unwrap();
    let current_project = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["id"] == project_id)
        .expect("created project should be listed");
    server
        .dispatch(
            "projects.archive",
            json!({"project_id": project_id, "version": current_project["version"]}),
        )
        .await
        .unwrap();
    let projects = server.dispatch("projects.list", json!({})).await.unwrap();
    assert_eq!(projects.as_array().unwrap().len(), 1);
    assert_eq!(projects[0]["id"], "default-work-items");
    assert_eq!(projects[0]["name"], "我的任务");
    assert!(executor_home.path().join("data/tasks.sqlite").is_file());
}

#[tokio::test]
async fn app_ipc_reconciles_runtime_status_at_task_service_boundaries() {
    let _lock = env_lock().await;
    let executor_home = tempfile::tempdir().unwrap();
    let _executor_home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &executor_home.path().display().to_string(),
    );
    let reconciliations = Arc::new(Mutex::new(0));
    let server = AppIpcServer::new().with_runtime_work_handler(ProjectionRuntimeHandler {
        reconciliations: Arc::clone(&reconciliations),
    });
    let project = server
        .dispatch(
            "projects.create",
            json!({
                "name": "Bound Runtime",
                "project_key": "BOUND",
                "task_provider": "local"
            }),
        )
        .await
        .unwrap();
    let task = server
        .dispatch(
            "todos.create",
            json!({
                "project_id": project["id"],
                "todo": {"title": "Track running task"}
            }),
        )
        .await
        .unwrap();

    server
        .dispatch(
            "todos.bind",
            json!({
                "project_id": project["id"],
                "item_id": task["id"],
                "task": {
                    "device_id": "local-device",
                    "task_id": "runtime-running-1",
                    "task_title": "Track running task"
                }
            }),
        )
        .await
        .unwrap();

    server
        .dispatch("todos.list", json!({"project_id": project["id"]}))
        .await
        .unwrap();

    assert_eq!(*reconciliations.lock().unwrap(), 2);
}

#[tokio::test]
async fn app_ipc_stores_project_files_attachments_and_deliveries_locally() {
    let _lock = env_lock().await;
    let executor_home = tempfile::tempdir().unwrap();
    let _executor_home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &executor_home.path().display().to_string(),
    );
    let server = AppIpcServer::new();

    let project = server
        .dispatch(
            "projects.create",
            json!({
                "name": "Content",
                "project_key": "LOCAL",
                "task_provider": "local"
            }),
        )
        .await
        .unwrap();
    let project_id = project["id"].as_str().unwrap();
    let task = server
        .dispatch(
            "todos.create",
            json!({"project_id": project_id, "todo": {"title": "Write report"}}),
        )
        .await
        .unwrap();
    let task_id = task["id"].as_str().unwrap();

    let uploaded = server
        .dispatch(
            "files.upload",
            json!({
                "project_id": project_id,
                "path": "docs/readme.txt",
                "file": {
                    "display_name": "readme.txt",
                    "content_type": "text/plain",
                    "base64": "aGVsbG8="
                }
            }),
        )
        .await
        .unwrap();
    let file_id = uploaded["id"].as_str().unwrap();
    let access = server
        .dispatch("files.access", json!({"file_id": file_id}))
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(access["path"].as_str().unwrap()).unwrap(),
        "hello"
    );

    let moved = server
        .dispatch(
            "files.move",
            json!({
                "file_id": file_id,
                "path": "docs/guides/readme.txt",
                "version": uploaded["version"]
            }),
        )
        .await
        .unwrap();
    assert_eq!(moved["path"], "docs/guides/readme.txt");

    let attachment = server
        .dispatch(
            "attachments.add",
            json!({
                "project_id": project_id,
                "item_id": task_id,
                "file": {
                    "display_name": "notes.txt",
                    "base64": "bm90ZXM="
                }
            }),
        )
        .await
        .unwrap();
    let attachment_id = attachment["id"].as_str().unwrap();
    let attachment_access = server
        .dispatch(
            "attachments.access",
            json!({
                "project_id": project_id,
                "item_id": task_id,
                "attachment_id": attachment_id
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(attachment_access["path"].as_str().unwrap()).unwrap(),
        "notes"
    );

    let delivery = server
        .dispatch(
            "deliveries.create",
            json!({
                "project_id": project_id,
                "item_id": task_id,
                "delivery": {
                    "markdown": "# Result",
                    "chat": {"messages": []}
                }
            }),
        )
        .await
        .unwrap();
    let delivery_id = delivery["id"].as_str().unwrap();
    let asset = server
        .dispatch(
            "deliveries.add_asset",
            json!({
                "delivery_id": delivery_id,
                "relative_path": "assets/result.txt",
                "file": {
                    "display_name": "result.txt",
                    "base64": "ZG9uZQ=="
                }
            }),
        )
        .await
        .unwrap();
    let asset_id = asset["id"].as_str().unwrap();
    let finalized = server
        .dispatch(
            "deliveries.finalize",
            json!({"item_id": task_id, "delivery_id": delivery_id}),
        )
        .await
        .unwrap();
    assert_eq!(finalized["status"], "delivered");

    let detail = server
        .dispatch("deliveries.get", json!({"delivery_id": delivery_id}))
        .await
        .unwrap();
    assert_eq!(detail["markdown"], "# Result");
    assert_eq!(detail["chat"]["messages"].as_array().unwrap().len(), 0);

    let asset_access = server
        .dispatch("deliveries.access_asset", json!({"asset_id": asset_id}))
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(asset_access["path"].as_str().unwrap()).unwrap(),
        "done"
    );
    assert!(executor_home.path().join("data/objects").is_dir());
}

#[tokio::test]
async fn app_ipc_reclaims_expired_local_robot_runs() {
    let _lock = env_lock().await;
    let executor_home = tempfile::tempdir().unwrap();
    let _executor_home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &executor_home.path().display().to_string(),
    );
    let server = AppIpcServer::new()
        .with_runtime_instance_id("runtime-1")
        .with_runtime_work_handler(CapacityRuntimeHandler);

    let project = server
        .dispatch(
            "projects.create",
            json!({
                "name": "Queue project",
                "project_key": "QUEUE",
                "description": "",
                "task_provider": "local"
            }),
        )
        .await
        .unwrap();
    let project_id = project["id"].as_str().unwrap().to_owned();

    let agent = server
        .dispatch(
            "chat_agents.create",
            json!({
                "project_id": project_id,
                "agent": {
                    "name": "Queue Bot",
                    "model": null,
                    "system_prompt": "",
                    "visibility": "creator_admin",
                    "execution_environment": "local",
                    "execution_mode": "auto",
                    "execution_device_id": "local-device"
                }
            }),
        )
        .await
        .unwrap();
    let agent_id = agent["id"].as_str().unwrap().to_owned();

    let task = server
        .dispatch(
            "todos.create",
            json!({
                "project_id": project_id,
                "todo": {
                    "title": "Queue task",
                    "status": "inbox",
                    "priority": "high"
                }
            }),
        )
        .await
        .unwrap();
    let task_id = task["id"].as_str().unwrap().to_owned();
    server
        .dispatch(
            "todos.update",
            json!({
                "project_id": project_id,
                "task_id": task_id,
                "todo": {
                    "version": task["version"],
                    "assignee_agent_id": agent_id
                }
            }),
        )
        .await
        .unwrap();

    let claimed = server
        .dispatch(
            "executions.claim_next",
            json!({
                "claim": {
                    "execution_device_id": "local-device",
                    "lease_seconds": 300
                }
            }),
        )
        .await
        .unwrap();
    let execution_id = claimed["id"].as_i64().unwrap();
    assert_eq!(claimed["status"], "claimed");
    assert_eq!(claimed["display_state"], "starting");

    // Crash the run out-of-band: expire the lease without a terminal event.
    let connection =
        rusqlite::Connection::open(executor_home.path().join("data/tasks.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE loop_item_executions
             SET lease_expires_at = '2000-01-01T00:00:00+00:00'
             WHERE id = ?1",
            rusqlite::params![execution_id],
        )
        .unwrap();
    drop(connection);

    let recovered = server
        .dispatch("executions.recover_stale", json!({}))
        .await
        .unwrap();
    assert_eq!(recovered["requeued"], 1);
    assert_eq!(recovered["unknown"], 0);
    let stale = server
        .dispatch("executions.list_stale", json!({}))
        .await
        .unwrap();
    assert!(stale.as_array().unwrap().is_empty());
    let reconciled = server
        .dispatch(
            "executions.reconcile",
            json!({
                "execution_id": execution_id,
                "runtime_status": "missing",
                "running": false,
                "turn_status": null
            }),
        )
        .await
        .unwrap();
    assert_eq!(reconciled["status"], "queued");

    let executions = server
        .dispatch(
            "executions.list",
            json!({
                "project_id": project_id,
                "agent_id": null,
                "status": null,
                "include_terminal": true
            }),
        )
        .await
        .unwrap();
    let list = executions.as_array().unwrap();
    assert_eq!(list[0]["status"], "queued");
    assert_eq!(list[0]["retry_attempt"], 0);

    let cancelled = server
        .dispatch(
            "executions.cancel",
            json!({
                "execution_id": execution_id,
                "note": "stopped from the queue"
            }),
        )
        .await
        .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["display_state"], "cancelled");
    assert_eq!(cancelled["termination_reason"], "cancelled_before_start");
}

#[tokio::test]
async fn app_ipc_encrypts_provider_credentials_and_masks_project_responses() {
    let _lock = env_lock().await;
    let executor_home = tempfile::tempdir().unwrap();
    let _executor_home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &executor_home.path().display().to_string(),
    );
    let server = AppIpcServer::new();

    let project = server
        .dispatch(
            "projects.create",
            json!({
                "name": "GitHub board",
                "project_key": "GH",
                "task_provider": "github",
                "provider_config": {
                    "repository": "acme/repo",
                    "domain": "github.com",
                    "token": "github-secret"
                }
            }),
        )
        .await
        .unwrap();

    assert_eq!(
        project["metadata"]["provider_config"]["credential_configured"],
        true
    );
    assert!(project["metadata"]["provider_config"]
        .get("credential")
        .is_none());
    assert!(!project.to_string().contains("github-secret"));

    let connection =
        rusqlite::Connection::open(executor_home.path().join("data/tasks.sqlite")).unwrap();
    let metadata: String = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE id = ?1",
            [project["id"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!metadata.contains("github-secret"));
    let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(
        metadata["provider_config"]["credential"]["algorithm"],
        "aes-256-gcm"
    );
    assert!(metadata["provider_config"]["credential"]["ciphertext"].is_string());
    assert!(executor_home
        .path()
        .join("credentials/provider-master-key-v1")
        .is_file());

    let project = server
        .dispatch(
            "projects.update",
            json!({
                "project_id": project["id"],
                "project": {
                    "version": project["version"],
                    "provider_config": {
                        "repository": "acme/repo",
                        "domain": "github.com",
                        "token": "rotated-secret"
                    }
                }
            }),
        )
        .await
        .unwrap();
    assert_eq!(
        project["metadata"]["provider_config"]["credential_configured"],
        true
    );
    assert!(!project.to_string().contains("rotated-secret"));

    let metadata: String = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE id = ?1",
            [project["id"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!metadata.contains("github-secret"));
    assert!(!metadata.contains("rotated-secret"));
}

#[tokio::test]
async fn app_ipc_emits_runtime_events_with_device_id() {
    let server = AppIpcServer::new().with_device_id("device-1");

    let event = server.event_message(
        "response.output_text.delta",
        json!({"local_task_id": "task-1", "data": {"delta": "hi"}}),
    );

    assert_eq!(
        event,
        json!({
            "type": "event",
            "event": "response.output_text.delta",
            "payload": {
                "device_id": "device-1",
                "local_task_id": "task-1",
                "data": {"delta": "hi"}
            }
        })
    );
}

#[tokio::test]
async fn app_ipc_resolves_configured_device_command() {
    let command_handler = CaptureCommandHandler::default();
    let seen_request = Arc::clone(&command_handler.seen_request);
    let server = AppIpcServer::new().with_command_handler(command_handler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-2",
                "method": "device.execute_command",
                "params": {
                    "command_key": "ls_dirs",
                    "path": "/tmp/project",
                    "timeout_seconds": 10,
                    "max_output_bytes": 4096
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(
        *seen_request.lock().unwrap(),
        Some(CommandRequest {
            command: "ls -a -p".to_owned(),
            argv: vec!["ls".to_owned(), "-a".to_owned(), "-p".to_owned()],
            cwd: Some("/tmp/project".to_owned()),
            env: Default::default(),
            timeout_seconds: 10.0,
            max_output_bytes: 4096,
        })
    );
    assert_eq!(response["result"]["stdout"], json!(["src"]));
}

#[tokio::test]
async fn app_ipc_lists_and_reads_workspace_files_locally() {
    let workspace = unique_dir("workspace-files");
    fs::create_dir_all(workspace.join("src")).unwrap();
    fs::write(workspace.join("README.md"), "hello").unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let server = AppIpcServer::new();

    let tree_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-tree",
                "method": "device.execute_command",
                "params": {
                    "command_key": "workspace_tree",
                    "path": workspace.display().to_string(),
                    "timeout_seconds": 10,
                    "max_output_bytes": 4096
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(tree_response["ok"], true);
    assert_eq!(tree_response["result"]["success"], true);
    assert_eq!(
        tree_response["result"]["stdout"]["path"],
        json!(workspace.display().to_string())
    );
    assert_eq!(
        tree_response["result"]["stdout"]["entries"][0]["name"],
        json!("src")
    );

    let file_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-file",
                "method": "device.execute_command",
                "params": {
                    "command_key": "workspace_read_text_file",
                    "path": workspace.display().to_string(),
                    "args": ["README.md"],
                    "timeout_seconds": 10,
                    "max_output_bytes": 4096
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(file_response["ok"], true);
    assert_eq!(file_response["result"]["success"], true);
    assert_eq!(file_response["result"]["stdout"]["content"], json!("hello"));

    let chunk_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-file-chunk",
                "method": "device.execute_command",
                "params": {
                    "command_key": "workspace_read_file_chunk",
                    "path": workspace.display().to_string(),
                    "args": ["README.md", "0"],
                    "timeout_seconds": 10,
                    "max_output_bytes": 2_097_152
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(chunk_response["ok"], true);
    assert_eq!(chunk_response["result"]["success"], true);
    assert_eq!(
        chunk_response["result"]["stdout"]["content_base64"],
        json!("aGVsbG8=")
    );
    assert_eq!(chunk_response["result"]["stdout"]["eof"], true);

    let _ = fs::remove_dir_all(workspace);
}

#[tokio::test]
async fn app_ipc_rejects_workspace_files_outside_allowed_roots() {
    let allowed_workspace = unique_dir("workspace-files-allowed");
    fs::create_dir_all(&allowed_workspace).unwrap();
    let allowed_workspace = fs::canonicalize(allowed_workspace).unwrap();
    let blocked_workspace = unique_dir("workspace-files-blocked");
    fs::create_dir_all(&blocked_workspace).unwrap();
    let blocked_workspace = fs::canonicalize(blocked_workspace).unwrap();
    let server = AppIpcServer::new();

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-blocked-tree",
                "method": "device.execute_command",
                "params": {
                    "command_key": "workspace_tree",
                    "path": blocked_workspace.display().to_string(),
                    "env": {"WEGENT_WORKSPACE_ROOTS": allowed_workspace.display().to_string()},
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["success"], false);
    assert_eq!(
        response["result"]["error"],
        json!("Workspace path is outside allowed workspace roots")
    );

    let _ = fs::remove_dir_all(allowed_workspace);
    let _ = fs::remove_dir_all(blocked_workspace);
}

#[tokio::test]
async fn app_ipc_lists_codex_skills_from_runtime_directories() {
    let _lock = env_lock().await;
    let home = unique_dir("local-skills-home");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _codex_home = EnvGuard::set("CODEX_HOME", "");
    let agents_skill = home.join(".agents/skills/env-context");
    let claude_skill = home.join(".claude/skills/claude-review");
    let codex_skill = home.join(".codex/skills/codex-review");
    let codex_system_skill = home.join(".codex/skills/.system/codex-system");
    let claude_plugin_skill = home.join(".claude/plugins/cache/vendor/example/skills/plugin-skill");
    let codex_plugin_skill = home
        .join(".codex/plugins/cache/openai-curated-remote/codex-pack/0.1.0/skills/codex-plugin");
    let old_codex_plugin_skill =
        home.join(".codex/plugins/cache/openai-curated/codex-pack/deadbeef/skills/codex-plugin");
    fs::create_dir_all(&agents_skill).unwrap();
    fs::create_dir_all(&claude_skill).unwrap();
    fs::create_dir_all(&codex_skill).unwrap();
    fs::create_dir_all(&codex_system_skill).unwrap();
    fs::create_dir_all(&claude_plugin_skill).unwrap();
    fs::create_dir_all(&codex_plugin_skill).unwrap();
    fs::create_dir_all(&old_codex_plugin_skill).unwrap();
    fs::write(
        agents_skill.join("SKILL.md"),
        "---\nname: env-context\ndescription: Environment facts\n---\n",
    )
    .unwrap();
    fs::write(
        claude_skill.join("SKILL.md"),
        "---\nname: claude-review\ndescription: Claude review\n---\n",
    )
    .unwrap();
    fs::write(
        codex_skill.join("SKILL.md"),
        "---\nname: codex-review\ndescription: |\n  Review with Codex\n  across files\n---\n",
    )
    .unwrap();
    fs::write(
        codex_system_skill.join("SKILL.md"),
        "---\nname: codex-system\ndescription: Built in Codex skill\n---\n",
    )
    .unwrap();
    fs::write(
        claude_plugin_skill.join("SKILL.md"),
        "---\nname: plugin-skill\ndescription: Claude plugin skill\n---\n",
    )
    .unwrap();
    fs::write(
        codex_plugin_skill.join("SKILL.md"),
        "---\nname: codex-plugin\ndescription: Current Codex plugin skill\n---\n",
    )
    .unwrap();
    fs::write(
        old_codex_plugin_skill.join("SKILL.md"),
        "---\nname: codex-plugin\ndescription: Old Codex plugin skill\n---\n",
    )
    .unwrap();

    let server = AppIpcServer::new();
    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-skills",
                "method": "device.execute_command",
                "params": {
                    "command_key": "ls_skills",
                    "timeout_seconds": 10,
                    "max_output_bytes": 4096
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["success"], true);
    let skills = response["result"]["stdout"].as_array().unwrap();
    assert_eq!(skills.len(), 3);
    assert_eq!(skills[0]["name"], json!("codex-review"));
    assert_eq!(
        skills[0]["description"],
        json!("Review with Codex\nacross files")
    );
    assert_eq!(skills[0]["source"], json!("codex"));
    assert_eq!(skills[0]["scope"], json!("user"));
    assert_eq!(skills[0]["source_priority"], json!(0));
    assert_eq!(
        skills[0]["path"],
        json!(codex_skill.join("SKILL.md").display().to_string())
    );
    assert_eq!(skills[1]["name"], json!("codex-system"));
    assert_eq!(skills[1]["description"], json!("Built in Codex skill"));
    assert_eq!(skills[1]["source"], json!("codex"));
    assert_eq!(skills[1]["scope"], json!("system"));
    assert_eq!(skills[1]["source_priority"], json!(10));
    assert_eq!(
        skills[1]["path"],
        json!(codex_system_skill.join("SKILL.md").display().to_string())
    );
    assert_eq!(skills[2]["name"], json!("codex-plugin"));
    assert_eq!(
        skills[2]["description"],
        json!("Current Codex plugin skill")
    );
    assert_eq!(skills[2]["source"], json!("codex-plugin"));
    assert_eq!(skills[2]["scope"], json!("user"));
    assert_eq!(skills[2]["plugin_name"], json!("codex-pack"));
    assert_eq!(skills[2]["plugin_provider"], json!("openai-curated-remote"));
    assert_eq!(skills[2]["plugin_version"], json!("0.1.0"));
    assert_eq!(skills[2]["source_priority"], json!(20));
    assert_eq!(
        skills[2]["path"],
        json!(codex_plugin_skill.join("SKILL.md").display().to_string())
    );

    let _ = fs::remove_dir_all(home);
}

#[tokio::test]
async fn app_ipc_resolves_review_and_git_device_commands() {
    let workspace = tempfile::tempdir().unwrap();
    let git_dir = workspace.path().join(".git");
    fs::create_dir_all(git_dir.join("objects")).unwrap();
    fs::create_dir_all(git_dir.join("refs")).unwrap();
    fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();

    let command_handler = CaptureCommandHandler::default();
    let seen_request = Arc::clone(&command_handler.seen_request);
    let server = AppIpcServer::new().with_command_handler(command_handler);

    let git_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-git",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_diff",
                    "path": workspace.path().display().to_string()
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(git_response["ok"], true);
    assert_eq!(
        seen_request
            .lock()
            .unwrap()
            .as_ref()
            .map(|request| request.argv[0].clone()),
        None,
        "git_diff must run through the native handler instead of a shell"
    );

    let worktree_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-worktree",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_worktree_add",
                    "args": ["/tmp/project", "/tmp/worktrees/1/project"]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(worktree_response["ok"], true);
    assert!(
        seen_request.lock().unwrap().is_none(),
        "git_worktree_add must run through the native handler instead of a shell"
    );

    let selected_branch_worktree_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-worktree-branch",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_worktree_add",
                    "args": ["/tmp/project", "/tmp/worktrees/2/project", "main"]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(selected_branch_worktree_response["ok"], true);
    assert!(
        seen_request.lock().unwrap().is_none(),
        "git_worktree_add with a branch must run through the native handler"
    );

    let remove_worktree_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-worktree-remove",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_worktree_remove",
                    "args": ["/tmp/worktrees/2/project", "/tmp/worktrees/2/project"]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(remove_worktree_response["ok"], true);
    assert!(
        seen_request.lock().unwrap().is_none(),
        "git_worktree_remove must run through the native handler instead of a shell"
    );

    let review_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-review",
                "method": "device.execute_command",
                "params": {
                    "command_key": "turn_file_changes_review",
                    "path": "/tmp/project",
                    "args": ["turn-file-changes/0/1"]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(review_response["ok"], true);
    assert!(
        seen_request.lock().unwrap().is_none(),
        "turn_file_changes_review must run through the native handler"
    );

    let commit_message_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-commit-message",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_generate_commit_message",
                    "path": "/tmp/project"
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(commit_message_response["ok"], true);
    assert_eq!(commit_message_response["result"]["success"], false);
    assert_eq!(
        commit_message_response["result"]["stdout"]["success"],
        false
    );
    assert_eq!(
        seen_request.lock().unwrap().as_ref(),
        None,
        "native commit message generation must not dispatch through the generic command handler"
    );
    let push_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-git-push",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_push",
                    "path": "/tmp/project"
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(push_response["ok"], true);
    assert!(
        seen_request.lock().unwrap().is_none(),
        "git_push must run through the native handler instead of a shell"
    );
}

#[tokio::test]
async fn app_ipc_resolves_browser_session_device_commands() {
    let command_handler = JsonCaptureCommandHandler::default();
    let seen_request = Arc::clone(&command_handler.seen_request);
    let server = AppIpcServer::new().with_command_handler(command_handler);

    let relay_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-browser-relay",
                "method": "device.execute_command",
                "params": {
                    "command_key": "browser_relay_restart"
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(relay_response["ok"], true);
    let request = seen_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.argv[0], "sh");
    assert!(request.argv[2].contains("cdp-relay-server"));
    assert!(request.argv[2].contains("--restart"));

    let tool_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-browser-tool",
                "method": "device.execute_command",
                "params": {
                    "command_key": "browser_tool",
                    "args": ["{\"action\":\"open\",\"url\":\"https://example.com\"}"]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(tool_response["ok"], true);
    let request = seen_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.argv[0], "sh");
    assert_eq!(request.argv[3], "--");
    assert_eq!(
        request.argv[4],
        "{\"action\":\"open\",\"url\":\"https://example.com\"}"
    );
    assert!(request.argv[2].contains("browser-tool"));
}

#[derive(Default)]
struct JsonCaptureCommandHandler {
    seen_request: Arc<Mutex<Option<CommandRequest>>>,
}

impl DeviceCommandHandler for JsonCaptureCommandHandler {
    fn handle_execute_command<'a>(
        &'a self,
        request: CommandRequest,
    ) -> Pin<Box<dyn Future<Output = CommandResult> + Send + 'a>> {
        Box::pin(async move {
            *self.seen_request.lock().unwrap() = Some(request);
            CommandResult::ok(json!({"ok": true}).to_string())
        })
    }
}

#[tokio::test]
async fn app_ipc_does_not_spawn_git_for_plain_workspaces() {
    let workspace = tempfile::tempdir().unwrap();
    let command_handler = JsonCaptureCommandHandler::default();
    let seen_request = Arc::clone(&command_handler.seen_request);
    let server = AppIpcServer::new().with_command_handler(command_handler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-plain-workspace-git",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_branch",
                    "path": workspace.path().display().to_string()
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["success"], false);
    assert_eq!(
        response["result"]["error"],
        "Workspace is not a Git repository"
    );
    assert!(seen_request.lock().unwrap().is_none());
}

#[tokio::test]
async fn app_ipc_routes_git_inspection_for_repository_workspaces() {
    let workspace = tempfile::tempdir().unwrap();
    let git_dir = workspace.path().join(".git");
    fs::create_dir_all(git_dir.join("objects")).unwrap();
    fs::create_dir_all(git_dir.join("refs")).unwrap();
    fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();

    let command_handler = JsonCaptureCommandHandler::default();
    let seen_request = Arc::clone(&command_handler.seen_request);
    let server = AppIpcServer::new().with_command_handler(command_handler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-repository-workspace-git",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_branch",
                    "path": workspace.path().display().to_string()
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["success"], true);
    let request = seen_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.argv, ["git", "branch", "--show-current"]);
}

#[tokio::test]
async fn app_ipc_accepts_gitdir_with_configured_worktree_as_worktree_source() {
    let root = unique_dir("gitdir-worktree-source");
    let source_worktree = root.join("source");
    let source_gitdir = root.join("source.git");
    let target_worktree = root.join("target");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&source_worktree).unwrap();

    assert_command_success(
        git_command()
            .args([
                "init",
                "--separate-git-dir",
                source_gitdir.to_str().unwrap(),
            ])
            .arg(&source_worktree)
            .output()
            .unwrap(),
    );
    assert_command_success(
        git_command()
            .args([
                "-C",
                source_worktree.to_str().unwrap(),
                "config",
                "user.email",
                "test@example.com",
            ])
            .output()
            .unwrap(),
    );
    assert_command_success(
        git_command()
            .args([
                "-C",
                source_worktree.to_str().unwrap(),
                "config",
                "user.name",
                "Test User",
            ])
            .output()
            .unwrap(),
    );
    fs::write(source_worktree.join("README.md"), "hello\n").unwrap();
    assert_command_success(
        git_command()
            .args(["-C", source_worktree.to_str().unwrap(), "add", "README.md"])
            .output()
            .unwrap(),
    );
    assert_command_success(
        git_command()
            .args([
                "-C",
                source_worktree.to_str().unwrap(),
                "commit",
                "-m",
                "init",
            ])
            .output()
            .unwrap(),
    );
    assert_command_success(
        git_command()
            .args([
                "--git-dir",
                source_gitdir.to_str().unwrap(),
                "config",
                "core.worktree",
                source_worktree.to_str().unwrap(),
            ])
            .output()
            .unwrap(),
    );

    let server = AppIpcServer::new();
    let check_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-gitdir-check",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_is_worktree",
                    "args": [source_gitdir.display().to_string()]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(check_response["ok"], true);
    assert_eq!(check_response["result"]["success"], true);
    assert_eq!(check_response["result"]["stdout"], json!("true\n"));

    let add_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-gitdir-add",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_worktree_add",
                    "args": [
                        source_gitdir.display().to_string(),
                        target_worktree.display().to_string()
                    ]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(add_response["ok"], true);
    assert_eq!(add_response["result"]["success"], true);
    assert!(target_worktree.join("README.md").is_file());

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn app_ipc_routes_external_project_configuration() {
    let _lock = env_lock().await;
    let executor_home = tempfile::tempdir().unwrap();
    let _executor_home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &executor_home.path().display().to_string(),
    );
    let server = AppIpcServer::new();

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-external-project",
                "method": "external_projects.configure",
                "params": {
                    "project": {
                        "id": "cloud-1",
                        "public_id": "public-1",
                        "project_key": "CLOUD",
                        "name": "Cloud GitLab board",
                        "project_store": "backend",
                        "task_provider": "gitlab",
                        "provider_config": {
                            "repository": "acme/repo",
                            "domain": "gitlab.example.com",
                            "api_base": "https://gitlab.example.com/api/v4",
                            "token": "gitlab-secret"
                        },
                        "version": 1
                    }
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["id"], "cloud-1");
    assert_eq!(response["result"]["metadata"]["task_provider"], "gitlab");
    assert_eq!(
        response["result"]["metadata"]["provider_config"]["credential_configured"],
        true
    );
    assert!(!response.to_string().contains("gitlab-secret"));
}

#[tokio::test]
async fn app_ipc_health_check_confirms_bidirectional_transport() {
    let server = AppIpcServer::new();

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-health",
                "method": "executor.health",
                "params": {}
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["status"], "healthy");
}

#[tokio::test]
async fn app_ipc_unknown_method_returns_protocol_error() {
    let server = AppIpcServer::new();

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-3",
                "method": "unknown.method",
                "params": {}
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "unsupported_method");
}

#[test]
fn app_ipc_stdio_ready_log_line_includes_device_and_transport() {
    let line = app_ipc_stdio_ready_log_line("device-1");

    assert_log_timestamp(&line);
    assert!(line.contains(" app IPC stdio ready device_id=device-1 transport=stdio"));
    assert!(line.contains(" process_id="));
}

fn assert_log_timestamp(line: &str) {
    let timestamp = &line[..19];
    assert_eq!(timestamp.as_bytes()[4], b'-');
    assert_eq!(timestamp.as_bytes()[7], b'-');
    assert_eq!(timestamp.as_bytes()[10], b' ');
    assert_eq!(timestamp.as_bytes()[13], b':');
    assert_eq!(timestamp.as_bytes()[16], b':');
}

#[tokio::test]
async fn app_ipc_stdio_serves_ready_event_and_responses_until_input_closes() {
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        time::{timeout, Duration},
    };

    let server = AppIpcServer::new().with_device_id("device-1");
    let (client, executor) = tokio::io::duplex(4096);
    let (executor_reader, executor_writer) = tokio::io::split(executor);
    let task = tokio::spawn(async move { server.serve_io(executor_reader, executor_writer).await });
    let (reader, mut writer) = tokio::io::split(client);
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    reader.read_line(&mut line).await.unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["event"], "executor.ready");
    assert_eq!(ready["payload"]["device_id"], "device-1");
    assert_eq!(ready["payload"]["ready"], true);
    assert_eq!(ready["payload"]["protocol_version"], 1);
    assert!(ready["payload"]["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("runtime.tasks")));

    writer
        .write_all(
            json!({
                "type": "request",
                "id": "req-socket",
                "method": "unknown.method",
                "params": {}
            })
            .to_string()
            .as_bytes(),
        )
        .await
        .unwrap();
    writer.write_all(b"\n").await.unwrap();

    line.clear();
    reader.read_line(&mut line).await.unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], "req-socket");
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "unsupported_method");

    writer.shutdown().await.unwrap();
    drop(writer);
    assert!(timeout(Duration::from_secs(1), task)
        .await
        .expect("stdio server should stop after stdin closes")
        .expect("stdio server task should join")
        .is_ok());
}

#[tokio::test]
async fn app_ipc_describes_the_versioned_desktop_protocol() {
    let server = AppIpcServer::new()
        .with_device_id("device-1")
        .with_runtime_instance_id("runtime-1");

    let description = server
        .dispatch("executor.protocol.describe", json!({}))
        .await
        .unwrap();

    assert_eq!(description["protocol_version"], 1);
    assert_eq!(description["device_id"], "device-1");
    assert_eq!(description["runtime_instance_id"], "runtime-1");
    assert_eq!(description["features"]["structured_errors"], true);
    assert_eq!(description["features"]["event_resume"], true);
    assert!(description["transports"]
        .as_array()
        .unwrap()
        .contains(&json!("stdio-ndjson")));
    assert!(description["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("runtime.worktrees")));
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("codex.app_server_request")));
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("runtime.*")));
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.harnesses.list")));
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.harnesses.prepare_launch")));
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.plugins.initialize_bundled_marketplace")));
    for method in [
        "executor.plugins.import_package.preview",
        "executor.plugins.import_package",
        "executor.plugins.import_package.finalize",
        "executor.plugins.import_package.rollback",
        "executor.plugins.links.list",
        "executor.plugins.links.link",
        "executor.plugins.links.unlink",
        "executor.plugins.personal.delete",
        "executor.plugins.personal.ensure",
        "executor.plugins.personal.import_copy",
        "executor.plugins.personal.list",
        "executor.plugins.personal.package",
        "executor.plugins.personal.package.cleanup",
        "executor.plugins.personal.rollback_copy",
        "executor.plugins.store.list",
        "executor.plugins.manifest.read",
        "executor.plugins.example.save",
    ] {
        assert!(description["renderer_methods"]
            .as_array()
            .unwrap()
            .contains(&json!(method)));
    }
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.codex_home.status")));
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.codex_home.config.read")));
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.codex_home.config.update")));
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.codex_home.import_external_content")));
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.codex_home.initialize")));
    assert!(description["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.harnesses")));
    assert!(description["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.plugins")));
    assert!(!description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.protocol.describe")));
}

fn unique_dir(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-executor-local-app-ipc-{label}-{}",
        std::process::id()
    ))
}

fn git_command() -> std::process::Command {
    let mut command = std::process::Command::new("git");
    for key in LOCAL_GIT_ENV_VARS {
        command.env_remove(key);
    }
    command
}

fn assert_command_success(output: std::process::Output) {
    assert!(
        output.status.success(),
        "command failed: status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

struct RuntimeHandler;

impl RuntimeWorkHandler for RuntimeHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(
                data,
                json!({
                    "method": "runtime.tasks.list",
                    "payload": {"workspacePath": "/tmp/project"}
                })
            );
            Ok(json!({"success": true, "workspaces": []}))
        })
    }
}

struct ProjectionRuntimeHandler {
    reconciliations: Arc<Mutex<usize>>,
}

impl RuntimeWorkHandler for ProjectionRuntimeHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        _data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async { Ok(json!({})) })
    }

    fn reconcile_bound_task_statuses<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            *self.reconciliations.lock().unwrap() += 1;
        })
    }
}

struct CapacityRuntimeHandler;

impl RuntimeWorkHandler for CapacityRuntimeHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(
                data,
                json!({
                    "method": "runtime.capacity.get",
                    "payload": {}
                })
            );
            Ok(json!({
                "limit": 5,
                "active": 0,
                "active_task_ids": [],
                "queued": 0
            }))
        })
    }
}

struct CodexRuntimeHandler;

impl RuntimeWorkHandler for CodexRuntimeHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        _data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async { Err(AppIpcError::new("unexpected_runtime_rpc", "unexpected")) })
    }

    fn handle_codex_app_server_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(
                data,
                json!({
                    "method": "plugin/installed",
                    "params": {"cwds": null}
                })
            );
            Ok(json!({"marketplaces": []}))
        })
    }
}

struct LocalPluginInstallRuntimeHandler;

impl RuntimeWorkHandler for LocalPluginInstallRuntimeHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(
                data,
                json!({
                    "method": "runtime.codex.plugin.install_local_first",
                    "payload": {
                        "marketplacePath": "/tmp/wework-personal/.agents/plugins/marketplace.json",
                        "pluginName": "example-plugin"
                    }
                })
            );
            Ok(json!({
                "pluginKey": "example-plugin@wework-personal",
                "localCommitted": true
            }))
        })
    }
}

struct LocalPluginUninstallRuntimeHandler;

impl RuntimeWorkHandler for LocalPluginUninstallRuntimeHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(
                data,
                json!({
                    "method": "runtime.codex.plugin.uninstall_local",
                    "payload": {
                        "marketplacePath": "/tmp/wework-personal/.agents/plugins/marketplace.json",
                        "pluginName": "example-plugin"
                    }
                })
            );
            Ok(json!({
                "pluginKey": "example-plugin@wework-personal",
                "localCommitted": true
            }))
        })
    }
}

#[derive(Default)]
struct CaptureCommandHandler {
    seen_request: Arc<Mutex<Option<CommandRequest>>>,
}

impl DeviceCommandHandler for CaptureCommandHandler {
    fn handle_execute_command<'a>(
        &'a self,
        request: CommandRequest,
    ) -> Pin<Box<dyn Future<Output = CommandResult> + Send + 'a>> {
        Box::pin(async move {
            *self.seen_request.lock().unwrap() = Some(request);
            CommandResult::ok(".\n..\nsrc/\nREADME.md\n")
        })
    }
}
