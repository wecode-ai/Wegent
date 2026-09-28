// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fmt,
    future::{ready, Future, Ready},
    pin::Pin,
    sync::{Arc, Mutex},
};

use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc};

use crate::{
    agent_session,
    emitter::{EventEnvelope, ResponsesEventBuilder},
    logging::{log_executor_event, task_fields},
    protocol::ExecutionRequest,
    runner::{streaming::StreamingEventDispatcher, AgentEngine, EventSink, ExecutionOutcome},
    runtime_work::CodexNotificationEventMapper,
};

use super::{
    mcp_form::{deferred_form, form_item},
    resolve_codex_binary, run_codex_app_server_turn_with_cancel, CodexAppServerTurn,
    CodexAppServerTurnOptions,
};

type TurnFuture = Pin<Box<dyn Future<Output = Result<CodexAppServerTurn, String>> + Send>>;

#[path = "standard_projection.rs"]
mod projection;
use projection::StandardEventProjection;

/// Drives standard callback/WebSocket tasks with the same projection as Wework.
#[derive(Clone)]
pub struct CodexAppServerEngine {
    binary: String,
    pending: Arc<Mutex<BTreeMap<String, PendingTurn>>>,
}

impl fmt::Debug for CodexAppServerEngine {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CodexAppServerEngine")
            .finish_non_exhaustive()
    }
}

struct LiveTurn {
    future: TurnFuture,
    notifications: mpsc::UnboundedReceiver<Value>,
    answers: mpsc::Sender<Value>,
    mapper: CodexNotificationEventMapper,
    projection: StandardEventProjection,
    root_thread_id: Option<String>,
    deferred_tool_use_id: Option<String>,
}

enum PendingTurn {
    Native(SuspendedTurn),
    Mcp {
        request: ExecutionRequest,
        builder: ResponsesEventBuilder,
        tool_use_id: String,
    },
}

impl PendingTurn {
    fn scope(&self) -> (&ExecutionRequest, &ResponsesEventBuilder, &str) {
        match self {
            Self::Native(turn) => (&turn.request, &turn.builder, &turn.interaction.tool_use_id),
            Self::Mcp {
                request,
                builder,
                tool_use_id,
            } => (request, builder, tool_use_id),
        }
    }
}

struct SuspendedTurn {
    turn: Box<LiveTurn>,
    request: ExecutionRequest,
    builder: ResponsesEventBuilder,
    interaction: Interaction,
}

struct Interaction {
    tool_use_id: String,
    question_ids: Vec<String>,
    request_id: Value,
}

enum TurnProgress {
    Finished(ExecutionOutcome),
    Waiting(Interaction),
}

struct StreamingCallbacks(StreamingEventDispatcher);

impl Drop for StreamingCallbacks {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl CodexAppServerEngine {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: resolve_codex_binary(&binary.into()),
            pending: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    async fn execute<S: EventSink>(
        &self,
        mut request: ExecutionRequest,
        sink: S,
        builder: ResponsesEventBuilder,
    ) -> Result<ExecutionOutcome, String> {
        let mut turn = self.start_or_resume(&mut request)?;
        let callbacks = StreamingCallbacks(StreamingEventDispatcher::with_live_compaction(sink));
        let dispatcher = &callbacks.0;
        let progress = tokio::select! {
            biased;
            message = dispatcher.failed() => return Err(message),
            progress = turn.drive(&request, dispatcher, &builder) => progress,
        };
        // Drain stream callbacks before publishing a terminal or waiting state.
        tokio::select! {
            biased;
            message = dispatcher.failed() => return Err(message),
            _ = dispatcher.compact_pending_and_flush(&request.task_id, &request.subtask_id) => {},
        }
        dispatcher.result()?;
        match progress? {
            TurnProgress::Finished(outcome) => {
                if matches!(outcome, ExecutionOutcome::WaitingForUserInput { .. }) {
                    let tool_use_id = turn
                        .deferred_tool_use_id
                        .take()
                        .ok_or("Codex deferred form is missing")?;
                    self.pending
                        .lock()
                        .map_err(|_| "Codex interaction state unavailable")?
                        .insert(
                            request.task_id.clone(),
                            PendingTurn::Mcp {
                                request,
                                builder,
                                tool_use_id,
                            },
                        );
                }
                Ok(outcome)
            }
            TurnProgress::Waiting(interaction) => {
                log_executor_event(
                    "codex task waiting for user input",
                    &task_fields(&request.task_id, &request.subtask_id),
                );
                self.pending
                    .lock()
                    .map_err(|_| "Codex interaction state unavailable")?
                    .insert(
                        request.task_id.clone(),
                        PendingTurn::Native(SuspendedTurn {
                            turn: Box::new(turn),
                            request,
                            builder,
                            interaction,
                        }),
                    );
                Ok(ExecutionOutcome::WaitingForUserInput {
                    stop_reason: "tool_deferred".to_owned(),
                })
            }
        }
    }

