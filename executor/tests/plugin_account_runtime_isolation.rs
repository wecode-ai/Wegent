// SPDX-License-Identifier: Apache-2.0
//! Exercise real reconciliation and revocation entry points with mixed runtimes.

use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs,
    future::Future,
    path::Path,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::watch};
use wegent_executor::{
    local::backend::{
        ConnectionClosedHandler, EventHandler, LocalBackendConfig, LocalBackendTransport,
    },
    plugin_account_auth::{broker, revoke_pending},
};

type Reply<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

struct Environment(Vec<(&'static str, Option<OsString>)>);

impl Environment {
    fn set(values: &[(&'static str, &str)]) -> Self {
        Self(
            values
                .iter()
                .map(|(name, value)| {
                    let previous = std::env::var_os(name);
                    std::env::set_var(name, value);
                    (*name, previous)
                })
                .collect(),
        )
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        for (name, previous) in self.0.drain(..).rev() {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

#[derive(Clone)]
struct Transport {
    packages: Arc<Vec<Value>>,
    actions: Arc<Mutex<Vec<(String, String)>>>,
}

impl LocalBackendTransport for Transport {
    fn connect<'a>(&'a self, _: &'a LocalBackendConfig) -> Reply<'a, ()> {
        panic!("use the existing registered transport")
    }
    fn disconnect<'a>(&'a self) -> Reply<'a, ()> {
        panic!("workers do not own the registered transport")
    }
    fn call<'a>(&'a self, event: &'a str, payload: Value, _: Duration) -> Reply<'a, Value> {
        let response = match event {
            "plugin.auth.automatic" if payload["prepare_only"] == true => {
                assert_eq!(payload["installed_plugin_ids"], json!([42]));
                json!({"success":true,"packages":*self.packages})
            }
            "plugin.auth.automatic" => {
                assert_eq!(payload["installed_plugin_ids"], json!([42]));
                let targets = payload["targets"].as_array().unwrap();
                assert_eq!(targets.len(), 1);
                assert_eq!(targets[0]["installed_plugin_id"], 42);
                let slug = targets[0]["connector_slug"].as_str().unwrap().to_owned();
                self.actions.lock().unwrap().push((event.into(), slug));
                json!({"success":true,"migrations":[]})
            }
            "plugin.auth.oauth.revocations" => {
                let after = payload["after_id"].as_u64().unwrap() as usize;
                let page: Vec<_> = self
                    .packages
                    .iter()
                    .enumerate()
                    .skip(after)
                    .take(10)
                    .map(|(index, package)| {
                        json!({
                            "connection_id":format!("{index:064x}"),"package":package
                        })
                    })
                    .collect();
                let cursor = (page.len() == 10).then_some(after + page.len());
                json!({"success":true,"revocations":page,"next_cursor":cursor})
            }
            "plugin.auth.oauth.revoke_begin" => {
                let id = payload["connection_id"].as_str().unwrap();
                let index = usize::from_str_radix(id, 16).unwrap();
                let slug = self.packages[index]["connector_slug"].as_str().unwrap();
                self.actions
                    .lock()
                    .unwrap()
                    .push((event.into(), slug.into()));
                json!({"success":true,"state":"unavailable"})
            }
            _ => panic!("unexpected operation: {event}"),
        };
        Box::pin(async move { Ok(response) })
    }
    fn emit<'a>(&'a self, _: &'a str, _: Value) -> Reply<'a, ()> {
        panic!("workers use authenticated request/reply")
    }
    fn on(&self, _: &str, _: EventHandler) {}
    fn on_close(&self, _: ConnectionClosedHandler) {}
}

fn mixed_package(home: &Path) -> Vec<Value> {
    let checksum = format!("sha256:{}", "a".repeat(64));
    let root = home.join("workbench/shared/plugins").join("a".repeat(64));
    fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    fs::create_dir_all(home.join("capabilities")).unwrap();
    // More waiting Python connectors than provider slots exposes accidental starvation.
    let packages: Vec<_> = (0..11)
        .map(|index| {
            let (slug, extension) = if index < 10 {
                (format!("python-{index}"), "py")
            } else {
                ("native".to_owned(), "mjs")
            };
            let script = format!("auth-{index}.{extension}");
            fs::write(
                root.join(&script),
                "// not executed by this preparation test",
            )
            .unwrap();
            json!({"installed_plugin_id":42,"connector_slug":slug,"checksum":checksum,
                "auth_definition":{"protocolVersion":1,"credentialType":"oauth2",
                "adapter":script,"oauth2":["authorize","refresh","revoke"]}})
        })
        .collect();
    fs::write(
        root.join(".codex-plugin/plugin.json"),
        json!({"connectors":packages.iter().map(|package| json!({
            "slug":package["connector_slug"],"accountAuth":package["auth_definition"]
        })).collect::<Vec<_>>()})
        .to_string(),
    )
    .unwrap();
    fs::write(
        home.join("capabilities/manifest-v2.json"),
        json!({"plugins":{"mixed@wework":{"installed_plugin_id":42,
            "managed":true,"enabled":true,"checksum":checksum,"store_path":root}}})
        .to_string(),
    )
    .unwrap();
    packages
}

#[derive(Clone)]
struct Bridge {
    release: watch::Receiver<bool>,
    ready: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
}

async fn ensure(State(mut bridge): State<Bridge>, headers: HeaderMap) -> Json<Value> {
    assert_eq!(headers["authorization"], "Bearer synthetic-runtime-token");
    bridge.requests.fetch_add(1, Ordering::SeqCst);
    loop {
        let released = *bridge.release.borrow_and_update();
        if released {
            break;
        }
        bridge.release.changed().await.unwrap();
    }
    Json(if bridge.ready.load(Ordering::SeqCst) {
        json!({"ok":true,"data":{"id":"python","state":"installed"}})
    } else {
        json!({"ok":false,"error":"synthetic mirror unavailable"})
    })
}

async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("independent native work must finish while Python is still waiting");
}

#[tokio::test]
async fn mixed_connectors_prepare_independently_before_intents_and_revocation_leases() {
    let home = tempfile::tempdir().unwrap();
    let packages = Arc::new(mixed_package(home.path()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/runtime/python/ensure",
        listener.local_addr().unwrap()
    );
    let (release, released) = watch::channel(false);
    let bridge = Bridge {
        release: released,
        ready: Arc::new(AtomicBool::new(false)),
        requests: Arc::new(AtomicUsize::new(0)),
    };
    let router = Router::new()
        .route("/runtime/python/ensure", post(ensure))
        .with_state(bridge.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let marker = home.path().join("reconciled.marker");
    let _environment = Environment::set(&[
        ("WEWORK_PYTHON_RUNTIME_URL", &url),
        ("WEWORK_PYTHON_RUNTIME_TOKEN", "synthetic-runtime-token"),
        (
            "WEWORK_E2E_PLUGIN_ACCOUNT_RECONCILE_MARKER",
            marker.to_str().unwrap(),
        ),
    ]);
    let actions = Arc::new(Mutex::new(Vec::new()));
    let transport = Transport {
        packages,
        actions: actions.clone(),
    };
    let running = broker::start(
        transport.clone(),
        home.path().to_owned(),
        Arc::new(AtomicBool::new(true)),
        false,
    )
    .await
    .unwrap();
    let revocation_transport = transport.clone();
    let revocation_home = home.path().to_owned();
    let revocations = tokio::spawn(async move {
        revoke_pending(revocation_transport, &revocation_home)
            .await
            .unwrap()
    });

    until(|| bridge.requests.load(Ordering::SeqCst) == 11 && actions.lock().unwrap().len() == 2)
        .await;
    assert!(actions
        .lock()
        .unwrap()
        .iter()
        .all(|(_, slug)| slug == "native"));
    assert!(!marker.exists(), "Python has not finished preparation");
    release.send(true).unwrap();
    revocations.await.unwrap();
    until(|| marker.exists()).await;
    drop(running);
    assert_eq!(
        actions.lock().unwrap().len(),
        2,
        "failed Python targets never claim an intent or lease"
    );

    // A retry after the runtime becomes ready must include those Python targets.
    actions.lock().unwrap().clear();
    fs::remove_file(&marker).unwrap();
    bridge.ready.store(true, Ordering::SeqCst);
    let running = broker::start(
        transport.clone(),
        home.path().to_owned(),
        Arc::new(AtomicBool::new(true)),
        false,
    )
    .await
    .unwrap();
    revoke_pending(transport, home.path()).await.unwrap();
    until(|| marker.exists()).await;
    drop(running);
    let actions = actions.lock().unwrap();
    assert_eq!(actions.len(), 22);
    let counts = connector_action_counts(&actions);
    assert_eq!(counts.len(), 11);
    for count in counts.values() {
        assert_eq!(
            *count, 2,
            "each connector may create only its own intent and lease"
        );
    }
    server.abort();
}

fn connector_action_counts(
    actions: &[(String, String)],
) -> std::collections::HashMap<String, usize> {
    let mut counts = std::collections::HashMap::new();
    for (_, slug) in actions {
        *counts.entry(slug.clone()).or_default() += 1;
    }
    counts
}
