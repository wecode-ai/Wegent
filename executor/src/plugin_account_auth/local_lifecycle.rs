//! Native-only bridge for the existing local login UI. Never a model capability.

use super::{broker::ReconciliationRequest, AuthError, NativeAuthGateway};
#[cfg(test)]
use crate::local::backend::LocalBackendTransport;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};

pub(super) struct Request {
    payload: Value,
    reply: oneshot::Sender<Result<Value, AuthError>>,
}

pub(super) fn start<T: super::PluginAuthTransport>(
    transport: T,
    connected: Arc<AtomicBool>,
    mut cancelled: watch::Receiver<bool>,
    reconcile: mpsc::Sender<ReconciliationRequest>,
) -> (mpsc::Sender<Request>, JoinHandle<()>) {
    let (sender, mut receiver) = mpsc::channel::<Request>(16);
    let task = tokio::spawn(async move {
        loop {
            let mut request = tokio::select! {
                _ = cancelled.changed() => break,
                request = receiver.recv() => match request { Some(value) => value, None => break },
            };
            if request.reply.is_closed() {
                continue;
            }
            let installed_id = request.payload["installed_plugin_id"].as_u64();
            let action = request.payload["action"].as_str();
            let scoped = if let Some(id) = installed_id {
                transport.for_plugin(id, true)
            } else {
                transport.clone()
            };
            // Native login publishes its targeted registration while holding the write reservation.
            let target = installed_id.filter(|_| {
                action == Some("logout") || action == Some("login") && !scoped.uses_native_http()
            });
            let result = if !transport.available(connected.load(Ordering::Acquire)) {
                Err(AuthError("plugin_auth_backend_unavailable"))
            } else {
                let gateway = NativeAuthGateway::new(scoped);
                tokio::select! {
                    biased;
                    _ = cancelled.changed() => break,
                    _ = request.reply.closed() => continue,
                    result = gateway.call(
                        "plugin.auth.local_lifecycle", request.payload
                    ) => result,
                }
            };
            if result.as_ref().is_ok_and(|result| result["status"] == "ok") {
                if let Some(id) = target {
                    let _ = reconcile.try_send(ReconciliationRequest::Target(id));
                }
            }
            let _ = request.reply.send(result);
        }
    });
    (sender, task)
}

/// Return None only for a connector without a managed account adapter.
pub async fn exchange(root: &Path, slug: &str, action: &str) -> Result<Option<Value>, AuthError> {
    let shared_plugins = crate::services::workbench::workbench_root()
        .map_err(|_| AuthError("plugin_auth_invalid_package"))?
        .join("shared/plugins");
    let Some(id) = installed_id_at(
        &crate::local::capabilities::default_manifest_path(),
        &shared_plugins,
        &crate::agents::wework_codex_home().join("plugins"),
        root,
        slug,
        action == "logout",
    )?
    else {
        return Ok(None);
    };
    let sender = super::broker::lifecycle_sender()?;
    let (reply, result) = oneshot::channel();
    sender
        .try_send(Request {
            payload: json!({"installed_plugin_id": id, "connector_slug": slug, "action": action}),
            reply,
        })
        .map_err(|_| AuthError("plugin_auth_broker_unavailable"))?;
    let response = tokio::time::timeout(Duration::from_secs(20), result)
        .await
        .map_err(|_| AuthError("plugin_auth_backend_unavailable"))?
        .map_err(|_| AuthError("plugin_auth_backend_unavailable"))??;
    match response["status"].as_str() {
        Some("ok") => Ok(Some(json!({"status": "ok"}))),
        Some("need_login") => Ok(Some(json!({"status": "need_login"}))),
        None if action == "status" && response["status"].is_null() => Ok(None),
        _ => Err(AuthError("plugin_auth_invalid_response")),
    }
}

fn installed_id_at(
    path: &Path,
    shared_plugins: &Path,
    codex_plugins: &Path,
    root: &Path,
    slug: &str,
    revoking: bool,
) -> Result<Option<u64>, AuthError> {
    installed_id_at_in_scope(
        path,
        shared_plugins,
        codex_plugins,
        root,
        slug,
        revoking,
        super::broker::account_scope().as_ref(),
    )
}