    fn start_or_resume(&self, request: &mut ExecutionRequest) -> Result<LiveTurn, String> {
        let answer = request
            .extra
            .get("interactive_form_answer")
            .filter(|value| !value.is_null());
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Codex interaction state unavailable")?;
        if let Some(answer) = answer {
            let suspended = pending
                .get(&request.task_id)
                .ok_or("Codex interaction is no longer active; start a new message to continue")?;
            let (original, _, tool_use_id) = suspended.scope();
            validate_answer_scope(original, tool_use_id, request, answer)?;
            if let PendingTurn::Native(suspended) = suspended {
                let response = suspended.interaction.answer(answer)?;
                suspended
                    .turn
                    .answers
                    .try_send(response)
                    .map_err(|_| "Codex interaction response channel is unavailable")?;
                let Some(PendingTurn::Native(suspended)) = pending.remove(&request.task_id) else {
                    unreachable!("validated native interaction")
                };
                return Ok(*suspended.turn);
            }
            // MCP forms finish the native turn; the answer resumes its saved thread.
            // Preserve the prepared workspace, including a selected repository directory.
            request.project_workspace_path = original.project_workspace_path.clone();
            let payload =
                crate::agents::interactive_mcp::build_interactive_form_answer_payload(answer);
            request.prompt = json!(format!(
                "User response to interactive_form_question:\n{payload}"
            ));
            pending.remove(&request.task_id);
        } else if pending.contains_key(&request.task_id) {
            if !request.new_session {
                return Err("A pending Codex form must be answered or cancelled first".to_owned());
            }
            pending.remove(&request.task_id);
        }
        drop(pending);
        let (notification_tx, notification_rx) = mpsc::unbounded_channel();
        let (answer_tx, answer_rx) = mpsc::channel(1);
        let options = CodexAppServerTurnOptions {
            resume_thread_id: agent_session::load_saved_codex_thread_id(request),
            notifications: Some(notification_tx),
            request_user_input_answers: Some(answer_rx),
            defer_interactive_forms: true,
            ..CodexAppServerTurnOptions::default()
        };
        let request = request.clone();
        let binary = self.binary.clone();
        Ok(LiveTurn {
            future: Box::pin(async move {
                run_codex_app_server_turn_with_cancel(&binary, request, options).await
            }),
            notifications: notification_rx,
            answers: answer_tx,
            mapper: CodexNotificationEventMapper::default(),
            projection: StandardEventProjection::default(),
            root_thread_id: None,
            deferred_tool_use_id: None,
        })
    }
}

impl AgentEngine for CodexAppServerEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture {
        let builder = ResponsesEventBuilder::new(&request.task_id, &request.subtask_id, "");
        self.run_with_events(request, DiscardEvents, builder)
    }

    fn run_with_events<S: EventSink>(
        &self,
        request: ExecutionRequest,
        sink: S,
        builder: ResponsesEventBuilder,
    ) -> Self::RunFuture {
        let engine = self.clone();
        Box::pin(async move {
            engine
                .execute(request, sink, builder)
                .await
                .unwrap_or_else(|message| ExecutionOutcome::Failed { message })
        })
    }

    fn cancel_pending(&self, task_id: &str, subtask_id: Option<&str>) -> Option<EventEnvelope> {
        let mut pending = self.pending.lock().ok()?;
        let suspended = pending.get(task_id)?;
        if subtask_id.is_some_and(|id| id != suspended.scope().0.subtask_id) {
            return None;
        }
        let suspended = pending.remove(task_id)?;
        Some(suspended.scope().1.response_cancelled("Task cancelled"))
    }
}

