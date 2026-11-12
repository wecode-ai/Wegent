use super::*;
use tokio::sync::{mpsc, oneshot};

type Call = (Value, oneshot::Sender<Result<Value, String>>);

#[derive(Clone)]
struct AckTransport {
    calls: mpsc::UnboundedSender<Call>,
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

    fn emit<'a>(&'a self, _: &'a str, _: Value) -> TransportFuture<'a, ()> {
        Box::pin(async { panic!("A terminal event must request durable acceptance") })
    }

    fn on(&self, _: &str, _: EventHandler) {}
    fn on_close(&self, _: ConnectionClosedHandler) {}
}

async fn fixture() -> (ExecutorEventHub, Value) {
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
    (hub, terminal)
}

fn client() -> (
    LocalBackendClient<AckTransport>,
    mpsc::UnboundedReceiver<Call>,
) {
    let (calls, rx) = mpsc::unbounded_channel();
    (
        LocalBackendClient::new(
            super::super::tests::backend_config("device-1"),
            AckTransport { calls },
        ),
        rx,
    )
}

fn attempt(
    client: LocalBackendClient<AckTransport>,
    hub: ExecutorEventHub,
    event: Value,
) -> JoinHandle<(Result<(), String>, u64)> {
    tokio::spawn(async move {
        let mut delivered = 0;
        let result =
            relay_event(&client, &hub, event, &mut delivered, &AtomicBool::new(true)).await;
        (result, delivered)
    })
}

#[tokio::test]
async fn terminal_cursor_waits_for_business_ack_and_replays_the_same_event() {
    let (hub, terminal) = fixture().await;
    let (client, mut calls) = client();
    let first = attempt(client.clone(), hub.clone(), terminal.clone());
    let (payload, ack) = calls.recv().await.unwrap();
    assert_eq!(payload, terminal);
    assert!(hub.subscribe_backend(0).unwrap().replay.contains(&terminal));
    ack.send(Ok(
        json!({"success":false,"retryable":true,"error":"Storage unavailable"}),
    ))
    .unwrap();
    let (result, cursor) = first.await.unwrap();
    assert!(result.is_err());
    assert_eq!(cursor, 0);

    let second = attempt(client, hub.clone(), terminal.clone());
    let (replayed, ack) = calls.recv().await.unwrap();
    assert_eq!(payload, replayed);
    ack.send(Ok(json!({"success":true}))).unwrap();
    let (result, cursor) = second.await.unwrap();
    result.unwrap();
    assert_eq!(cursor, event_sequence(&terminal).unwrap());
    assert!(hub.subscribe_backend(0).unwrap().replay.is_empty());
}

#[tokio::test]
async fn lost_ack_survives_runner_recreation_without_waiting_for_a_ui_consumer() {
    let (hub, terminal) = fixture().await;
    let (first_client, mut first_calls) = client();
    let first = attempt(first_client, hub.clone(), terminal.clone());
    let (_, ack) = first_calls.recv().await.unwrap();
    drop(ack);
    assert!(first.await.unwrap().0.is_err());

    let (next_client, mut calls) = client();
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
        while !hub.subscribe_backend(0).unwrap().replay.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    forwarder.abort();
}