fn installed_id_at_in_scope(
    path: &Path,
    shared_plugins: &Path,
    codex_plugins: &Path,
    root: &Path,
    slug: &str,
    revoking: bool,
    scope: Option<&Value>,
) -> Result<Option<u64>, AuthError> {
    let root = root
        .canonicalize()
        .map_err(|_| AuthError("plugin_auth_invalid_package"))?;
    let plugin: Value = read_json(&root.join(".codex-plugin/plugin.json"))?;
    if !plugin["connectors"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item["slug"] == slug && item["accountAuth"].is_object() && item["localAuth"].is_object()
        })
    }) {
        return Ok(None);
    }
    let capabilities = path
        .parent()
        .ok_or(AuthError("plugin_auth_invalid_package"))?;
    if !path
        .try_exists()
        .map_err(|_| AuthError("plugin_auth_invalid_package"))?
    {
        return Ok(None);
    }
    let manifest = read_json(path)?;
    let entries = manifest["plugins"]
        .as_object()
        .ok_or(AuthError("plugin_auth_invalid_package"))?;
    let mut matched = None;
    for entry in entries.values() {
        // An author source remains local when this account does not own its link.
        if entry["materialization"] == "author_source"
            && super::author_source::require_scope(entry, scope).is_err()
        {
            continue;
        }
        let package_matches =
            crate::local::plugin_catalog::managed_plugin_root(capabilities, shared_plugins, entry)
                .ok()
                .as_ref()
                == Some(&root);
        let runtime_matches =
            !package_matches && registered_runtime(entry, codex_plugins).as_ref() == Some(&root);
        let author_matches = !package_matches
            && author_source_matches(
                path,
                shared_plugins,
                codex_plugins,
                entry,
                &root,
                &plugin,
                slug,
            )?;
        if !package_matches && !runtime_matches && !author_matches {
            continue;
        }
        if author_matches && entry["enabled"] != true {
            continue;
        }
        if entry["managed"] != true {
            return Ok(None);
        }
        if (!revoking && entry["enabled"] != true) || matched.is_some() {
            return Err(AuthError("plugin_auth_invalid_package"));
        }
        matched = Some(
            entry["installed_plugin_id"]
                .as_u64()
                .filter(|id| *id > 0)
                .ok_or(AuthError("plugin_auth_invalid_package"))?,
        );
    }
    if let Some(id) = matched {
        if entries
            .values()
            .filter(|entry| entry["installed_plugin_id"].as_u64() == Some(id))
            .count()
            != 1
        {
            return Err(AuthError("plugin_auth_invalid_package"));
        }
    }
    Ok(matched)
}

fn author_source_matches(
    manifest: &Path,
    shared_plugins: &Path,
    codex_plugins: &Path,
    entry: &Value,
    root: &Path,
    plugin: &Value,
    slug: &str,
) -> Result<bool, AuthError> {
    if entry["materialization"] != "author_source"
        || !entry["name"]
            .as_str()
            .zip(plugin["name"].as_str())
            .is_some_and(|(slug, name)| {
                crate::local::capabilities::personal_manifest_name_matches_slug(name, slug)
            })
    {
        return Ok(false);
    }
    let codex_home = codex_plugins
        .parent()
        .ok_or(AuthError("plugin_auth_invalid_package"))?;
    let Some(source) =
        crate::local::capabilities::read_personal_author_source(manifest, codex_home, entry)
            .map_err(|_| AuthError("plugin_auth_invalid_package"))?
    else {
        return Ok(false);
    };
    let owns_root = ["source_path", "runtime_path"].into_iter().any(|field| {
        source[field]
            .as_str()
            .and_then(|path| Path::new(path).canonicalize().ok())
            .as_deref()
            == Some(root)
    });
    if source["installed"] != true || !owns_root {
        return Ok(false);
    }
    // A disabled account link cannot publish credentials; ownership still permits local auth.
    if entry["enabled"] != true {
        return Ok(true);
    }
    let capabilities = manifest
        .parent()
        .ok_or(AuthError("plugin_auth_invalid_package"))?;
    let trusted =
        crate::local::plugin_catalog::managed_plugin_root(capabilities, shared_plugins, entry)
            .map_err(|_| AuthError("plugin_auth_package_sync_required"))?;
    if super::author_source::definition(root, slug)?
        != super::author_source::definition(&trusted, slug)?
    {
        return Err(AuthError("plugin_auth_definition_mismatch"));
    }
    Ok(true)
}

