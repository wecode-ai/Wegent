// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::local::app_ipc::BackendConnectionHandler;
use tokio::sync::mpsc;

async fn receive_through(
    receiver: &mut mpsc::UnboundedReceiver<Value>,
    marker: &str,
) -> Vec<String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut turns = Vec::new();
        loop {
            let event = receiver.recv().await.expect("the backend must stay open");
            let turn = if event["event"] == "executor.event_lagged" {
                "history-gap"
            } else {
                event["payload"]["data"]["turnId"].as_str().unwrap()
            };
            turns.push(turn.to_owned());
            if turn == marker {
                return turns;
            }
        }
    })
    .await
    .expect("the backend must receive the event barrier")
}

#[test]
fn connection_replacement_preserves_runtime_event_delivery_progress() {
    let _guard = env_lock();
    let home = tempfile::tempdir().unwrap();
    let previous_home = env::var_os("WEGENT_EXECUTOR_HOME");
    env::set_var("WEGENT_EXECUTOR_HOME", home.path());
    let result = std::panic::catch_unwind(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(verify_connection_replacement())
    });
    restore_env("WEGENT_EXECUTOR_HOME", previous_home);
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

async fn verify_connection_replacement() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let registered = Arc::new(Notify::new());
    let signal = registered.clone();
    let (received, mut receiver) = mpsc::unbounded_channel();
    let server = tokio::spawn(async move {
        let router = Router::new().route(
            "/socket.io/",
            get(move |upgrade: WebSocketUpgrade| {
                let registered = signal.clone();
                let received = received.clone();
                async move {
                    upgrade.on_upgrade(move |socket| {
                        acknowledge_route_registration_with_events(
                            socket,
                            registered,
                            Some(received),
                        )
                    })
                }
            }),
        );
        axum::serve(listener, router).await.unwrap();
    });
    let config = DeviceConfig {
        device_id: "local-device".to_owned(),
        runtime_instance_id: "runtime-1".to_owned(),
        ..DeviceConfig::default()
    };
    let (events, _) = broadcast::channel(8);
    let hub = ExecutorEventHub::new(events.clone());
    hub.ensure_started();
    let controller = LocalBackendConnectionController::start_with_runtime(
        config,
        Arc::new(RouteRegistrationRuntimeWorkHandler),
        hub.clone(),
        Arc::new(TestMutex::new(None)),
        Arc::new(TestMutex::new(None)),
    )
    .await;
    let mut profile =
        json!({"backend_url": format!("http://{address}"), "auth_token": "old-token"});
    controller.configure_backend(profile.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), registered.notified())
        .await
        .unwrap();

    publish(&events, "response.completed", "already-delivered");
    publish(&events, "runtime.turn.updated", "first-barrier");
    assert_eq!(
        receive_through(&mut receiver, "first-barrier").await,
        ["already-delivered", "first-barrier"]
    );

    // Rotating the account token replaces the runner while retaining the journal.
    profile["auth_token"] = json!("rotated-token");
    controller.configure_backend(profile.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), registered.notified())
        .await
        .unwrap();
    publish(&events, "response.completed", "new-turn");
    publish(&events, "runtime.turn.updated", "second-barrier");
    assert_eq!(
        receive_through(&mut receiver, "second-barrier").await,
        ["new-turn", "second-barrier"]
    );

    controller.configure_backend(json!({})).await.unwrap();
    publish(&events, "response.completed", "completed-offline");
    controller.configure_backend(profile.clone()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), registered.notified())
        .await
        .unwrap();
    publish(&events, "runtime.turn.updated", "third-barrier");
    assert_eq!(
        receive_through(&mut receiver, "third-barrier").await,
        ["completed-offline", "third-barrier"]
    );

    // Overflow the 4096-entry journal while disconnected. Wait for ingestion,
    // rather than overflowing the separate raw broadcast channel as well.
    controller.configure_backend(json!({})).await.unwrap();
    let mut ingested = hub.subscribe_live();
    tokio::time::timeout(Duration::from_secs(10), async {
        for index in 0..4100 {
            publish(&events, "runtime.turn.updated", &format!("offline-{index}"));
            ingested.recv().await.unwrap();
        }
        publish(&events, "response.completed", "retained-after-gap");
        ingested.recv().await.unwrap();
    })
    .await
    .expect("offline events must enter the journal");
    controller.configure_backend(profile).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), registered.notified())
        .await
        .unwrap();
    let mut expected = (5..4100)
        .map(|index| format!("offline-{index}"))
        .collect::<Vec<_>>();
    expected.extend(["retained-after-gap", "history-gap"].map(str::to_owned));
    assert_eq!(
        receive_through(&mut receiver, "history-gap").await,
        expected
    );
    publish(&events, "runtime.turn.updated", "fourth-barrier");
    assert_eq!(
        receive_through(&mut receiver, "fourth-barrier").await,
        ["fourth-barrier"]
    );

    controller.configure_backend(json!({})).await.unwrap();
    server.abort();
    let _ = server.await;
}

fn publish(events: &broadcast::Sender<Value>, event: &str, turn: &str) {
    events
        .send(json!({"event": event, "payload": {
            "event_type": event, "taskId": "runtime-1", "subtaskId": turn,
            "data": {"turnId": turn, "value": "Task finished"}
        }}))
        .unwrap();
}
