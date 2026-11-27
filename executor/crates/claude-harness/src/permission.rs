//! Claude stream-json tool permissions for one live Shell invocation.
mod mcp;

use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc};

use serde_json::{json, Value};
use tokio::{
    sync::{mpsc, oneshot},
    task::{AbortHandle, JoinSet},
};

pub trait ToolApproval: Send + Sync {
    fn native_mcp_policy(&self, _server: &str, _tool: &str) -> bool {
        false
    }
    fn decide(
        &self,
        request_id: String,
        tool_name: String,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>>;
}

tokio::task_local! { static APPROVAL: Arc<dyn ToolApproval>; }

pub async fn with_tool_approval<F: Future>(handler: Arc<dyn ToolApproval>, future: F) -> F::Output {
    APPROVAL.scope(handler, future).await
}

pub(crate) fn interactive(spec: &crate::process::CommandSpec) -> bool {
    spec.args()
        .windows(2)
        .any(|args| args == ["--permission-prompt-tool", "stdio"])
}

pub(crate) fn handler() -> Option<Arc<dyn ToolApproval>> {
    APPROVAL.try_with(Arc::clone).ok()
}

pub(crate) struct PermissionSession {
    owner: Arc<dyn ToolApproval>,
    writer: mpsc::UnboundedSender<Value>,
    tasks: JoinSet<()>,
    requests: HashMap<String, AbortHandle>,
    catalogs: HashMap<String, oneshot::Sender<Value>>,
    initialized: Option<oneshot::Sender<bool>>,
}

impl PermissionSession {
    pub(crate) fn new(owner: Arc<dyn ToolApproval>, writer: mpsc::UnboundedSender<Value>) -> Self {
        Self {
            owner,
            writer,
            tasks: JoinSet::new(),
            requests: HashMap::new(),
            catalogs: HashMap::new(),
            initialized: None,
        }
    }

    pub(crate) fn initialize<'a>(
        &mut self,
        input: &'a str,
    ) -> (Value, &'a str, oneshot::Receiver<bool>) {
        let (init, prompt) = mcp::initialize(input);
        let (tx, rx) = oneshot::channel();
        self.initialized = Some(tx);
        (init, prompt, rx)
    }

    pub(crate) fn observe_response(&mut self, response: &Value) {
        let Some(id) = response["request_id"].as_str() else {
            return;
        };
        if id == mcp::INIT {
            if let Some(sender) = self.initialized.take() {
                let _ = sender.send(response["subtype"] == "success");
            }
        } else if let Some(sender) = self.catalogs.remove(id) {
            let _ = sender.send(response["response"].clone());
        }
    }

    fn hook(&mut self, key: &str, input: &Value) {
        let send = |writer: &mpsc::UnboundedSender<Value>, id: &str, response: Value| {
            let _ = writer.send(json!({"type":"control_response","response":{
                "subtype":"success","request_id":id,"response":response}}));
        };
        let name = input["tool_name"].as_str().unwrap_or_default();
        let parsed = wegent_mcp_runtime::interactive_mcp::parse_mcp_tool_name(name);
        let source = &input["mcp_server"];
        let Some(parsed) = parsed else {
            send(
                &self.writer,
                key,
                if source.is_object() {
                    mcp::ask()
                } else {
                    json!({})
                },
            );
            return;
        };
        let server = source["name"].as_str().unwrap_or(&parsed.server_name);
        if source["source"] == "dynamic" && self.owner.native_mcp_policy(server, &parsed.tool_name)
        {
            send(&self.writer, key, json!({}));
            return;
        }
        // A subagent may shadow a parent transport. The parent catalog cannot
        // establish read-only metadata for that different connection.
        if input["agent_id"].is_string() {
            send(&self.writer, key, mcp::ask());
            return;
        }
        let id = format!("wegent_mcp_status_{key}");
        let (tx, rx) = oneshot::channel();
        self.catalogs.insert(id.clone(), tx);
        let _ = self
            .writer
            .send(json!({"type":"control_request","request_id":id,
            "request":{"subtype":"mcp_status"}}));
        let writer = self.writer.clone();
        let key = key.to_owned();
        let server = server.to_owned();
        self.requests.insert(
            key.clone(),
            self.tasks.spawn(async move {
                let read = tokio::time::timeout(std::time::Duration::from_secs(2), rx)
                    .await
                    .is_ok_and(|result| {
                        result.is_ok_and(|catalog| {
                            mcp::read_only(&catalog, &server, &parsed.tool_name)
                        })
                    });
                send(&writer, &key, if read { json!({}) } else { mcp::ask() });
            }),
        );
    }

