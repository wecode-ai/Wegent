//! Host-admitted event work must enter native Goal accounting before model execution.
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::OwnedMutexGuard;

use super::{event_receipt, CodexAppServerClient, CodexLaunchConfig, CodexTurnRequestContext};

type PersistEventPhase = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

pub struct EventGoalAdmission {
    thread: String,
    expected_goal: Value,
    operation: String,
    input: Value,
    phase: Option<String>,
    guard: Option<OwnedMutexGuard<()>>,
    persist: PersistEventPhase,
}

enum Activation {
    Acknowledged(Value),
    Pending(u64),
}

impl EventGoalAdmission {
    #[cfg(test)]
    pub(crate) async fn activate_for_test(
        &mut self,
        client: &CodexAppServerClient,
        home: &std::path::Path,
    ) -> Result<Value, String> {
        struct Native<'a>(&'a CodexAppServerClient);
        impl EventRpc for Native<'_> {
            fn request<'a>(
                &'a mut self,
                method: &'static str,
                params: Value,
            ) -> BoxFuture<'a, Result<Value, String>> {
                Box::pin(self.0.request(method, params))
            }
        }
        let thread = self.thread.clone();
        match self.activate(&mut Native(client), home, &thread).await? {
            Activation::Acknowledged(response) => Ok(response),
            Activation::Pending(_) => {
                Err("Native event test did not acknowledge activation".into())
            }
        }
    }
    pub(crate) fn new(
        thread: String,
        expected_goal: Value,
        operation: String,
        input: Value,
        phase: Option<String>,
        guard: OwnedMutexGuard<()>,
        persist: PersistEventPhase,
    ) -> Self {
        Self {
            thread,
            expected_goal,
            operation,
            input,
            phase,
            guard: Some(guard),
            persist,
        }
    }

    fn save(&mut self, phase: &str) -> Result<(), String> {
        (self.persist)(phase)?;
        self.phase = Some(phase.into());
        Ok(())
    }

    async fn check(&self, rpc: &mut impl EventRpc) -> Result<(), String> {
        let current = rpc
            .request("thread/goal/get", json!({"threadId":self.thread}))
            .await?;
        let current =
            crate::runtime_work::normalize_runtime_goal_timestamps(current["goal"].clone());
        if current["status"] != "blocked"
            || ["objective", "createdAt", "tokenBudget"]
                .iter()
                .any(|key| current[*key] != self.expected_goal[*key])
        {
            return Err("The original waiting Goal changed before event execution".into());
        }
        Ok(())
    }

    pub(super) async fn before_resume(
        &self,
        client: &CodexAppServerClient,
        launch: &CodexLaunchConfig,
    ) -> Result<(), String> {
        self.check(&mut SharedRpc {
            client,
            launch,
            context: None,
        })
        .await
    }

    async fn activate(
        &mut self,
        rpc: &mut impl EventRpc,
        home: &std::path::Path,
        thread: &str,
    ) -> Result<Activation, String> {
        if thread != self.thread {
            return Err("Event work cannot change its original native thread".into());
        }
        self.check(rpc).await?;
        let digest = format!("{:x}", Sha256::digest(self.operation.as_bytes()));
        let item_id = format!("msg_wework_event_{}", &digest[..32]);
        let item = json!({"type":"message","id":item_id,"role":"user","content":[{"type":"input_text","text":crate::runtime_work::prompt_text(&self.input)}]});
        let history = rpc
            .request(
                "thread/read",
                json!({"threadId":thread,"includeTurns":false}),
            )
            .await?;
        let path = history["thread"]["path"]
            .as_str()
            .ok_or("Native event history path is unavailable")?;
        let receipt = event_receipt::read(home, std::path::Path::new(path), thread, &item)?;
        if receipt.activated
            || receipt.turn_id.is_some()
            || matches!(
                self.phase.as_deref(),
                Some("activation_requested" | "activated")
            )
        {
            return Err(
                "Event activation was already attempted; inspect its original execution receipt"
                    .into(),
            );
        }
        if !receipt.injected {
            if self.phase.is_some() {
                return Err(
                    "Event injection has an uncertain native receipt; it cannot be repeated".into(),
                );
            }
            self.save("injection_requested")?;
            rpc.request(
                "thread/inject_items",
                json!({"threadId":thread,"items":[item]}),
            )
            .await?;
        }
        self.save("injected")?;
        self.check(rpc).await?;
        self.save("activation_requested")?;
        let response = rpc
            .activate(json!({"threadId":thread,"status":"active","origin":"automatic"}))
            .await?;
        if matches!(response, Activation::Acknowledged(_)) {
            self.save("activated")?;
        }
        // The direct reader owns the pending ACK. Its request is already ordered
        // before subsequent human mutations on this native connection.
        drop(self.guard.take());
        Ok(response)
    }

    pub(super) async fn activate_shared(
        &mut self,
        client: &CodexAppServerClient,
        launch: &CodexLaunchConfig,
        context: &mut CodexTurnRequestContext,
        thread: &str,
    ) -> Result<Value, String> {
        match self
            .activate(
                &mut SharedRpc {
                    client,
                    launch,
                    context: Some(context),
                },
                &client
                    .home
                    .clone()
                    .unwrap_or_else(|| super::codex_home_for_launch_config(launch)),
                thread,
            )
            .await?
        {
            Activation::Acknowledged(response) => Ok(response),
            Activation::Pending(_) => {
                Err("Shared native event activation did not acknowledge admission".into())
            }
        }
    }

    pub(super) async fn before_resume_direct(
        &self,
        rpc: &mut super::JsonRpcConnection,
        state: &mut super::CodexRunState,
    ) -> Result<(), String> {
        self.check(&mut DirectRpc { rpc, state }).await
    }

    pub(super) async fn activate_direct(
        &mut self,
        rpc: &mut super::JsonRpcConnection,
        state: &mut super::CodexRunState,
        home: &std::path::Path,
        thread: &str,
    ) -> Result<u64, String> {
        match self
            .activate(&mut DirectRpc { rpc, state }, home, thread)
            .await?
        {
            Activation::Pending(id) => Ok(id),
            Activation::Acknowledged(_) => {
                Err("Direct native event activation lost its turn reader".into())
            }
        }
    }
}

