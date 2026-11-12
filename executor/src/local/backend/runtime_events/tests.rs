use super::*;
use tokio::sync::{mpsc, oneshot};

type Call = (Value, oneshot::Sender<Result<Value, String>>);

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
    raw.send(json!({"event":"response.completed","payload":{
        "taskId":"task-1","subtaskId":"turn-1","event_type":"response.completed",
        "data":{"value":"Done","turnId":"turn-1"}
    }}))
    .unwrap();
    let terminal = live.recv().await.unwrap();
    (hub, terminal, raw)
}

fn client() -> (
    LocalBackendClient<AckTransport>,
    mpsc::UnboundedReceiver<Call>,
    mpsc::UnboundedReceiver<Value>,
) {
    let (calls, rx) = mpsc::unbounded_channel();
    let (emits, emitted) = mpsc::unbounded_channel();
    (
        LocalBackendClient::new(
            super::super::tests::backend_config("device-1"),
            AckTransport { calls, emits },
        ),
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
    assert!(hub.pending_backend_terminals().unwrap().contains(&terminal));
    ack.send(Ok(
        json!({"success":false,"retryable":true,"error":"Storage unavailable"}),
    ))
    .unwrap();
    assert!(first.await.unwrap().is_err());
    assert!(hub.pending_backend_terminals().unwrap().contains(&terminal));

    let second = attempt(client, hub.clone(), terminal.clone());
    let (replayed, ack) = calls.recv().await.unwrap();
    assert_eq!(payload, replayed);
    ack.send(Ok(json!({"success":true}))).unwrap();
    second.await.unwrap().unwrap();
    assert!(hub.pending_backend_terminals().unwrap().is_empty());
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
        while !hub.pending_backend_terminals().unwrap().is_empty() {
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

    raw.send(json!({"event":"response.output_text.delta","payload":{
        "taskId":"task-2","data":{"delta":"Independent stream"}
    }}))
    .unwrap();
    let streamed = tokio::time::timeout(Duration::from_secs(1), emits.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(streamed["payload"]["taskId"], "task-2");
    raw.send(json!({"event":"response.completed","payload":{
        "taskId":"task-2","subtaskId":"turn-2","data":{"value":"Done"}
    }}))
    .unwrap();
    let (second, ack) = tokio::time::timeout(Duration::from_secs(1), calls.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second["payload"]["taskId"], "task-2");
    ack.send(Ok(json!({"success":true}))).unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while hub.pending_backend_terminals().unwrap() != vec![terminal.clone()] {
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
