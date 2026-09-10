//! Native-only task token exchange. No tool or loopback API can issue tokens.

use crate::local::backend::LocalBackendTransport;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub(super) struct Token {
    pub value: String,
    pub expires: tokio::time::Instant,
}

struct Request {
    task_id: String,
    reply: oneshot::Sender<Result<Token, String>>,
}

#[derive(Clone)]
pub(super) struct Issuer(mpsc::Sender<Request>, Arc<AtomicBool>);

fn active() -> &'static Mutex<Option<Issuer>> {
    static ACTIVE: OnceLock<Mutex<Option<Issuer>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

pub(super) fn current() -> Result<Issuer, String> {
    active()
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "Plugin TaskToken requires a connected Wegent account".into())
}

pub(crate) struct Registration {
    pub(super) issuer: Issuer,
    worker: tokio::task::JoinHandle<()>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.issuer.1.store(false, Ordering::Release);
        self.worker.abort();
        let mut guard = active().lock().unwrap();
        if guard
            .as_ref()
            .is_some_and(|value| value.0.same_channel(&self.issuer.0))
        {
            *guard = None;
        }
    }
}

pub(crate) fn register<T: LocalBackendTransport>(
    transport: T,
    connected: Arc<AtomicBool>,
) -> Registration {
    let registration = spawn(transport, connected);
    *active().lock().unwrap() = Some(registration.issuer.clone());
    registration
}

pub(super) fn spawn<T: LocalBackendTransport>(
    transport: T,
    connected: Arc<AtomicBool>,
) -> Registration {
    let (sender, mut requests) = mpsc::channel::<Request>(32);
    let issuer = Issuer(sender, Arc::new(AtomicBool::new(true)));
    let worker = tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            let result = if connected.load(Ordering::Acquire) {
                exchange(&transport, &request.task_id).await
            } else {
                Err("Plugin TaskToken requires a connected Wegent account".into())
            };
            let _ = request.reply.send(result);
        }
    });
    Registration { issuer, worker }
}

async fn exchange<T: LocalBackendTransport>(transport: &T, task_id: &str) -> Result<Token, String> {
    let value = transport
        .call(
            "plugin.task_token.issue",
            json!({"task_id": task_id}),
            Duration::from_secs(15),
        )
        .await
        .map_err(|_| "Plugin TaskToken backend is unavailable")?;
    let value = if value.is_array() {
        value.get(0).unwrap_or(&Value::Null)
    } else {
        &value
    };
    if value["success"] != true {
        return Err("Plugin TaskToken issuance was rejected; reconnect your Wegent account".into());
    }
    let token = value["auth_token"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("Invalid Plugin TaskToken response")?;
    let ttl = value["expires_in"]
        .as_u64()
        .filter(|ttl| *ttl > 60 && *ttl <= 86400)
        .ok_or("Invalid Plugin TaskToken expiry")?;
    Ok(Token {
        value: token.into(),
        expires: tokio::time::Instant::now() + Duration::from_secs(ttl - 60),
    })
}

impl Issuer {
    pub(super) fn available(&self) -> bool {
        self.1.load(Ordering::Acquire) && !self.0.is_closed()
    }

    pub(super) async fn issue(&self, task_id: &str) -> Result<Token, String> {
        let (reply, response) = oneshot::channel();
        tokio::time::timeout(Duration::from_secs(20), async {
            self.0
                .send(Request {
                    task_id: task_id.into(),
                    reply,
                })
                .await
                .map_err(|_| "Plugin TaskToken connection has changed")?;
            response
                .await
                .map_err(|_| "Plugin TaskToken connection has changed")?
        })
        .await
        .map_err(|_| "Plugin TaskToken issuance timed out")?
    }
}
