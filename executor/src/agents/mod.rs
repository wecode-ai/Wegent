// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, future::Future, pin::Pin};

mod agno;
mod claude_code;
mod claude_options;
mod codex;
mod dify;
mod git_auth;
mod git_workspace;
mod image_validator;
pub mod interactive_mcp;
mod runtime_capabilities;
mod task_identity;

use crate::{
    emitter::ResponsesEventBuilder,
    logging::{log_executor_event, task_fields},
    process::{CommandSpec, StreamProcessEngine},
    protocol::{AgentKind, ExecutionRequest},
    runner::{AgentEngine, EventSink, ExecutionOutcome},
};

pub use agno::build_agno_options;
pub use claude_code::build_claude_command;
pub(crate) use claude_code::{claude_config_dir, claude_task_dir, model_id, prompt_text};
use claude_code::{
    configure_claude_file_edit_hooks, deploy_claude_task_skills, restore_claude_plugin_cache,
    run_pre_execute_hook,
};
pub use claude_options::{extract_claude_options, ClaudeOptions};
pub use codex::{
    run_codex_app_server_turn, CodexAppServerClient, CodexAppServerEngine, CodexAppServerTurn,
    CodexCancellationState, CodexNotificationSender, CodexTurnInterrupter,
};
pub use dify::{build_dify_config, saved_dify_task_id, DifyEngine};
pub use image_validator::ImageValidatorEngine;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCommandPlanner {
    claude_binary: String,
    codex_binary: String,
}

impl AgentCommandPlanner {
    pub fn new(claude_binary: impl Into<String>, codex_binary: impl Into<String>) -> Self {
        Self {
            claude_binary: claude_binary.into(),
            codex_binary: codex_binary.into(),
        }
    }

    pub fn from_env() -> Self {
        Self::new(resolve_claude_binary(), resolve_codex_binary())
    }

    pub fn command_for(&self, request: &ExecutionRequest) -> Result<CommandSpec, String> {
        match request.resolved_agent_kind() {
            AgentKind::ClaudeCode => Ok(build_claude_command(request, &self.claude_binary)),
            AgentKind::CodeX => Ok(build_codex_app_server_command(&self.codex_binary)),
            agent_kind => Err(format!("unsupported agent kind: {agent_kind:?}")),
        }
    }
}

pub fn resolve_codex_binary() -> String {
    read_binary("CODEX_BINARY_PATH", "CODEX_BIN", "codex")
}

pub fn build_codex_app_server_command(binary: &str) -> CommandSpec {
    CommandSpec::new(binary).arg("app-server").arg("--stdio")
}

fn resolve_claude_binary() -> String {
    read_binary("CLAUDE_BINARY_PATH", "CLAUDE_BIN", "claude")
}

fn read_binary(primary: &str, secondary: &str, default: &str) -> String {
    env::var(primary)
        .ok()
        .or_else(|| env::var(secondary).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_owned())
}

#[derive(Debug, Clone)]
pub struct AgentProcessEngine {
    planner: AgentCommandPlanner,
}

impl AgentProcessEngine {
    pub fn new(planner: AgentCommandPlanner) -> Self {
        Self { planner }
    }
}