impl LiveTurn {
    async fn drive<S: EventSink>(
        &mut self,
        request: &ExecutionRequest,
        sink: &S,
        builder: &ResponsesEventBuilder,
    ) -> Result<TurnProgress, String> {
        self.projection.begin_response();
        loop {
            tokio::select! {
                biased;
                notification = self.notifications.recv() => {
                    if let Some(notification) = notification {
                        if let Some(interaction) = self.project(request, sink, builder, notification).await? {
                            return Ok(TurnProgress::Waiting(interaction));
                        }
                    } else {
                        let turn = (&mut self.future).await?;
                        agent_session::save_codex_thread_id(request, &turn.thread_id);
                        return Ok(TurnProgress::Finished(turn.outcome));
                    }
                }
                result = &mut self.future => {
                    let turn = result?;
                    // The protocol future can finish while its final notifications remain queued.
                    while let Ok(notification) = self.notifications.try_recv() {
                        self.project(request, sink, builder, notification).await?;
                    }
                    agent_session::save_codex_thread_id(request, &turn.thread_id);
                    return Ok(TurnProgress::Finished(turn.outcome));
                }
            }
        }
    }

    async fn project<S: EventSink>(
        &mut self,
        request: &ExecutionRequest,
        sink: &S,
        builder: &ResponsesEventBuilder,
        notification: Value,
    ) -> Result<Option<Interaction>, String> {
        if notification.get("method").and_then(Value::as_str) == Some("thread/started") {
            if let Some(thread_id) = notification
                .pointer("/params/thread/id")
                .and_then(Value::as_str)
            {
                self.mapper.observe_root_thread_id(thread_id);
                self.root_thread_id = Some(thread_id.to_owned());
                agent_session::save_codex_thread_id(request, thread_id);
            }
        }
        let is_root = notification
            .pointer("/params/threadId")
            .and_then(Value::as_str)
            == self.root_thread_id.as_deref();
        if is_root && form_item(&notification).is_some() {
            if notification["method"] == "item/started" {
                // Only a successful MCP result authorizes rendering a form.
                return Ok(None);
            }
            if let Some(form) = deferred_form(&notification) {
                sink.send(builder.response_function_call_added(
                    form.tool_use_id,
                    "interactive_form_question",
                    form.input,
                ))
                .await?;
                sink.send(builder.response_function_call_done(
                    form.tool_use_id,
                    "interactive_form_question",
                    form.input,
                    Some(&form.output.to_string()),
                    false,
                ))
                .await?;
                self.deferred_tool_use_id = Some(form.tool_use_id.to_owned());
                return Ok(None);
            }
        }
        // Mapping is synchronous; drain every notification before accepting the next one.
        let (events, mut receiver) = broadcast::channel(256);
        self.mapper
            .map(&Some(events), "", &request.task_id, request, notification);
        let mut interaction = None;
        loop {
            let event = match receiver.try_recv() {
                Ok(event) => event,
                Err(
                    broadcast::error::TryRecvError::Empty | broadcast::error::TryRecvError::Closed,
                ) => break,
                Err(broadcast::error::TryRecvError::Lagged(_)) => {
                    return Err("Codex event projection overflow".to_owned())
                }
            };
            let Some(event_type) = event.get("event").and_then(Value::as_str) else {
                continue;
            };
            if !event_type.starts_with("response.") {
                continue;
            }
            let mut data = event
                .pointer("/payload/data")
                .cloned()
                .unwrap_or_else(|| json!({}));
            data["type"] = json!(event_type);
            if let Some(block) = data.get("block") {
                if block
                    .pointer("/render_payload/kind")
                    .and_then(Value::as_str)
                    == Some("request_user_input")
                {
                    let (pending, input) = Interaction::from_block(block)?;
                    sink.send(builder.response_function_call_added(
                        &pending.tool_use_id,
                        "interactive_form_question",
                        &input,
                    ))
                    .await?;
                    sink.send(builder.response_function_call_done(
                        &pending.tool_use_id, "interactive_form_question", &input,
                        Some(r#"{"__deferred_user_input__":true,"success":true,"status":"waiting_for_user_response"}"#), false,
                    )).await?;
                    interaction = Some(pending);
                    continue;
                }
            }
            if let Some(event) = self.projection.project(event_type, data, builder)? {
                sink.send(event).await?;
            }
        }
        Ok(interaction)
    }
}

impl Interaction {
    fn from_block(block: &Value) -> Result<(Self, Value), String> {
        let payload = block
            .get("render_payload")
            .ok_or("Codex interaction has no form")?;
        let request_id = payload
            .get("requestId")
            .cloned()
            .ok_or("Codex interaction has no request ID")?;
        let raw_questions = payload
            .get("questions")
            .and_then(Value::as_array)
            .filter(|questions| !questions.is_empty())
            .ok_or("Codex interaction has no questions")?;
        let mut questions = Vec::new();
        let mut question_ids = Vec::new();
        for question in raw_questions {
            let id = question
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or("Codex interaction question has no ID")?;
            let text = question
                .get("question")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .ok_or("Codex interaction question has no text")?;
            let text = approval_question_text(payload, text);
            let options: Vec<Value> = question
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    option.get("label").and_then(Value::as_str).map(|label| {
                        let description = option
                            .get("description")
                            .and_then(Value::as_str)
                            .filter(|description| !description.trim().is_empty());
                        let display_label = if payload["interactionKind"] == "approval" {
                            description
                                .map(|description| format!("{label}: {description}"))
                                .unwrap_or_else(|| label.to_owned())
                        } else {
                            label.to_owned()
                        };
                        json!({"label": display_label, "value": label})
                    })
                })
                .collect();
            questions.push(json!({
                "id": id, "question": text,
                "input_type": if options.is_empty() { "text" } else { "choice" },
                "options": options, "required": true, "multi_select": false,
            }));
            question_ids.push(id.to_owned());
        }
        Ok((
            Self {
                tool_use_id: format!("codex-interaction-{}", uuid::Uuid::new_v4()),
                question_ids,
                request_id,
            },
            json!({"questions": questions}),
        ))
    }

    fn answer(&self, answer: &Value) -> Result<Value, String> {
        let cancelled = answer.get("status").and_then(Value::as_str) == Some("cancelled");
        let values = answer
            .get("answers")
            .and_then(Value::as_object)
            .ok_or("Codex form answers must be an object")?;
        let mut answers = Map::new();
        for id in &self.question_ids {
            let value = match values.get(id) {
                _ if cancelled => Vec::new(),
                Some(Value::String(value)) => vec![value.clone()],
                Some(Value::Array(values)) => values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_owned)
                            .ok_or("Codex answer values must be strings".to_owned())
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                _ => return Err(format!("Missing Codex answer for question {id}")),
            };
            answers.insert(id.clone(), json!({"answers": value}));
        }
        Ok(json!({"requestId": self.request_id, "answers": answers}))
    }
}

