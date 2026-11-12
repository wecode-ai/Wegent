use super::*;
use tokio::sync::{mpsc, oneshot};

type Call = (Value, oneshot::Sender<Result<Value, String>>);

fn account() -> String {
    event_account(&super::super::tests::backend_config("device-1")).unwrap()
}

#[derive(Clone)]
struct AckTransport {
    calls: mpsc::UnboundedSender<Call>,
    emits: mpsc::UnboundedSender<Value>,
}

impl LocalBackendTransport for AckTransport {
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
        Box::pin(async move {
            assert_eq!(event, RUNTIME_EVENT_EVENT);
            let (tx, rx) = oneshot::channel();
            self.calls.send((payload, tx)).unwrap();
            rx.await.map_err(|_| "ACK lost".to_owned())?
        })
    }

    fn emit<'a>(&'a self, event: &'a str, payload: Value) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            assert_eq!(event, RUNTIME_EVENT_EVENT);
            assert!(!is_terminal(&payload), "Terminals require business ACKs");
            self.emits.send(payload).unwrap();
            Ok(())
        })
    }

    fn on(&self, _: &str, _: EventHandler) {}
    fn on_close(&self, _: ConnectionClosedHandler) {}
}

async fn fixture() -> (ExecutorEventHub, Value, broadcast::Sender<Value>) {
    let (raw, _) = broadcast::channel(16);
    let hub = ExecutorEventHub::new(raw.clone());
    hub.ensure_started();
    let mut live = hub.subscribe_live();
    raw.send(
        json!({"_runtime_event_account":account(),"event":"response.completed","payload":{
            "taskId":"task-1","subtaskId":"turn-1","event_type":"response.completed",
            "data":{"value":"Done","turnId":"turn-1"}
        }}),
    )
    .unwrap();
    let terminal = live.recv().await.unwrap();
    (hub, terminal, raw)
}

fn client() -> (
    LocalBackendClient<AckTransport>,
    mpsc::UnboundedReceiver<Call>,
    mpsc::UnboundedReceiver<Value>,
) {
    client_with_config(super::super::tests::backend_config("device-1"))
}

fn client_with_config(
    config: LocalBackendConfig,
) -> (
    LocalBackendClient<AckTransport>,
    mpsc::UnboundedReceiver<Call>,
    mpsc::UnboundedReceiver<Value>,
) {
    let (calls, rx) = mpsc::unbounded_channel();
    let (emits, emitted) = mpsc::unbounded_channel();
    (
        LocalBackendClient::new(config, AckTransport { calls, emits }),
        rx,
        emitted,
    )
}

fn attempt(
    client: LocalBackendClient<AckTransport>,
    hub: ExecutorEventHub,
    event: Value,
) -> JoinHandle<Result<(), String>> {
    tokio::spawn(async move { acknowledge_terminal(&client, &hub, event).await })
}

