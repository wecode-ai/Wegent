// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

// Build the selected future outside the dispatcher: debug builds otherwise reserve
// stack temporaries for every branch even though only one route executes.
#[inline(never)]
fn boxed_rpc<'a, F, Fut>(
    operation: F,
) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Value, AppIpcError>> + Send + 'a,
{
    Box::pin(operation())
}

impl RuntimeWorkRpcHandler {
    // Separate poll functions keep unrelated RPC branches off each worker's stack.
    pub(super) fn dispatch_method<'a>(
        &'a self,
        method: &'a str,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        match method {
            "runtime.stand_in.telemetry.configure"
            | "runtime.stand_in.telemetry.list"
            | "runtime.stand_in.telemetry.ack" => {
                boxed_rpc(move || async move { self.stand_in_telemetry_rpc(method, payload) })
            }
            "runtime.stand_in.list" => {
                boxed_rpc(move || async move { self.list_stand_in_settings(payload).await })
            }
            "runtime.stand_in.personal.get" => {
                boxed_rpc(
                    move || async move { self.personal_stand_in_settings(payload, false).await },
                )
            }
            "runtime.stand_in.personal.agents" => {
                boxed_rpc(move || async move { self.personal_stand_in_agents(payload).await })
            }
            "runtime.stand_in.personal.save" => {
                boxed_rpc(
                    move || async move { self.personal_stand_in_settings(payload, true).await },
                )
            }
            "runtime.stand_in.conversation" => {
                boxed_rpc(move || async move { self.stand_in_conversation(payload).await })
            }
            "runtime.project_coordinator.conversation" => {
                boxed_rpc(
                    move || async move { self.project_coordinator_conversation(payload).await },
                )
            }
            "runtime.stand_in.processing.status" => {
                boxed_rpc(move || async move { self.stand_in_processing_status(payload) })
            }
            "runtime.stand_in.processing.check" => {
                boxed_rpc(move || async move { self.check_stand_in_processing(payload).await })
            }
            "runtime.stand_in.memory.list" => {
                boxed_rpc(move || async move { self.stand_in_memory(payload, "list") })
            }
            "runtime.stand_in.memory.save" => {
                boxed_rpc(move || async move { self.stand_in_memory(payload, "save") })
            }
            "runtime.stand_in.memory.delete" => {
                boxed_rpc(move || async move { self.stand_in_memory(payload, "delete") })
            }
            "runtime.stand_in.proposal.get" => {
                boxed_rpc(move || async move { self.stand_in_proposal(payload, false).await })
            }
            "runtime.stand_in.proposal.resolve" => {
                boxed_rpc(move || async move { self.stand_in_proposal(payload, true).await })
            }
            "runtime.connections.host" => {
                boxed_rpc(move || async move { self.configure_connection_host(payload) })
            }
            "runtime.connections.catalog" => {
                boxed_rpc(
                    move || async move { self.connection_call("catalog", None, payload).await },
                )
            }
            "runtime.connections.dependencies.inventory" => boxed_rpc(move || async move {
                {
                    self.handle_codex_app_server_rpc(
                        json!({"method":"plugin/installed","params":{"cwds":[]}}),
                    )
                    .await
                }
            }),
            "runtime.connections.resources" => boxed_rpc(move || async move {
                {
                    self.connection_call(
                        "listResources",
                        payload["providerId"].as_str(),
                        payload.clone(),
                    )
                    .await
                }
            }),
            "runtime.connections.dependencies.install" => boxed_rpc(move || async move {
                {
                    self.connection_call(
                        "installDependencies",
                        payload["providerId"].as_str(),
                        payload.clone(),
                    )
                    .await
                }
            }),
            "runtime.connections.mcp" => boxed_rpc(move || async move {
                {
                    let mut payload = payload;
                    let provider = string_field(&payload, "providerId")
                        .ok_or_else(|| AppIpcError::new("bad_request", "providerId is required"))?;
                    let declaration = super::super::connection_host::declared_dependency(
                        &provider,
                        &payload["source"],
                        payload["dependencyAlias"].as_str(),
                    )?;
                    payload["readTools"] = declaration["readTools"].clone();
                    super::super::connection_mcp::request(self.codex_app_server.clone(), payload)
                        .await
                }
            }),
            "runtime.connections.cli" => boxed_rpc(move || async move {
                {
                    let provider = string_field(&payload, "providerId")
                        .ok_or_else(|| AppIpcError::new("bad_request", "providerId is required"))?;
                    let declaration = super::super::connection_host::declared_dependency(
                        &provider,
                        &payload["source"],
                        payload["dependencyAlias"].as_str(),
                    )?;
                    super::super::connection_cli::request(
                        &self.codex_app_server,
                        payload,
                        declaration["cliReadTools"].clone(),
                    )
                    .await
                }
            }),
            "runtime.stand_in.work.list" => {
                boxed_rpc(move || async move { self.list_connection_stand_in_work(payload) })
            }
            "runtime.stand_in.work.messages" => {
                boxed_rpc(move || async move { self.connection_stand_in_messages(payload) })
            }
            "runtime.stand_in.work.run" => {
                boxed_rpc(move || async move { self.run_connection_stand_in_work(payload).await })
            }
            "runtime.stand_in.work.adjust" => {
                boxed_rpc(move || async move { self.adjust_connection_stand_in_work(payload) })
            }
            "runtime.stand_in.work.organize" => {
                boxed_rpc(move || async move { self.organize_connection_stand_in_work(payload) })
            }
            "runtime.stand_in.source.retry" => {
                boxed_rpc(move || async move { self.retry_connection_source(payload) })
            }
            "runtime.stand_in.get" => {
                boxed_rpc(move || async move { self.stand_in_settings(payload, false).await })
            }
            "runtime.stand_in.save" => {
                boxed_rpc(move || async move { self.stand_in_settings(payload, true).await })
            }
            "runtime.stand_in.run" => {
                boxed_rpc(move || async move { self.run_stand_in(payload).await })
            }
            "runtime.stand_in.assignment" => boxed_rpc(move || async move {
                {
                    self.handle_stand_in_assignment(payload).await?;
                    Ok(json!({"success":true}))
                }
            }),
            "runtime.mcp_apps.request" => {
                boxed_rpc(move || async move { self.mcp_app_request(payload).await })
            }
            "runtime.tasks.list" => {
                boxed_rpc(move || async move { self.list_tasks(&payload).await })
            }
            "runtime.tasks.get" => boxed_rpc(move || async move { self.get_task(&payload) }),
            "runtime.tasks.running_count" => {
                boxed_rpc(move || async move { Ok(self.running_task_count()) })
            }
            "runtime.tasks.search" => {
                boxed_rpc(move || async move { self.search_tasks(payload).await })
            }
            "runtime.tasks.transcript" => {
                boxed_rpc(move || async move { self.transcript(payload).await })
            }
            "runtime.tasks.transcript.search" => {
                boxed_rpc(move || async move { self.search_transcript(payload).await })
            }
            "runtime.tasks.transcript.sync_status" => {
                boxed_rpc(move || async move { self.transcript_sync_status(payload) })
            }
            "runtime.tasks.transcript.export" => {
                boxed_rpc(move || async move { self.export_transcript_segment(payload).await })
            }
            "runtime.tasks.transcript.restore" => {
                boxed_rpc(move || async move { self.restore_transcript_segments(payload).await })
            }
            "runtime.tasks.transcript.acknowledge" => {
                boxed_rpc(move || async move { self.acknowledge_transcript_turn(payload) })
            }
            "runtime.tasks.create" => {
                boxed_rpc(move || async move { self.create_task(payload).await })
            }
            "runtime.collaboration.dispatch" => {
                boxed_rpc(move || async move { self.create_collaboration_dispatch(payload).await })
            }
            "runtime.text.generate" => {
                boxed_rpc(move || async move { self.generate_text(payload).await })
            }
            "runtime.text.predict_reply" => {
                boxed_rpc(move || async move { self.predict_reply(payload).await })
            }
            "runtime.text.cancel" => {
                boxed_rpc(move || async move { self.cancel_text_generation(payload) })
            }
            "runtime.tasks.fork_at_turn" => {
                boxed_rpc(move || async move { self.fork_task_at_turn(payload).await })
            }
            "runtime.tasks.send" => {
                boxed_rpc(move || async move { self.send_message(payload).await })
            }
            "runtime.tasks.interrupt_and_send" => {
                boxed_rpc(move || async move { self.interrupt_and_send(payload).await })
            }
            "runtime.tasks.rollback" => {
                boxed_rpc(move || async move { self.rollback_task(payload).await })
            }
            "runtime.tasks.guidance" => {
                boxed_rpc(move || async move { self.send_guidance(payload).await })
            }
            "runtime.tasks.compact" => {
                boxed_rpc(move || async move { self.compact_task(payload).await })
            }
            "runtime.tasks.background_terminals.clean" => boxed_rpc(move || async move {
                {
                    self.clean_background_terminals(payload).await
                }
            }),
            "runtime.tasks.prepare_fork_transfer" => {
                boxed_rpc(move || async move { self.prepare_fork_transfer(payload).await })
            }
            "runtime.tasks.import_fork" => {
                boxed_rpc(move || async move { self.import_fork(payload).await })
            }
            "runtime.tasks.archive" => {
                boxed_rpc(move || async move { self.archive_task(payload).await })
            }
            "runtime.tasks.rename" => {
                boxed_rpc(move || async move { self.rename_task(payload).await })
            }
            "runtime.tasks.cancel" => {
                boxed_rpc(move || async move { self.cancel_task(payload).await })
            }
            "runtime.tasks.force_start" => {
                boxed_rpc(move || async move { self.force_start_task(payload).await })
            }
            "runtime.tasks.queue.reorder" => {
                boxed_rpc(move || async move { self.reorder_queued_task(payload).await })
            }
            "runtime.automations.list" => {
                boxed_rpc(move || async move { self.list_automations().await })
            }
            "runtime.automations.get" => {
                boxed_rpc(move || async move { self.get_automation(payload).await })
            }
            "runtime.automations.create" => {
                boxed_rpc(move || async move { self.create_automation(payload).await })
            }
            "runtime.automations.update" => {
                boxed_rpc(move || async move { self.update_automation(payload).await })
            }
            "runtime.automations.delete" => {
                boxed_rpc(move || async move { self.delete_automation(payload).await })
            }
            "runtime.automations.toggle" => {
                boxed_rpc(move || async move { self.toggle_automation(payload).await })
            }
            "runtime.automations.run_now" => {
                boxed_rpc(move || async move { self.run_automation_now(payload).await })
            }
            "runtime.automation_runs.list" => {
                boxed_rpc(move || async move { self.list_automation_runs(payload).await })
            }
            "runtime.tasks.goal.get" => {
                boxed_rpc(move || async move { self.get_task_goal(payload).await })
            }
            "runtime.tasks.goal.set" => {
                boxed_rpc(move || async move { self.set_task_goal(payload).await })
            }
            "runtime.tasks.goal.clear" => {
                boxed_rpc(move || async move { self.clear_task_goal(payload).await })
            }
            "runtime.tasks.supervisor.get" => {
                boxed_rpc(move || async move { self.get_task_supervisor(payload).await })
            }
            "runtime.tasks.supervisor.set" => {
                boxed_rpc(move || async move { self.set_task_supervisor(payload).await })
            }
            "runtime.tasks.supervisor.clear" => {
                boxed_rpc(move || async move { self.clear_task_supervisor(payload).await })
            }
            "runtime.tasks.supervisor.run_now" => {
                boxed_rpc(move || async move { self.run_task_supervisor_now(payload).await })
            }
            "runtime.tasks.supervisor.resolve" => {
                boxed_rpc(move || async move { self.resolve_task_supervisor(payload).await })
            }
            "runtime.keybindings.get" => {
                boxed_rpc(move || async move { self.get_keybindings().await })
            }
            "runtime.keybindings.update" => {
                boxed_rpc(move || async move { self.update_keybindings(payload).await })
            }
            "runtime.settings.get" => {
                boxed_rpc(move || async move { self.get_runtime_settings().await })
            }
            "runtime.settings.update" => {
                boxed_rpc(move || async move { self.update_runtime_settings(payload).await })
            }
            "runtime.capacity.get" => {
                boxed_rpc(move || async move { self.get_runtime_capacity().await })
            }
            "runtime.hooks.list" | "runtime.hooks.reload" => boxed_rpc(move || async move {
                {
                    Ok(json!({"plugins": self.hook_service.list()}))
                }
            }),
            "runtime.hooks.create" => {
                boxed_rpc(move || async move { self.create_hook(payload).await })
            }
            "runtime.hooks.install" => {
                boxed_rpc(move || async move { self.install_hook(payload).await })
            }
            "runtime.hooks.update" => {
                boxed_rpc(move || async move { self.update_hook(payload).await })
            }
            "runtime.hooks.set_enabled" => {
                boxed_rpc(move || async move { self.set_hook_enabled(payload).await })
            }
            "runtime.hooks.delete" => {
                boxed_rpc(move || async move { self.delete_hook(payload).await })
            }
            "runtime.hooks.reveal" => {
                boxed_rpc(move || async move { self.reveal_hook(payload).await })
            }
            "runtime.hooks.test" => boxed_rpc(move || async move { self.test_hook(payload).await }),
            "runtime.runner.catalog" => {
                boxed_rpc(move || async move { self.runner_catalog().await })
            }
            "runtime.codex.models.list" => {
                boxed_rpc(move || async move { self.list_codex_models(payload).await })
            }
            "runtime.codex.ensure_started" => {
                boxed_rpc(move || async move { self.ensure_codex_started().await })
            }
            "runtime.codex.auth.read" => {
                boxed_rpc(move || async move { self.read_codex_account().await })
            }
            "runtime.codex.accounts.list" => {
                boxed_rpc(move || async move { self.list_codex_accounts().await })
            }
            "runtime.codex.accounts.switch" => {
                boxed_rpc(move || async move { self.switch_codex_account(payload).await })
            }
            "runtime.codex.auth.login.start" => {
                boxed_rpc(move || async move { self.start_codex_login().await })
            }
            "runtime.codex.auth.login.cancel" => {
                boxed_rpc(move || async move { self.cancel_codex_login(payload).await })
            }
            "runtime.codex.catalog.custom.write" => {
                boxed_rpc(move || async move { self.write_custom_codex_catalog(payload).await })
            }
            "runtime.codex.catalog.overrides.read" => boxed_rpc(move || async move {
                {
                    self.read_codex_model_overrides(payload).await
                }
            }),
            "runtime.codex.catalog.overrides.write" => boxed_rpc(move || async move {
                {
                    self.write_codex_model_override(payload).await
                }
            }),
            "runtime.codex.catalog.overrides.delete" => boxed_rpc(move || async move {
                {
                    self.delete_codex_model_override(payload).await
                }
            }),
            "runtime.codex.instructions.read" => {
                boxed_rpc(move || async move { self.read_codex_instructions().await })
            }
            "runtime.codex.instructions.write" => {
                boxed_rpc(move || async move { self.write_codex_instructions(payload).await })
            }
            "runtime.codex.personality.read" => {
                boxed_rpc(move || async move { self.read_codex_personality().await })
            }
            "runtime.codex.personality.write" => {
                boxed_rpc(move || async move { self.write_codex_personality(payload).await })
            }
            "runtime.codex.plugin.install_local_first" => {
                boxed_rpc(move || async move { self.install_local_plugin(payload).await })
            }
            "runtime.codex.plugin.sync_bundled" => {
                boxed_rpc(move || async move { self.sync_bundled_plugin(payload).await })
            }
            "runtime.codex.plugin.uninstall_local" => {
                boxed_rpc(move || async move { self.uninstall_local_plugin(payload).await })
            }
            "runtime.codex.plugin.reconcile_bundled_marketplace" => boxed_rpc(move || async move {
                {
                    self.reconcile_bundled_plugin_marketplace(payload).await
                }
            }),
            "runtime.codex.rate_limits.read" => {
                boxed_rpc(move || async move { self.read_codex_rate_limits().await })
            }
            "runtime.codex.runtime_config.update" => boxed_rpc(move || async move {
                {
                    self.update_codex_runtime_config(payload).await
                }
            }),
            "runtime.codex.app_server.restart" => {
                boxed_rpc(move || async move { self.restart_codex_app_server(payload).await })
            }
            "runtime.codex.app_server.request" => {
                boxed_rpc(move || async move { self.handle_codex_app_server_rpc(payload).await })
            }
            "runtime.codex.stream_debug.get" => {
                boxed_rpc(move || async move { self.get_codex_stream_debug().await })
            }
            "runtime.codex.stream_debug.set" => {
                boxed_rpc(move || async move { self.set_codex_stream_debug(payload).await })
            }
            "runtime.harness_proxy.register" => {
                boxed_rpc(move || async move { self.register_harness_proxy(payload).await })
            }
            "runtime.harness_proxy.unregister" => {
                boxed_rpc(move || async move { self.unregister_harness_proxy(payload).await })
            }
            "runtime.decision_proxy.register" => {
                boxed_rpc(move || async move { self.register_decision_proxy(payload).await })
            }
            "runtime.decision_proxy.unregister" => {
                boxed_rpc(move || async move { self.unregister_decision_proxy(payload).await })
            }
            "runtime.harness_context.register" => {
                boxed_rpc(move || async move { self.register_harness_context(payload).await })
            }
            "runtime.harness_context.unregister" => {
                boxed_rpc(move || async move { self.unregister_harness_context(payload).await })
            }
            "runtime.connectors.configure" => {
                boxed_rpc(move || async move { self.connectors.configure(payload).await })
            }
            "runtime.connectors.clear" => {
                boxed_rpc(move || async move { self.connectors.clear(payload).await })
            }
            "runtime.connectors.status" => {
                boxed_rpc(move || async move { self.connectors.status().await })
            }
            "runtime.connectors.tools" => {
                boxed_rpc(move || async move { self.connectors.tools().await })
            }
            "runtime.connectors.call" => {
                boxed_rpc(move || async move { self.connectors.call(payload).await })
            }
            "runtime.connectors.apps.sync" => {
                boxed_rpc(move || async move { self.connectors.sync_apps(payload).await })
            }
            "runtime.local_connector_auth.health" => boxed_rpc(move || async move {
                {
                    super::super::local_connector_auth::health(payload).await
                }
            }),
            "runtime.local_connector_auth.start" => boxed_rpc(move || async move {
                {
                    super::super::local_connector_auth::start(payload).await
                }
            }),
            "runtime.local_connector_auth.poll" => {
                boxed_rpc(
                    move || async move { super::super::local_connector_auth::poll(payload).await },
                )
            }
            "runtime.local_connector_auth.cancel" => boxed_rpc(move || async move {
                {
                    super::super::local_connector_auth::cancel(payload).await
                }
            }),
            "runtime.local_connector_auth.logout" => boxed_rpc(move || async move {
                {
                    super::super::local_connector_auth::logout(payload).await
                }
            }),
            "runtime.archived_conversations.list" => boxed_rpc(move || async move {
                {
                    self.list_archived_conversations(payload).await
                }
            }),
            "runtime.archived_conversations.unarchive" => {
                boxed_rpc(move || async move { self.unarchive_task(payload).await })
            }
            "runtime.archived_conversations.delete" => {
                boxed_rpc(move || async move { self.delete_archived_task(payload).await })
            }
            "runtime.archived_conversations.delete_bulk" => boxed_rpc(move || async move {
                {
                    self.delete_archived_tasks_bulk(payload).await
                }
            }),
            "runtime.archived_conversations.cleanup_preview" => boxed_rpc(move || async move {
                {
                    self.preview_archived_conversation_cleanup(payload).await
                }
            }),
            "runtime.archived_conversations.cleanup" => boxed_rpc(move || async move {
                {
                    self.cleanup_archived_conversations(payload).await
                }
            }),
            "runtime.archived_conversations.archive_project" => boxed_rpc(move || async move {
                {
                    self.archive_project_conversations(payload).await
                }
            }),
            "runtime.archived_conversations.archive_all" => {
                boxed_rpc(move || async move { self.archive_all_conversations().await })
            }
            "runtime.worktrees.capabilities" => {
                boxed_rpc(move || async move { self.get_worktree_capabilities().await })
            }
            "runtime.worktrees.preflight" => {
                boxed_rpc(move || async move { self.preflight_worktree(payload).await })
            }
            "runtime.worktrees.settings.get" => {
                boxed_rpc(move || async move { self.get_worktree_settings().await })
            }
            "runtime.worktrees.settings.update" => {
                boxed_rpc(move || async move { self.update_worktree_settings(payload).await })
            }
            "runtime.worktrees.prepare" => {
                boxed_rpc(move || async move { self.prepare_worktree(payload).await })
            }
            "runtime.worktrees.list" => {
                boxed_rpc(move || async move { self.list_worktrees().await })
            }
            "runtime.worktrees.delete" => {
                boxed_rpc(move || async move { self.delete_worktree(payload).await })
            }
            "runtime.worktrees.apply_issue_cleanup" => boxed_rpc(move || async move {
                {
                    self.apply_issue_worktree_cleanup(payload).await
                }
            }),
            "runtime.worktrees.restore" => {
                boxed_rpc(move || async move { self.restore_worktree(payload).await })
            }
            "runtime.worktrees.prune" => {
                boxed_rpc(move || async move { self.prune_worktrees().await })
            }
            "runtime.workspaces.open" => {
                boxed_rpc(move || async move { self.open_workspace(payload).await })
            }
            "runtime.projects.upsert_local" => {
                boxed_rpc(move || async move { self.upsert_local_project(payload).await })
            }
            "runtime.workspaces.rename" => {
                boxed_rpc(move || async move { self.rename_workspace(payload).await })
            }
            "runtime.workspaces.remove" => {
                boxed_rpc(move || async move { self.remove_workspace(payload).await })
            }
            "runtime.composer.catalog.read" => {
                boxed_rpc(move || async move { self.read_composer_catalog(payload).await })
            }
            "runtime.workspace.search" => {
                boxed_rpc(move || async move { self.search_workspace(payload).await })
            }
            "runtime.sidebar.projects.reorder" => {
                boxed_rpc(move || async move { self.reorder_sidebar_projects(payload).await })
            }
            "runtime.sidebar.projects.pin" => {
                boxed_rpc(move || async move { self.pin_sidebar_project(payload).await })
            }
            "runtime.sidebar.projects.appearance" => boxed_rpc(move || async move {
                {
                    self.set_sidebar_project_appearance(payload).await
                }
            }),
            "runtime.sidebar.projects.sync_remote" => boxed_rpc(move || async move {
                {
                    self.sync_sidebar_remote_projects(payload).await
                }
            }),
            "runtime.sidebar.projects.activate" => {
                boxed_rpc(move || async move { self.activate_sidebar_project(payload).await })
            }
            "runtime.sidebar.tasks.reorder" => {
                boxed_rpc(move || async move { self.reorder_sidebar_project_task(payload).await })
            }
            "runtime.sidebar.tasks.pin" => {
                boxed_rpc(move || async move { self.pin_sidebar_task(payload).await })
            }
            unsupported => boxed_rpc(move || async move {
                Err(AppIpcError::new(
                    "unsupported_method",
                    format!("Unsupported runtime RPC method: {unsupported}"),
                ))
            }),
        }
    }
}