fn approval_question_text(payload: &Value, original: &str) -> String {
    if payload["interactionKind"] != "approval" {
        return original.to_owned();
    }
    let title = match payload["approvalKind"].as_str() {
        Some("command") => "Approve command execution?",
        Some("file_change") => "Approve file changes?",
        Some("permissions") => "Approve requested permissions?",
        _ => original,
    };
    let mut parts = vec![title.to_owned()];
    for (label, key, alternate) in [
        ("Command", "command", "command"),
        ("Working directory", "cwd", "cwd"),
        ("Reason", "reason", "reason"),
        ("Writable path", "grantRoot", "grant_root"),
        ("Permissions", "permissions", "permissions"),
        (
            "Additional permissions",
            "additionalPermissions",
            "additional_permissions",
        ),
        (
            "Network access",
            "networkApprovalContext",
            "network_approval_context",
        ),
        (
            "Command policy change",
            "proposedExecpolicyAmendment",
            "proposed_execpolicy_amendment",
        ),
        (
            "Network policy changes",
            "proposedNetworkPolicyAmendments",
            "proposed_network_policy_amendments",
        ),
    ] {
        let Some(value) = payload.get(key).or_else(|| payload.get(alternate)) else {
            continue;
        };
        if value.is_null() || value.as_str().is_some_and(|value| value.trim().is_empty()) {
            continue;
        }
        let detail = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        parts.push(format!("{label}: {detail}"));
    }
    parts.join("\n\n")
}

fn validate_answer_scope(
    original: &ExecutionRequest,
    tool_use_id: &str,
    request: &ExecutionRequest,
    answer: &Value,
) -> Result<(), String> {
    if answer.get("tool_use_id").and_then(Value::as_str) != Some(tool_use_id)
        || original.user_name != request.user_name
        || original.extra.get("user") != request.extra.get("user")
        || original.backend_url != request.backend_url
        || original.bot.pointer("/0/id") != request.bot.pointer("/0/id")
    {
        return Err("Codex form answer does not match the pending task interaction".to_owned());
    }
    Ok(())
}

#[derive(Clone)]
struct DiscardEvents;

impl EventSink for DiscardEvents {
    type SendFuture = Ready<Result<(), String>>;
    fn send(&self, _event: EventEnvelope) -> Self::SendFuture {
        ready(Ok(()))
    }
}