#[tokio::test]
async fn terminal_event_waits_for_business_ack_and_replays_the_same_event() {
    let (hub, terminal, _raw) = fixture().await;
    let (client, mut calls, _emits) = client();
    let first = attempt(client.clone(), hub.clone(), terminal.clone());
    let (payload, ack) = calls.recv().await.unwrap();
    assert_eq!(payload, terminal);
    assert!(hub
        .pending_backend_terminals(&account())
        .unwrap()
        .contains(&terminal));
    ack.send(Ok(
        json!({"success":false,"retryable":true,"error":"Storage unavailable"}),
    ))
    .unwrap();
    assert!(first.await.unwrap().is_err());
    assert!(hub
        .pending_backend_terminals(&account())
        .unwrap()
        .contains(&terminal));

    let second = attempt(client, hub.clone(), terminal.clone());
    let (replayed, ack) = calls.recv().await.unwrap();
    assert_eq!(payload, replayed);
    ack.send(Ok(json!({"success":true}))).unwrap();
    second.await.unwrap().unwrap();
    assert!(hub
        .pending_backend_terminals(&account())
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn lost_ack_survives_runner_recreation_without_waiting_for_a_ui_consumer() {
    let (hub, terminal, _raw) = fixture().await;
    let (first_client, mut first_calls, _emits) = client();
    let first = attempt(first_client, hub.clone(), terminal.clone());
    let (_, ack) = first_calls.recv().await.unwrap();
    drop(ack);
    assert!(first.await.unwrap().is_err());

    let (next_client, mut calls, _emits) = client();
    let forwarder = tokio::spawn(forward(
        next_client,
        hub.clone(),
        Arc::new(AtomicBool::new(true)),
    ));
    let (payload, ack) = tokio::time::timeout(Duration::from_secs(1), calls.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(payload, terminal);
    ack.send(Ok(json!({"success":true}))).unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !hub
            .pending_backend_terminals(&account())
            .unwrap()
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    forwarder.abort();
}

#[tokio::test]
async fn a_missing_ack_does_not_block_other_tasks_streams_or_terminals() {
    let (hub, terminal, raw) = fixture().await;
    let (client, mut calls, mut emits) = client();
    let connected = Arc::new(AtomicBool::new(true));
    let forwarder = tokio::spawn(forward(client, hub.clone(), Arc::clone(&connected)));
    let (first, held_ack) = tokio::time::timeout(Duration::from_secs(1), calls.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first, terminal);

    raw.send(
        json!({"_runtime_event_account":account(),"event":"response.output_text.delta","payload":{
            "taskId":"task-2","data":{"delta":"Independent stream"}
        }}),
    )
    .unwrap();
    let streamed = tokio::time::timeout(Duration::from_secs(1), emits.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(streamed["payload"]["taskId"], "task-2");
    raw.send(
        json!({"_runtime_event_account":account(),"event":"response.completed","payload":{
            "taskId":"task-2","subtaskId":"turn-2","data":{"value":"Done"}
        }}),
    )
    .unwrap();
    let (second, ack) = tokio::time::timeout(Duration::from_secs(1), calls.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second["payload"]["taskId"], "task-2");
    ack.send(Ok(json!({"success":true}))).unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while hub.pending_backend_terminals(&account()).unwrap() != vec![terminal.clone()] {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    drop(held_ack);
    let (retry, ack) = tokio::time::timeout(Duration::from_secs(2), calls.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retry, terminal);
    assert!(connected.load(Ordering::Acquire));
    ack.send(Ok(json!({"success":true}))).unwrap();
    forwarder.abort();
}

#[tokio::test]
async fn switched_connections_never_send_another_accounts_replay_or_late_events() {
    let (hub, first, raw) = fixture().await;
    let mut config_b = super::super::tests::backend_config("device-1");
    config_b.auth_token = "account-b".into();
    let account_b = event_account(&config_b).unwrap();
    hub.bind_backend_journal(&account_b);
    let (client_b, mut calls_b, mut emits_b) = client_with_config(config_b);
    let forwarder_b = tokio::spawn(forward(
        client_b,
        hub.clone(),
        Arc::new(AtomicBool::new(true)),
    ));
    for (owner, task, event) in [
        (account(), "late-a", "response.output_text.delta"),
        (account(), "late-a", "response.completed"),
        (account_b.clone(), "current-b", "response.output_text.delta"),
        (account_b.clone(), "current-b", "response.completed"),
    ] {
        raw.send(
            json!({"_runtime_event_account":owner,"event":event,"payload":{
                "taskId":task,"subtaskId":task,"data":{"value":task,"delta":task}
            }}),
        )
        .unwrap();
    }
    let stream_b = tokio::time::timeout(Duration::from_secs(1), emits_b.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stream_b["payload"]["taskId"], "current-b");
    let (terminal_b, ack_b) = tokio::time::timeout(Duration::from_secs(1), calls_b.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(terminal_b["payload"]["taskId"], "current-b");
    ack_b.send(Ok(json!({"success":true}))).unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !hub
            .pending_backend_terminals(&account_b)
            .unwrap()
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(calls_b.try_recv().is_err());
    assert!(emits_b.try_recv().is_err());
    let pending_a = hub.pending_backend_terminals(&account()).unwrap();
    assert_eq!(pending_a.len(), 2);
    assert!(pending_a.contains(&first));

    // Reconnect A while B is still connected. Both subscriptions keep their
    // own replay and ACK ownership without rebinding a global account slot.
    let (client_a, mut calls_a, mut emits_a) = client();
    let forwarder_a = tokio::spawn(forward(
        client_a,
        hub.clone(),
        Arc::new(AtomicBool::new(true)),
    ));
    for _ in 0..2 {
        let (event, ack) = tokio::time::timeout(Duration::from_secs(1), calls_a.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(pending_a.contains(&event));
        ack.send(Ok(json!({"success":true}))).unwrap();
    }
    let stream_a = tokio::time::timeout(Duration::from_secs(1), emits_a.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stream_a["payload"]["taskId"], "late-a");
    assert!(emits_a.try_recv().is_err());
    assert!(calls_b.try_recv().is_err());
    forwarder_a.abort();
    forwarder_b.abort();
}
