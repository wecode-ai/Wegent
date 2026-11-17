//! Scheduler events must work without relying on a short audit interval.
use super::*;
use crate::local::backend::{EventHandler, LocalBackendConfig, LocalBackendTransport};
use std::{future::Future, pin::Pin};

type Reply<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

#[derive(Clone)]
struct Transport(tokio::sync::mpsc::UnboundedSender<Value>);

impl LocalBackendTransport for Transport {
    fn connect<'a>(&'a self, _: &'a LocalBackendConfig) -> Reply<'a, ()> {
        panic!("The scheduler uses an established transport")
    }
    fn disconnect<'a>(&'a self) -> Reply<'a, ()> {
        panic!("The scheduler does not own connection shutdown")
    }
    fn call<'a>(&'a self, operation: &'a str, payload: Value, _: Duration) -> Reply<'a, Value> {
        assert_eq!(operation, "plugin.auth.automatic");
        self.0.send(payload).unwrap();
        Box::pin(async { Ok(json!({"success":true,"packages":[]})) })
    }
    fn emit<'a>(&'a self, _: &'a str, _: Value) -> Reply<'a, ()> {
        panic!("Reconciliation uses request/reply")
    }
    fn on(&self, _: &str, _: EventHandler) {
        panic!("No Socket subscription")
    }
    fn on_close(&self, _: crate::local::backend::ConnectionClosedHandler) {
        panic!("No Socket subscription")
    }
}

async fn next(received: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(2), received.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn selected_installations_are_sorted_before_discovery_batches() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("capabilities")).unwrap();
    let plugins: serde_json::Map<_, _> = (42..60)
        .map(|id| {
            (
                id.to_string(),
                json!({"installed_plugin_id":id,"managed":true,"enabled":true}),
            )
        })
        .collect();
    std::fs::write(
        home.path().join("capabilities/manifest-v2.json"),
        json!({"plugins":plugins}).to_string(),
    )
    .unwrap();
    let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
    let mut requested: Vec<_> = (42..60).rev().collect();
    requested.push(99);
    super::super::super::automation::Reconciler::with_reconcile_marker(None)
        .reconcile_selected(Transport(calls), home.path(), &requested)
        .await
        .unwrap();

    assert_eq!(
        next(&mut received).await,
        json!({"installed_plugin_ids":(42..58).collect::<Vec<_>>(),"prepare_only":true})
    );
    assert_eq!(
        next(&mut received).await,
        json!({"installed_plugin_ids":[58,59],"prepare_only":true})
    );
    assert!(received.try_recv().is_err());
}

#[tokio::test]
async fn startup_audit_precedes_already_queued_lifecycle_events() {
    for requested_id in 42..60 {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("capabilities")).unwrap();
        std::fs::write(
            home.path().join("capabilities/manifest-v2.json"),
            json!({"plugins":{
                "a":{"installed_plugin_id":requested_id,"managed":true,"enabled":true},
                "b":{"installed_plugin_id":99,"managed":true,"enabled":true}
            }})
            .to_string(),
        )
        .unwrap();
        let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
        let (cancel, cancelled) = watch::channel(false);
        let (events, requested) = tokio::sync::mpsc::channel(16);
        events.send(requested_id).await.unwrap();
        let task = tokio::spawn(run(
            Transport(calls),
            home.path().to_owned(),
            Arc::new(AtomicBool::new(true)),
            cancelled,
            requested,
            Duration::from_secs(3600),
        ));
        let initial = next(&mut received).await;
        let targeted = next(&mut received).await;
        cancel.send_replace(true);
        task.await.unwrap();

        assert_eq!(initial["installed_plugin_ids"], json!([requested_id, 99]));
        assert_eq!(targeted["installed_plugin_ids"], json!([requested_id]));
        assert!(received.try_recv().is_err());
    }
}