    pub(crate) fn observe(&mut self, frame: &Value) {
        let Some(id) = frame["request_id"].as_str() else {
            return;
        };
        match frame["type"].as_str() {
            Some("control_cancel_request") => {
                if let Some(task) = self.requests.get(id) {
                    task.abort();
                }
            }
            Some("control_request") if !self.requests.contains_key(id) => {
                while self.tasks.try_join_next().is_some() {}
                let owner = Arc::clone(&self.owner);
                let writer = self.writer.clone();
                let request = frame["request"].clone();
                let key = id.to_owned();
                if request["subtype"] == "hook_callback" && request["callback_id"] == mcp::CALLBACK
                {
                    self.hook(&key, &request["input"]);
                    return;
                }
                let task = self.tasks.spawn(async move {
                    let body = match (request["subtype"].as_str(), request["tool_name"].as_str()) {
                        (Some("can_use_tool"), Some(tool)) if request["input"].is_object() => {
                            let input = &request["input"];
                            let decision = if owner.decide(key.clone(), tool.to_owned(), input.clone()).await {
                                json!({"behavior":"allow","updatedInput":input})
                            } else {
                                json!({"behavior":"deny","message":"Tool permission denied"})
                            };
                            json!({"subtype":"success","request_id":key,"response":decision})
                        }
                        _ => json!({"subtype":"error","request_id":key,"error":"Unsupported Claude control request"}),
                    };
                    let _ = writer.send(json!({"type":"control_response","response":body}));
                });
                self.requests.insert(id.to_owned(), task);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    struct Handler(mpsc::UnboundedSender<(String, String, Value, oneshot::Sender<bool>)>);

    impl ToolApproval for Handler {
        fn decide(
            &self,
            id: String,
            tool: String,
            input: Value,
        ) -> Pin<Box<dyn Future<Output = bool> + Send + '_>> {
            Box::pin(async move {
                let (send, recv) = oneshot::channel();
                self.0.send((id, tool, input, send)).unwrap();
                recv.await.unwrap_or(false)
            })
        }
    }

    #[tokio::test]
    async fn decisions_are_bound_to_the_native_request_and_process_lifetime() {
        let (approver, mut requests) = mpsc::unbounded_channel();
        let (writer, mut responses) = mpsc::unbounded_channel();
        let mut session = PermissionSession::new(Arc::new(Handler(approver)), writer);
        let input = json!({"file_path":"draft.txt","content":"hello"});
        for (id, allowed) in [("first", true), ("second", false)] {
            let frame = json!({"type":"control_request","request_id":id,"request":{
                "subtype":"can_use_tool","tool_name":"Write","input":input}});
            session.observe(&frame);
            session.observe(&frame);
            let (received, tool, args, decision) = requests.recv().await.unwrap();
            assert_eq!(
                (received.as_str(), tool.as_str(), args),
                (id, "Write", input.clone())
            );
            decision.send(allowed).unwrap();
            let response = responses.recv().await.unwrap();
            assert_eq!(response["type"], "control_response");
            assert_eq!(response["response"]["request_id"], id);
            let body = &response["response"]["response"];
            if allowed {
                assert_eq!(body, &json!({"behavior":"allow","updatedInput":input}));
            } else {
                assert_eq!(body["behavior"], "deny");
            }
        }
        for id in ["cancel", "exit"] {
            session.observe(&json!({"type":"control_request","request_id":id,"request":{
                "subtype":"can_use_tool","tool_name":"Write","input":input}}));
            let (received, _, _, mut decision) = requests.recv().await.unwrap();
            assert_eq!(received, id);
            if id == "cancel" {
                session.observe(&json!({"type":"control_cancel_request","request_id":id}));
            } else {
                drop(session);
                decision.closed().await;
                break;
            }
            decision.closed().await;
        }
        assert_eq!(responses.recv().await, None);
    }
}
