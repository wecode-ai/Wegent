//! Native-only bridge for the existing local login UI. Never a model capability.

use super::{AuthError, NativeAuthGateway};
use crate::local::backend::LocalBackendTransport;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
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

pub(super) fn start<T: LocalBackendTransport>(
    transport: T,
    connected: Arc<AtomicBool>,
    mut cancelled: watch::Receiver<bool>,
) -> (mpsc::Sender<Request>, JoinHandle<()>) {
    let (sender, mut receiver) = mpsc::channel::<Request>(16);
    let task = tokio::spawn(async move {
        loop {
            let request = tokio::select! {
                _ = cancelled.changed() => break,
                request = receiver.recv() => match request { Some(value) => value, None => break },
            };
            if request.reply.is_closed() {
                continue;
            }
            let result = if !connected.load(Ordering::Acquire) {
                Err(AuthError("plugin_auth_backend_unavailable"))
            } else {
                let gateway = NativeAuthGateway::new(transport.clone());
                tokio::select! {
                    _ = cancelled.changed() => break,
                    result = gateway.call(
                        "plugin.auth.local_lifecycle", request.payload
                    ) => result,
                }
            };
            let _ = request.reply.send(result);
        }
    });
    (sender, task)
}

/// Return None only for a connector without a managed account adapter.
pub async fn exchange(root: &Path, slug: &str, action: &str) -> Result<Option<Value>, AuthError> {
    let home = std::env::var_os("WEGENT_EXECUTOR_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .ok_or(AuthError("plugin_auth_broker_unavailable"))?;
    let Some(id) = installed_id(&home, root, slug)? else {
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

fn installed_id(home: &Path, root: &Path, slug: &str) -> Result<Option<u64>, AuthError> {
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
    let capabilities = home.join("capabilities");
    let path = capabilities.join("manifest.json");
    if !path
        .try_exists()
        .map_err(|_| AuthError("plugin_auth_invalid_package"))?
    {
        return Ok(None);
    }
    let manifest = read_json(&path)?;
    let entries = manifest["plugins"]
        .as_object()
        .ok_or(AuthError("plugin_auth_invalid_package"))?;
    let mut matched = None;
    for entry in entries.values() {
        let paths = [
            entry["store_path"].as_str(),
            entry["runtime"]["codex_link"].as_str(),
        ];
        if !paths
            .into_iter()
            .flatten()
            .any(|path| capabilities.join(path).canonicalize().ok().as_ref() == Some(&root))
        {
            continue;
        }
        if entry["managed"] != true {
            return Ok(None);
        }
        if entry["enabled"] != true || matched.is_some() {
            return Err(AuthError("plugin_auth_invalid_package"));
        }
        matched = Some(
            entry["installed_plugin_id"]
                .as_u64()
                .filter(|id| *id > 0)
                .ok_or(AuthError("plugin_auth_invalid_package"))?,
        );
    }
    Ok(matched)
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
    use std::{future::Future, pin::Pin, sync::Mutex};

    type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

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
    }

    #[tokio::test]
    async fn lifecycle_is_native_only_and_stops_when_the_backend_disconnects() {
        let transport = Transport::default();
        let connected = Arc::new(AtomicBool::new(true));
        let (cancel, receiver) = watch::channel(false);
        let (sender, task) = start(transport.clone(), connected.clone(), receiver);
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
    fn managed_target_requires_an_exact_enabled_installation_and_connector() {
        let home = tempfile::tempdir().unwrap();
        let capabilities = home.path().join("capabilities");
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
        assert_eq!(installed_id(home.path(), &root, "mail"), Ok(Some(42)));
        assert_eq!(installed_id(home.path(), &root, "legacy"), Ok(None));
        fs::write(capabilities.join("manifest.json"), manifest(false)).unwrap();
        assert_eq!(
            installed_id(home.path(), &root, "mail"),
            Err(AuthError("plugin_auth_invalid_package"))
        );
    }
}