#[tokio::test]
async fn lifecycle_and_inventory_events_run_before_the_long_audit() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("capabilities")).unwrap();
    let manifest = home.path().join("capabilities/manifest-v2.json");
    let mut plugins = json!({
        "a":{"installed_plugin_id":42,"managed":true,"enabled":true},
        "b":{"installed_plugin_id":43,"managed":true,"enabled":true},
    });
    std::fs::write(&manifest, json!({"plugins":plugins}).to_string()).unwrap();
    let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
    let (cancel, cancelled) = watch::channel(false);
    let (events, requested) = tokio::sync::mpsc::channel(16);
    let task = tokio::spawn(run(
        Transport(calls),
        home.path().to_owned(),
        Arc::new(AtomicBool::new(true)),
        cancelled,
        requested,
        Duration::from_secs(3600),
    ));
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([42, 43])
    );
    events.send(42).await.unwrap();
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([42])
    );
    plugins["c"] = json!({"installed_plugin_id":44,"managed":true,"enabled":true});
    std::fs::write(&manifest, json!({"plugins":plugins}).to_string()).unwrap();
    crate::services::capability_activation::notify_changed();
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([44])
    );
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        received.try_recv().is_err(),
        "Successful events must not restart polling"
    );
    cancel.send_replace(true);
    task.await.unwrap();
}

#[derive(Clone)]
struct FailedDiscovery {
    calls: tokio::sync::mpsc::UnboundedSender<Value>,
    first: Arc<AtomicBool>,
}

impl super::super::super::PluginAuthTransport for FailedDiscovery {
    fn exchange<'a>(&'a self, _: &'a str, payload: Value, _: Duration) -> Reply<'a, Value> {
        self.calls.send(payload).unwrap();
        let fail = self.first.swap(false, Ordering::SeqCst);
        Box::pin(async move {
            if fail {
                Err("discovery unavailable".into())
            } else {
                Ok(json!({"success":true,"packages":[]}))
            }
        })
    }
}

#[tokio::test(start_paused = true)]
async fn successful_partial_events_preserve_a_failed_full_cycle_retry() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("capabilities")).unwrap();
    std::fs::write(
        home.path().join("capabilities/manifest-v2.json"),
        json!({"plugins":{
            "a":{"installed_plugin_id":42,"managed":true,"enabled":true},
            "b":{"installed_plugin_id":43,"managed":true,"enabled":true}
        }})
        .to_string(),
    )
    .unwrap();
    let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
    let (cancel, cancelled) = watch::channel(false);
    let (events, requested) = tokio::sync::mpsc::channel(16);
    let task = tokio::spawn(run(
        FailedDiscovery {
            calls,
            first: Arc::new(AtomicBool::new(true)),
        },
        home.path().to_owned(),
        Arc::new(AtomicBool::new(true)),
        cancelled,
        requested,
        Duration::from_secs(3600),
    ));
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([42, 43])
    );
    events.send(43).await.unwrap();
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([43])
    );
    tokio::time::advance(Duration::from_secs(31)).await;
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([42, 43])
    );
    cancel.send_replace(true);
    task.await.unwrap();
}

#[derive(Clone)]
struct FencedEnrollment {
    calls: tokio::sync::mpsc::UnboundedSender<Value>,
    empty_reply: Arc<tokio::sync::Notify>,
    target_reply: Arc<tokio::sync::Notify>,
    package: Value,
}

impl super::super::super::PluginAuthTransport for FencedEnrollment {
    fn exchange<'a>(&'a self, _: &'a str, payload: Value, _: Duration) -> Reply<'a, Value> {
        self.calls.send(payload.clone()).unwrap();
        Box::pin(async move {
            if payload["prepare_only"] == true {
                if payload["installed_plugin_ids"] == json!([620072]) {
                    self.empty_reply.notified().await;
                    return Ok(json!({"success":true,"packages":[]}));
                }
                return Ok(json!({"success":true,"packages":[self.package]}));
            }
            self.target_reply.notified().await;
            Ok(json!({"success":true,"migrations":[]}))
        })
    }
}

