// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn native_marketplace_writes_preserve_committed_python_demand() {
    with_marketplace_fixture(|handler, native| {
        Box::pin(async move {
            for method in [
                "marketplace/add",
                "marketplace/remove",
                "marketplace/upgrade",
            ] {
                let mutation = handler.handle_codex_app_server_rpc(json!({
                    "method": method, "params": {}
                }));
                let (result, ()) =
                    tokio::join!(mutation, assert_demand_during_rewrite(handler, native));
                result.unwrap();
                reset_rewrite(native);
            }
        })
    });
}

#[test]
fn bundled_marketplace_registration_preserves_committed_python_demand() {
    with_marketplace_fixture(|handler, native| {
        Box::pin(async move {
            let registration = handler.reconcile_bundled_plugin_marketplace(json!({
                "marketplaceId": "wework-personal", "source": native.join("marketplace")
            }));
            let (result, ()) =
                tokio::join!(registration, assert_demand_during_rewrite(handler, native));
            assert_eq!(result.unwrap()["action"], "added");
        })
    });
}

#[test]
fn failed_marketplace_registration_releases_python_demand_readers() {
    with_marketplace_fixture(|handler, native| {
        Box::pin(async move {
            fs::write(
                native.join("marketplace_add.error-once.json"),
                r#"{"code":-32000,"message":"registration rejected"}"#,
            )
            .unwrap();
            let registration = handler.reconcile_bundled_plugin_marketplace(json!({
                "marketplaceId": "wework-personal", "source": native.join("marketplace")
            }));
            let (result, ()) =
                tokio::join!(registration, assert_demand_during_rewrite(handler, native));
            assert!(result
                .unwrap_err()
                .message
                .contains("registration rejected"));
        })
    });
}

#[test]
fn local_plugin_publication_waits_for_inventory_readers() {
    with_marketplace_fixture(|handler, native| {
        Box::pin(async move {
            let marketplace = native.join("marketplace");
            let source = marketplace.join("plugins/example");
            fs::create_dir_all(marketplace.join(".agents/plugins")).unwrap();
            fs::create_dir_all(source.join(".codex-plugin")).unwrap();
            fs::write(
                source.join(".codex-plugin/plugin.json"),
                r#"{"name":"example","version":"1.0"}"#,
            )
            .unwrap();
            let manifest = marketplace.join(".agents/plugins/marketplace.json");
            fs::write(&manifest, r#"{"name":"wework-personal","plugins":[{"name":"example","source":{"source":"local","path":"./plugins/example"},"policy":{"installation":"INSTALLED_BY_DEFAULT"}}]}"#).unwrap();
            let payload = json!({"marketplacePath": manifest, "pluginName": "example"});
            assert_publication_waits(handler.install_local_plugin(payload.clone())).await;
            fs::write(source.join("changed.txt"), "updated").unwrap();
            assert_publication_waits(handler.sync_bundled_plugin(payload)).await;
            let cache = native.join("native-home/plugins/cache/wework-personal/example");
            assert_eq!(
                fs::read_to_string(cache.join("1.0/changed.txt")).unwrap(),
                "updated"
            );
            assert_publication_waits(
                handler.uninstall_local_plugin(json!({"pluginName":"example"})),
            )
            .await;
            assert!(!cache.exists());
        })
    });
}

async fn assert_publication_waits(publication: impl Future<Output = Result<Value, AppIpcError>>) {
    let reader = crate::services::capability_activation::begin_execution().await;
    tokio::pin!(publication);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut publication)
            .await
            .is_err(),
        "Plugin publication overlapped an inventory reader"
    );
    drop(reader);
    tokio::time::timeout(Duration::from_secs(5), publication)
        .await
        .unwrap()
        .unwrap();
}

fn with_marketplace_fixture(
    test: impl for<'a> FnOnce(
        &'a RuntimeWorkRpcHandler,
        &'a Path,
    ) -> Pin<Box<dyn Future<Output = ()> + 'a>>,
) {
    let _environment = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let native = root.path().join("native");
    let home = native.join("native-home");
    let _executor = ScalarEnv::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    let _codex = ScalarEnv::set("WEGENT_CODEX_HOME", home.to_str().unwrap());
    let _workbench = ScalarEnv::set("WEGENT_WORKBENCH_HOME", root.path().to_str().unwrap());
    let capabilities = root.path().join("capabilities");
    let _capabilities = ScalarEnv::set("WEGENT_CAPABILITIES_HOME", capabilities.to_str().unwrap());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut handler = RuntimeWorkRpcHandler::new("python-demand", "unused-codex-binary");
            install_native_history(&mut handler, &native, vec![], None);
            prepare_marketplace_responses(&native);
            handler.codex_app_server.ensure_started().await.unwrap();
            install_python_fixture(&home);
            assert_eq!(python_demand(&handler).await, json!({"demanded": true}));
            fs::write(native.join("hold-config-rewrite"), "").unwrap();
            test(&handler, &native).await;
            handler
                .codex_app_server
                .request("test/stop", json!({}))
                .await
                .unwrap();
        });
}

fn prepare_marketplace_responses(native: &Path) {
    fs::write(native.join("plugin_list.json"), r#"{"marketplaces":[]}"#).unwrap();
    fs::write(native.join("config_batchWrite.json"), "{}").unwrap();
    for method in [
        "marketplace_add",
        "marketplace_remove",
        "marketplace_upgrade",
    ] {
        fs::write(
            native.join(format!("{method}.json")),
            r#"{"marketplaceName":"wework-personal"}"#,
        )
        .unwrap();
    }
}

fn install_python_fixture(home: &Path) {
    let package = home.join("plugins/cache/wework-personal/python/1.0");
    fs::create_dir_all(package.join(".codex-plugin")).unwrap();
    fs::write(
        package.join(".codex-plugin/plugin.json"),
        r#"{"name":"python","runtimeRequirements":{"python":{}}}"#,
    )
    .unwrap();
    fs::write(
        home.join("config.toml"),
        "[plugins.'python@wework-personal']\nenabled = true\n",
    )
    .unwrap();
}

async fn python_demand(handler: &RuntimeWorkRpcHandler) -> Value {
    handler
        .handle_runtime_rpc(json!({"method":"runtime.python.has_demand", "payload":{}}))
        .await
        .unwrap()
}

async fn assert_demand_during_rewrite(handler: &RuntimeWorkRpcHandler, native: &Path) {
    struct ReleaseRewrite(PathBuf);
    impl Drop for ReleaseRewrite {
        fn drop(&mut self) {
            let _ = fs::write(&self.0, "");
        }
    }
    let release = ReleaseRewrite(native.join("config-rewrite-release"));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !native.join("config-rewrite-started").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("The native marketplace writer did not start");
    assert_eq!(
        fs::read_to_string(native.join("native-home/config.toml")).unwrap(),
        ""
    );
    let demand = python_demand(handler);
    tokio::pin!(demand);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut demand)
            .await
            .is_err(),
        "Python demand observed the native writer's truncated configuration"
    );
    drop(release);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), demand)
            .await
            .unwrap(),
        json!({"demanded": true})
    );
}

fn reset_rewrite(native: &Path) {
    fs::remove_file(native.join("config-rewrite-started")).unwrap();
    fs::remove_file(native.join("config-rewrite-release")).unwrap();
}