trait EventRpc: Send {
    fn request<'a>(
        &'a mut self,
        method: &'static str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, String>>;
    fn activate<'a>(&'a mut self, params: Value) -> BoxFuture<'a, Result<Activation, String>> {
        Box::pin(async move {
            self.request("thread/goal/set", params)
                .await
                .map(Activation::Acknowledged)
        })
    }
}

struct SharedRpc<'a> {
    client: &'a CodexAppServerClient,
    launch: &'a CodexLaunchConfig,
    context: Option<&'a mut CodexTurnRequestContext>,
}

impl EventRpc for SharedRpc<'_> {
    fn request<'a>(
        &'a mut self,
        method: &'static str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            if matches!(method, "thread/inject_items" | "thread/goal/set") {
                // Never replay source input or activation through generic
                // authentication/process recovery after an uncertain outcome.
                return self
                    .client
                    .request_for_launch_config_once(method, params, self.launch)
                    .await;
            }
            match self.context.as_mut() {
                Some(context) => {
                    context
                        .request(self.client, method, params, self.launch)
                        .await
                }
                None => {
                    self.client
                        .request_for_launch_config(method, params, self.launch)
                        .await
                }
            }
        })
    }
}

struct DirectRpc<'a> {
    rpc: &'a mut super::JsonRpcConnection,
    state: &'a mut super::CodexRunState,
}
impl EventRpc for DirectRpc<'_> {
    fn request<'a>(
        &'a mut self,
        method: &'static str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(super::with_rpc_timeout(
            method,
            super::codex_rpc_timeout_seconds(),
            self.rpc.request(method, params, self.state),
        ))
    }
    fn activate<'a>(&'a mut self, params: Value) -> BoxFuture<'a, Result<Activation, String>> {
        // The normal turn reader must consume the ACK and every initial turn
        // notification, including source presentation and approval requests.
        Box::pin(async move {
            let id = super::with_rpc_timeout(
                "thread/goal/set",
                super::codex_rpc_timeout_seconds(),
                self.rpc.send_request("thread/goal/set", params),
            )
            .await?;
            Ok(Activation::Pending(id))
        })
    }
}