#[tokio::test]
async fn empty_cycle_marker_does_not_identify_the_fenced_enrollment() {
    let home = tempfile::tempdir().unwrap();
    let marker = home.path().join("reconcile.log");
    std::fs::write(&marker, "reconciled\n").unwrap();
    std::fs::create_dir(home.path().join("capabilities")).unwrap();
    let root = home
        .path()
        .join("workbench/shared/plugins")
        .join("a".repeat(64));
    std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    let definition = json!({"protocolVersion":1,"credentialType":"bearer","adapter":"auth.mjs"});
    std::fs::write(root.join("auth.mjs"), "// No provider execution is needed").unwrap();
    std::fs::write(
        root.join(".codex-plugin/plugin.json"),
        json!({"connectors":[{"slug":"mail","accountAuth":definition}]}).to_string(),
    )
    .unwrap();
    let manifest = home.path().join("capabilities/manifest-v2.json");
    let mut plugins =
        json!({"independent":{"installed_plugin_id":620072,"managed":true,"enabled":true}});
    std::fs::write(&manifest, json!({"plugins":plugins}).to_string()).unwrap();
    let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
    let empty_reply = Arc::new(tokio::sync::Notify::new());
    let target_reply = Arc::new(tokio::sync::Notify::new());
    let (cancel, cancelled) = watch::channel(false);
    let (_events, requested) = tokio::sync::mpsc::channel(16);
    let task = tokio::spawn(run_observed(
        FencedEnrollment {
            calls,
            empty_reply: empty_reply.clone(),
            target_reply: target_reply.clone(),
            package: json!({"installed_plugin_id":620071,"connector_slug":"mail",
                "checksum":format!("sha256:{}", "a".repeat(64)),"auth_definition":definition}),
        },
        home.path().to_owned(),
        Arc::new(AtomicBool::new(true)),
        cancelled,
        requested,
        Duration::from_secs(3600),
        Some(marker.clone()),
    ));
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([620072])
    );
    let before = std::fs::read_to_string(&marker).unwrap();
    plugins["mail"] = json!({"installed_plugin_id":620071,"managed":true,"enabled":true,
        "checksum":format!("sha256:{}", "a".repeat(64)),"store_path":root});
    std::fs::write(&manifest, json!({"plugins":plugins}).to_string()).unwrap();
    crate::services::capability_activation::notify_changed();
    empty_reply.notify_one();
    assert_eq!(next(&mut received).await["prepare_only"], true);
    assert_eq!(
        next(&mut received).await["targets"][0]["connector_slug"],
        "mail"
    );
    // The old assertion misidentifies this unrelated empty discovery as the
    // completion of the target request, which is still held at its barrier.
    assert_ne!(
        std::fs::read_to_string(&marker).unwrap(),
        before,
        "The empty cycle must exercise the legacy marker's false positive"
    );
    let mut events_path = marker.into_os_string();
    events_path.push(".enrollments.jsonl");
    let events_path = PathBuf::from(events_path);
    let events = enrollment_events(&events_path);
    let requesting = events
        .iter()
        .find(|event| event["phase"] == "requesting")
        .unwrap();
    let attempt = requesting["attempt_id"].clone();
    assert_eq!(requesting["installed_plugin_id"], 620071);
    assert_eq!(requesting["connector_slug"], "mail");
    assert!(!events.iter().any(|event| event["phase"] == "finished"));
    target_reply.notify_one();
    let finished = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(event) = enrollment_events(&events_path)
                .into_iter()
                .find(|event| event["phase"] == "finished")
            {
                break event;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(finished["attempt_id"], attempt);
    assert_eq!(finished["ok"], true);
    cancel.send_replace(true);
    task.await.unwrap();
}

fn enrollment_events(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .split_inclusive('\n')
        .filter(|line| line.ends_with('\n'))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