fn registered_runtime(entry: &Value, codex_plugins: &Path) -> Option<std::path::PathBuf> {
    if codex_plugins.file_name()? != "plugins" {
        return None;
    }
    crate::local::plugin_catalog::registered_codex_cache(
        codex_plugins.parent()?,
        entry["marketplace"].as_str()?,
        entry["name"].as_str()?,
        entry,
    )
}

fn read_json(path: &Path) -> Result<Value, AuthError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| AuthError("plugin_auth_invalid_package"))?;
    if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 {
        return Err(AuthError("plugin_auth_invalid_package"));
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| AuthError("plugin_auth_invalid_package"))?)
        .map_err(|_| AuthError("plugin_auth_invalid_package"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::backend::{EventHandler, LocalBackendConfig};
    use std::{future::Future, path::PathBuf, pin::Pin, sync::Mutex};

    type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

    fn relocated_fixture(home: &Path) -> (PathBuf, PathBuf, PathBuf, Value) {
        let capabilities = home.join("current/workbench/wework/test/capabilities");
        let shared = home.join("current/workbench/shared/plugins");
        let root = shared.join("a".repeat(64));
        let legacy = home.join("removed-home/capabilities/store/plugins/mail");
        for path in [&root, &legacy] {
            fs::create_dir_all(path.join(".codex-plugin")).unwrap();
            fs::write(
                path.join(".codex-plugin/plugin.json"),
                json!({"connectors":[
                    {"slug":"mail","accountAuth":{},"localAuth":{}}
                ]})
                .to_string(),
            )
            .unwrap();
        }
        fs::remove_dir_all(home.join("removed-home")).unwrap();
        fs::create_dir_all(&capabilities).unwrap();
        let manifest_path = capabilities.join("manifest-v2.json");
        let entry = json!({
            "name": "mail", "marketplace": "wegent", "version": "1.0",
            "store_path": legacy,
            "checksum": format!("sha256:{}", "a".repeat(64)),
            "installed_plugin_id": 42, "managed": true, "enabled": true
        });
        fs::write(
            &manifest_path,
            json!({"plugins":{"mail":entry}}).to_string(),
        )
        .unwrap();
        (manifest_path, shared, root, entry)
    }

    #[test]
    fn lifecycle_keeps_account_identity_when_the_recorded_home_is_removed() {
        let temp = tempfile::tempdir().unwrap();
        let codex_plugins = temp.path().join("agent/plugins");
        let (manifest, shared, root, mut entry) = relocated_fixture(temp.path());

        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &root, "mail", false),
            Ok(Some(42))
        );
        entry["enabled"] = json!(false);
        fs::write(&manifest, json!({"plugins":{"mail":entry}}).to_string()).unwrap();

        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &root, "mail", false),
            Err(AuthError("plugin_auth_invalid_package"))
        );
        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &root, "mail", true),
            Ok(Some(42))
        );
    }

    #[test]
    fn author_lifecycle_requires_owned_source_and_current_cloud_auth_definition() {
        let temp = tempfile::tempdir().unwrap();
        let scope = json!({"backendUrl":"https://backend.example","userId":7});
        let installed_id_at =
            |path: &Path, shared: &Path, codex: &Path, root: &Path, slug: &str, revoking: bool| {
                installed_id_at_in_scope(path, shared, codex, root, slug, revoking, Some(&scope))
            };
        let codex_home = temp.path().join("agent");
        let codex_plugins = codex_home.join("plugins");
        let (manifest, shared, trusted, mut entry) = relocated_fixture(temp.path());
        let marketplace = manifest
            .parent()
            .unwrap()
            .join("bundled-marketplaces/wework-personal");
        let source = marketplace.join("plugins/mail");
        let runtime = codex_plugins.join("cache/wework-personal/mail/0.1.10");
        let declaration = json!({"name":"mail","version":"0.1.10","connectors":[{
            "slug":"mail","accountAuth":{"adapter":"auth.mjs"},"localAuth":{}
        }]});
        for root in [&source, &runtime, &trusted] {
            fs::create_dir_all(root.join(".codex-plugin")).unwrap();
            fs::write(
                root.join(".codex-plugin/plugin.json"),
                declaration.to_string(),
            )
            .unwrap();
        }
        fs::write(
            codex_home.join("config.toml"),
            "[plugins.\"mail@wework-personal\"]\nenabled=true\n",
        )
        .unwrap();
        crate::local::plugin_import::link_plugin_release(
            crate::local::plugin_import::LinkPluginReleaseRequest {
                marketplace_path: marketplace.to_string_lossy().into_owned(),
                local_plugin_name: "mail".into(),
                cloud_plugin_id: 7,
                cloud_release_id: Some(2),
                account_install: None,
                account_scope: Some(
                    crate::local::plugin_import::PluginAccountScope::new(
                        "https://backend.example",
                        7,
                    )
                    .unwrap(),
                ),
            },
        )
        .unwrap();
        entry["name"] = json!("mail");
        entry["marketplace"] = json!("wework-personal");
        entry["version"] = json!("0.1.10");
        entry["cloud_plugin_id"] = json!(7);
        entry["materialization"] = json!("author_source");
        entry["account_scope"] = scope.clone();
        entry["personal_source_owner"] = json!(true);
        let write_entry = |value: &Value| {
            fs::write(&manifest, json!({"plugins":{"mail":value}}).to_string()).unwrap()
        };
        write_entry(&entry);
        for root in [&source, &runtime] {
            assert_eq!(
                installed_id_at(&manifest, &shared, &codex_plugins, root, "mail", false),
                Ok(Some(42))
            );
        }
        entry["enabled"] = json!(false);
        write_entry(&entry);
        for root in [&source, &runtime] {
            for revoking in [false, true] {
                assert_eq!(
                    installed_id_at(&manifest, &shared, &codex_plugins, root, "mail", revoking),
                    Ok(None)
                );
            }
        }
        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &trusted, "mail", false),
            Err(AuthError("plugin_auth_invalid_package"))
        );
        entry["enabled"] = json!(true);
        write_entry(&entry);
        let package = super::super::PreparedPackage {
            installed_plugin_id: 42,
            connector_slug: "mail".into(),
            checksum: entry["checksum"].as_str().unwrap().to_owned(),
            auth_definition: declaration["connectors"][0]["accountAuth"].clone(),
        };
        assert_eq!(
            super::super::author_source::validate_current(
                &manifest,
                &codex_home,
                &entry,
                &package,
                Some(&scope)
            ),
            Ok(())
        );
        assert_eq!(
            installed_id_at_in_scope(
                &manifest,
                &shared,
                &codex_plugins,
                &source,
                "mail",
                false,
                None
            ),
            Ok(None)
        );
        assert_eq!(
            super::super::author_source::validate_current(
                &manifest,
                &codex_home,
                &entry,
                &package,
                None
            ),
            Err(AuthError("plugin_auth_package_sync_required"))
        );
        for other_scope in [
            json!({"backendUrl":"https://other.example","userId":7}),
            json!({"backendUrl":"https://backend.example","userId":8}),
        ] {
            assert_eq!(
                installed_id_at_in_scope(
                    &manifest,
                    &shared,
                    &codex_plugins,
                    &runtime,
                    "mail",
                    false,
                    Some(&other_scope)
                ),
                Ok(None)
            );
            assert_eq!(
                super::super::author_source::validate_current(
                    &manifest,
                    &codex_home,
                    &entry,
                    &package,
                    Some(&other_scope)
                ),
                Err(AuthError("plugin_auth_account_mismatch"))
            );
        }
        entry["personal_source_owner"] = json!(false);
        write_entry(&entry);
        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &source, "mail", false),
            Ok(None)
        );
        entry["personal_source_owner"] = json!(true);
        write_entry(&entry);
        let mut modified = declaration;
        modified["connectors"][0]["accountAuth"]["adapter"] = json!("other.mjs");
        fs::write(
            source.join(".codex-plugin/plugin.json"),
            modified.to_string(),
        )
        .unwrap();
        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &source, "mail", false),
            Err(AuthError("plugin_auth_definition_mismatch"))
        );
        fs::write(
            runtime.join(".codex-plugin/plugin.json"),
            modified.to_string(),
        )
        .unwrap();
        assert_eq!(
            super::super::author_source::validate_current(
                &manifest,
                &codex_home,
                &entry,
                &package,
                Some(&scope)
            ),
            Err(AuthError("plugin_auth_definition_mismatch"))
        );
        entry["enabled"] = json!(false);
        write_entry(&entry);
        for root in [&source, &runtime] {
            for revoking in [false, true] {
                assert_eq!(
                    installed_id_at(&manifest, &shared, &codex_plugins, root, "mail", revoking),
                    Ok(None)
                );
            }
        }
        entry["enabled"] = json!(true);
        write_entry(&entry);
        for root in [&source, &runtime] {
            assert_eq!(
                installed_id_at(&manifest, &shared, &codex_plugins, root, "mail", false),
                Err(AuthError("plugin_auth_definition_mismatch"))
            );
        }
        entry["cloud_plugin_id"] = json!(8);
        write_entry(&entry);
        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &source, "mail", false),
            Ok(None)
        );
    }

    #[test]
    fn lifecycle_rejects_a_duplicated_installation_id_after_home_relocation() {
        let temp = tempfile::tempdir().unwrap();
        let codex_plugins = temp.path().join("agent/plugins");
        let (manifest, shared, root, entry) = relocated_fixture(temp.path());
        let mut duplicate = entry.clone();
        duplicate["checksum"] = json!(format!("sha256:{}", "b".repeat(64)));
        fs::write(
            &manifest,
            json!({"plugins":{"mail":entry,"different-package":duplicate}}).to_string(),
        )
        .unwrap();

        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &root, "mail", false),
            Err(AuthError("plugin_auth_invalid_package"))
        );
    }

    #[test]
    fn lifecycle_rejects_historical_native_runtime_until_current_runtime_is_registered() {
        let temp = tempfile::tempdir().unwrap();
        let codex_plugins = temp.path().join("agent/plugins");
        let (manifest, shared, root, mut entry) = relocated_fixture(temp.path());
        let native = temp
            .path()
            .join("native/.codex/plugins/cache/wegent/mail/1.0");
        let current = codex_plugins.join("cache/wegent/mail/1.0");
        for runtime in [&native, &current] {
            fs::create_dir_all(runtime.join(".codex-plugin")).unwrap();
            fs::copy(
                root.join(".codex-plugin/plugin.json"),
                runtime.join(".codex-plugin/plugin.json"),
            )
            .unwrap();
        }
        entry["runtime"] = json!({"codex_link":native});
        fs::write(&manifest, json!({"plugins":{"mail":entry}}).to_string()).unwrap();

        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &native, "mail", false),
            Ok(None)
        );
        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &current, "mail", false),
            Ok(None)
        );
        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &root, "mail", false),
            Ok(Some(42))
        );

        entry["runtime"]["codex_link"] = json!(current);
        fs::write(&manifest, json!({"plugins":{"mail":entry}}).to_string()).unwrap();

        assert_eq!(
            installed_id_at(&manifest, &shared, &codex_plugins, &current, "mail", false),
            Ok(Some(42))
        );
        assert!(native.join(".codex-plugin/plugin.json").is_file());
    }

    #[test]
    fn lifecycle_does_not_infer_the_shared_store_from_an_unrelated_requested_root() {
        let temp = tempfile::tempdir().unwrap();
        let codex_plugins = temp.path().join("agent/plugins");
        let (manifest, shared, _, mut entry) = relocated_fixture(temp.path());
        let unrelated = temp.path().join("unrelated/plugins").join("a".repeat(64));
        fs::create_dir_all(unrelated.join(".codex-plugin")).unwrap();
        fs::write(
            unrelated.join(".codex-plugin/plugin.json"),
            json!({"connectors":[
                {"slug":"mail","accountAuth":{},"localAuth":{}}
            ]})
            .to_string(),
        )
        .unwrap();
        entry["store_path"] = json!(unrelated);
        fs::write(&manifest, json!({"plugins":{"mail":entry}}).to_string()).unwrap();

        assert_eq!(
            installed_id_at(
                &manifest,
                &shared,
                &codex_plugins,
                &unrelated,
                "mail",
                false
            ),
            Ok(None)
        );
    }

    #[test]
    fn lifecycle_resolves_relocated_shared_package_and_runtime_copy_by_exact_installation() {
        let temp = tempfile::tempdir().unwrap();
        let codex_plugins = temp.path().join("agent/plugins");
        let capabilities = temp.path().join("workbench/wework/test/capabilities");
        let shared = temp.path().join("workbench/shared/plugins");
        let root = shared.join("a".repeat(64));
        let runtime = codex_plugins.join("cache/wegent/mail/1.0");
        for path in [&root, &runtime] {
            fs::create_dir_all(path.join(".codex-plugin")).unwrap();
            fs::write(
                path.join(".codex-plugin/plugin.json"),
                json!({"connectors":[
                    {"slug":"mail","accountAuth":{},"localAuth":{}}
                ]})
                .to_string(),
            )
            .unwrap();
        }
        fs::create_dir_all(&capabilities).unwrap();
        let manifest_path = capabilities.join("manifest.json");
        let entry = json!({"store_path":root,"runtime":{"codex_link":runtime},
            "checksum":format!("sha256:{}", "a".repeat(64)),
            "name":"mail","marketplace":"wegent","version":"1.0",
            "installed_plugin_id":42,"managed":true,"enabled":true});
        fs::write(
            &manifest_path,
            json!({"plugins":{"mail":entry}}).to_string(),
        )
        .unwrap();
        assert_eq!(
            installed_id_at(
                &manifest_path,
                &shared,
                &codex_plugins,
                &root,
                "mail",
                false
            ),
            Ok(Some(42))
        );
        assert_eq!(
            installed_id_at(
                &manifest_path,
                &shared,
                &codex_plugins,
                &runtime,
                "mail",
                false
            ),
            Ok(Some(42))
        );
        fs::write(
            &manifest_path,
            json!({"plugins":{"mail":entry,"duplicate":entry}}).to_string(),
        )
        .unwrap();
        assert_eq!(
            installed_id_at(
                &manifest_path,
                &shared,
                &codex_plugins,
                &root,
                "mail",
                false
            ),
            Err(AuthError("plugin_auth_invalid_package"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn lifecycle_rejects_symlinked_capabilities_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let codex_plugins = temp.path().join("agent/plugins");
        let root = temp.path().join("plugin");
        fs::create_dir_all(root.join(".codex-plugin")).unwrap();
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            json!({"connectors":[
                {"slug":"mail","accountAuth":{},"localAuth":{}}
            ]})
            .to_string(),
        )
        .unwrap();
        let actual = temp.path().join("actual.json");
        fs::write(&actual, json!({"plugins":{}}).to_string()).unwrap();
        let manifest = temp.path().join("manifest.json");
        std::os::unix::fs::symlink(actual, &manifest).unwrap();
        assert_eq!(
            installed_id_at(
                &manifest,
                &temp.path().join("shared/plugins"),
                &codex_plugins,
                &root,
                "mail",
                false
            ),
            Err(AuthError("plugin_auth_invalid_package"))
        );
    }

    #[derive(Clone, Default)]
    struct Transport(Arc<Mutex<Vec<Value>>>);

    impl LocalBackendTransport for Transport {
        fn connect<'a>(&'a self, _: &'a LocalBackendConfig) -> TransportFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
        fn disconnect<'a>(&'a self) -> TransportFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
        fn call<'a>(
            &'a self,
            event: &'a str,
            payload: Value,
            _: Duration,
        ) -> TransportFuture<'a, Value> {
            assert_eq!(event, "plugin.auth.local_lifecycle");
            self.0.lock().unwrap().push(payload);
            Box::pin(async { Ok(json!({"success":true,"status":"ok"})) })
        }
        fn emit<'a>(&'a self, _: &'a str, _: Value) -> TransportFuture<'a, ()> {
            panic!("local lifecycle must use authenticated request/reply")
        }
        fn on(&self, _: &str, _: EventHandler) {
            panic!("no subscription")
        }

        fn on_close(&self, _: crate::local::backend::ConnectionClosedHandler) {
            panic!("no subscription")
        }
    }

    #[tokio::test]
    async fn lifecycle_is_native_only_and_stops_when_the_backend_disconnects() {
        let transport = Transport::default();
        let connected = Arc::new(AtomicBool::new(true));
        let (cancel, receiver) = watch::channel(false);
        let (sender, task) = start(
            transport.clone(),
            connected.clone(),
            receiver,
            mpsc::channel(16).0,
        );
        let payload = json!({"installed_plugin_id":42,"connector_slug":"mail","action":"logout"});
        let (reply, response) = oneshot::channel();
        sender
            .send(Request {
                payload: payload.clone(),
                reply,
            })
            .await
            .unwrap();
        assert_eq!(response.await.unwrap().unwrap()["status"], "ok");
        connected.store(false, Ordering::Release);
        let (reply, response) = oneshot::channel();
        sender
            .send(Request {
                payload: payload.clone(),
                reply,
            })
            .await
            .unwrap();
        assert_eq!(
            response.await.unwrap(),
            Err(AuthError("plugin_auth_backend_unavailable"))
        );
        assert_eq!(*transport.0.lock().unwrap(), vec![payload]);
        cancel.send_replace(true);
        task.await.unwrap();
    }

    #[test]
    fn managed_target_requires_exact_installation_and_only_revokes_disabled_packages() {
        let home = tempfile::tempdir().unwrap();
        let codex_plugins = home.path().join("agent/plugins");
        let capabilities = home.path().join("capabilities");
        let shared = home.path().join("shared/plugins");
        let root = capabilities.join("store/plugins/mail");
        fs::create_dir_all(root.join(".codex-plugin")).unwrap();
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            json!({"connectors":[
                {"slug":"mail","accountAuth":{},"localAuth":{}},
                {"slug":"legacy","localAuth":{}}
            ]})
            .to_string(),
        )
        .unwrap();
        let manifest = |enabled| {
            json!({"plugins":{"mail":{
            "store_path":"store/plugins/mail","installed_plugin_id":42,"managed":true,"enabled":enabled
        }}}).to_string()
        };
        fs::write(capabilities.join("manifest.json"), manifest(true)).unwrap();
        assert_eq!(
            installed_id_at(
                &capabilities.join("manifest.json"),
                &shared,
                &codex_plugins,
                &root,
                "mail",
                false
            ),
            Ok(Some(42))
        );
        assert_eq!(
            installed_id_at(
                &capabilities.join("manifest.json"),
                &shared,
                &codex_plugins,
                &root,
                "legacy",
                false
            ),
            Ok(None)
        );
        fs::write(capabilities.join("manifest.json"), manifest(false)).unwrap();
        assert_eq!(
            installed_id_at(
                &capabilities.join("manifest.json"),
                &shared,
                &codex_plugins,
                &root,
                "mail",
                false
            ),
            Err(AuthError("plugin_auth_invalid_package"))
        );
        assert_eq!(
            installed_id_at(
                &capabilities.join("manifest.json"),
                &shared,
                &codex_plugins,
                &root,
                "mail",
                true
            ),
            Ok(Some(42))
        );
    }
}