impl AgentEngine for AgentProcessEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture {
        let planner = self.planner.clone();
        Box::pin(async move {
            let agent_kind = request.resolved_agent_kind();
            let mut fields = task_fields(request.task_id, request.subtask_id);
            fields.push(("agent", format!("{agent_kind:?}")));
            log_executor_event("agent dispatch", &fields);

            match agent_kind {
                AgentKind::CodeX => {
                    runtime_capabilities::prepare_codex_runtime(&request).await;
                    CodexAppServerEngine::new(planner.codex_binary)
                        .run(request)
                        .await
                }
                AgentKind::Dify => DifyEngine::new().run(request).await,
                AgentKind::ImageValidator => ImageValidatorEngine.run(request).await,
                _ => {
                    let request = if agent_kind == AgentKind::ClaudeCode {
                        let request =
                            runtime_capabilities::prepare_claude_execution_request(request).await;
                        match git_workspace::prepare_git_workspace(request).await {
                            Ok(request) => request,
                            Err(message) => {
                                let mut failed_fields = fields.clone();
                                failed_fields.push(("error_len", message.len().to_string()));
                                log_executor_event(
                                    "git workspace preparation failed",
                                    &failed_fields,
                                );
                                return ExecutionOutcome::Failed { message };
                            }
                        }
                    } else {
                        request
                    };
                    match planner.command_for(&request) {
                        Ok(mut spec) => {
                            let mut command_fields = fields.clone();
                            command_fields.push(("program", spec.program().to_owned()));
                            command_fields.push(("arg_count", spec.args().len().to_string()));
                            if let Some(cwd) = spec.current_dir() {
                                command_fields.push(("cwd", cwd.display().to_string()));
                            }
                            log_executor_event("command planned", &command_fields);
                            if request.resolved_agent_kind() == AgentKind::ClaudeCode {
                                spec = runtime_capabilities::prepare_claude_runtime(&request, spec)
                                    .await
                                    .unwrap_or_else(|error| {
                                        let mut failed_fields =
                                            task_fields(request.task_id, request.subtask_id);
                                        failed_fields.push(("error_len", error.len().to_string()));
                                        log_executor_event(
                                            "claude runtime capability preparation failed",
                                            &failed_fields,
                                        );
                                        build_claude_command(&request, &planner.claude_binary)
                                    });
                                restore_claude_plugin_cache(&request, &spec);
                                deploy_claude_task_skills(&request, &spec).await;
                                configure_claude_file_edit_hooks(&request, &spec);
                                git_auth::setup_git_authentication(&request).await;
                                run_pre_execute_hook(&request, &spec).await;
                            }
                            StreamProcessEngine::new(spec).run(request).await
                        }
                        Err(message) => {
                            let mut failed_fields = fields;
                            failed_fields.push(("error_len", message.len().to_string()));
                            log_executor_event("command planning failed", &failed_fields);
                            ExecutionOutcome::Failed { message }
                        }
                    }
                }
            }
        })
    }

    fn run_with_events<S>(
        &self,
        request: ExecutionRequest,
        sink: S,
        builder: ResponsesEventBuilder,
    ) -> Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>
    where
        S: EventSink,
    {
        let planner = self.planner.clone();
        Box::pin(async move {
            let agent_kind = request.resolved_agent_kind();
            let mut fields = task_fields(request.task_id, request.subtask_id);
            fields.push(("agent", format!("{agent_kind:?}")));
            log_executor_event("agent dispatch", &fields);

            match agent_kind {
                AgentKind::CodeX => {
                    runtime_capabilities::prepare_codex_runtime(&request).await;
                    CodexAppServerEngine::new(planner.codex_binary)
                        .run(request)
                        .await
                }
                AgentKind::Dify => DifyEngine::new().run(request).await,
                AgentKind::ImageValidator => ImageValidatorEngine.run(request).await,
                _ => {
                    let request = if agent_kind == AgentKind::ClaudeCode {
                        let request =
                            runtime_capabilities::prepare_claude_execution_request(request).await;
                        match git_workspace::prepare_git_workspace(request).await {
                            Ok(request) => request,
                            Err(message) => {
                                let mut failed_fields = fields.clone();
                                failed_fields.push(("error_len", message.len().to_string()));
                                log_executor_event(
                                    "git workspace preparation failed",
                                    &failed_fields,
                                );
                                return ExecutionOutcome::Failed { message };
                            }
                        }
                    } else {
                        request
                    };
                    match planner.command_for(&request) {
                        Ok(mut spec) => {
                            let mut command_fields = fields.clone();
                            command_fields.push(("program", spec.program().to_owned()));
                            command_fields.push(("arg_count", spec.args().len().to_string()));
                            if let Some(cwd) = spec.current_dir() {
                                command_fields.push(("cwd", cwd.display().to_string()));
                            }
                            log_executor_event("command planned", &command_fields);
                            if request.resolved_agent_kind() == AgentKind::ClaudeCode {
                                spec = runtime_capabilities::prepare_claude_runtime(&request, spec)
                                    .await
                                    .unwrap_or_else(|error| {
                                        let mut failed_fields =
                                            task_fields(request.task_id, request.subtask_id);
                                        failed_fields.push(("error_len", error.len().to_string()));
                                        log_executor_event(
                                            "claude runtime capability preparation failed",
                                            &failed_fields,
                                        );
                                        build_claude_command(&request, &planner.claude_binary)
                                    });
                                restore_claude_plugin_cache(&request, &spec);
                                deploy_claude_task_skills(&request, &spec).await;
                                configure_claude_file_edit_hooks(&request, &spec);
                                git_auth::setup_git_authentication(&request).await;
                                run_pre_execute_hook(&request, &spec).await;
                            }
                            StreamProcessEngine::new(spec)
                                .run_with_events(request, sink, builder)
                                .await
                        }
                        Err(message) => {
                            let mut failed_fields = fields;
                            failed_fields.push(("error_len", message.len().to_string()));
                            log_executor_event("command planning failed", &failed_fields);
                            ExecutionOutcome::Failed { message }
                        }
                    }
                }
            }
        })
    }
}
