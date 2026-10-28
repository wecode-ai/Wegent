//! Heap boundaries between RPC selection and polling of individual request futures.

use super::*;
use crate::runtime_work::{connection_cli, connection_host, connection_mcp, local_connector_auth};

impl RuntimeWorkRpcHandler {
    pub(super) fn dispatch_request<'a>(
        &'a self,
        method: &'a str,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        // Keep the dispatcher frame off the stack while a selected request is polled.
        match method {
            "runtime.stand_in.telemetry.configure"
            | "runtime.stand_in.telemetry.list"
            | "runtime.stand_in.telemetry.ack" => {
                Box::pin(async move { self.stand_in_telemetry_rpc(method, payload) })
            }
            "runtime.stand_in.list" => {
                Box::pin(async move { self.list_stand_in_settings(payload).await })
            }
            "runtime.stand_in.personal.get" => {
                Box::pin(async move { self.personal_stand_in_settings(payload, false) })
            }
            "runtime.stand_in.personal.agents" => {
                Box::pin(async move { self.personal_stand_in_agents(payload).await })
            }
            "runtime.stand_in.personal.save" => {
                Box::pin(async move { self.personal_stand_in_settings(payload, true) })
            }
            "runtime.stand_in.conversation" => {
                Box::pin(async move { self.stand_in_conversation(payload).await })
            }
            "runtime.stand_in.memory.list" => {
                Box::pin(async move { self.stand_in_memory(payload, "list") })
            }
            "runtime.stand_in.memory.save" => {
                Box::pin(async move { self.stand_in_memory(payload, "save") })
            }
            "runtime.stand_in.memory.delete" => {
                Box::pin(async move { self.stand_in_memory(payload, "delete") })
            }
            "runtime.stand_in.proposal.get" => {
                Box::pin(async move { self.stand_in_proposal(payload, false) })
            }
            "runtime.stand_in.proposal.resolve" => {
                Box::pin(async move { self.stand_in_proposal(payload, true) })
            }
            "runtime.connections.host" => {
                Box::pin(async move { self.configure_connection_host(payload) })
            }
            "runtime.connections.catalog" => {
                Box::pin(async move { self.connection_call("catalog", None, payload).await })
            }
            "runtime.connections.dependencies.inventory" => Box::pin(async move {
                self.handle_codex_app_server_rpc(
                    json!({"method":"plugin/installed","params":{"cwds":[]}}),
                )
                .await
            }),
            "runtime.connections.resources" => Box::pin(async move {
                self.connection_call(
                    "listResources",
                    payload["providerId"].as_str(),
                    payload.clone(),
                )
                .await
            }),
            "runtime.connections.dependencies.install" => Box::pin(async move {
                self.connection_call(
                    "installDependencies",
                    payload["providerId"].as_str(),
                    payload.clone(),
                )
                .await
            }),
            "runtime.connections.mcp" => Box::pin(async move {
                let mut payload = payload;
                let provider = string_field(&payload, "providerId")
                    .ok_or_else(|| AppIpcError::new("bad_request", "providerId is required"))?;
                let declaration = connection_host::declared_dependency(
                    &provider,
                    &payload["source"],
                    payload["dependencyAlias"].as_str(),
                )?;
                payload["readTools"] = declaration["readTools"].clone();
                connection_mcp::request(self.codex_app_server.clone(), payload).await
            }),
            "runtime.connections.cli" => Box::pin(async move {
                let provider = string_field(&payload, "providerId")
                    .ok_or_else(|| AppIpcError::new("bad_request", "providerId is required"))?;
                let declaration = connection_host::declared_dependency(
                    &provider,
                    &payload["source"],
                    payload["dependencyAlias"].as_str(),
                )?;
                connection_cli::request(
                    &self.codex_app_server,
                    payload,
                    declaration["cliReadTools"].clone(),
                )
                .await
            }),
            "runtime.stand_in.work.list" => {
                Box::pin(async move { self.list_connection_stand_in_work(payload) })
            }
            "runtime.stand_in.work.messages" => {
                Box::pin(async move { self.connection_stand_in_messages(payload) })
            }
            "runtime.stand_in.work.run" => {
                Box::pin(async move { self.run_connection_stand_in_work(payload).await })
            }
            "runtime.stand_in.work.adjust" => {
                Box::pin(async move { self.adjust_connection_stand_in_work(payload) })
            }
            "runtime.stand_in.work.organize" => {
                Box::pin(async move { self.organize_connection_stand_in_work(payload) })
            }
            "runtime.stand_in.source.retry" => {
                Box::pin(async move { self.retry_connection_source(payload) })
            }
            "runtime.stand_in.get" => {
                Box::pin(async move { self.stand_in_settings(payload, false).await })
            }
            "runtime.stand_in.save" => {
                Box::pin(async move { self.stand_in_settings(payload, true).await })
            }
            "runtime.stand_in.run" => Box::pin(async move { self.run_stand_in(payload).await }),
            "runtime.stand_in.assignment" => Box::pin(async move {
                self.handle_stand_in_assignment(payload).await?;
                Ok(json!({"success":true}))
            }),
            "runtime.mcp_apps.request" => {
                Box::pin(async move { self.mcp_app_request(payload).await })
            }
            "runtime.tasks.list" => Box::pin(async move { self.list_tasks(&payload).await }),
            "runtime.tasks.get" => Box::pin(async move { self.get_task(&payload) }),
            "runtime.tasks.running_count" => Box::pin(async move { Ok(self.running_task_count()) }),
            "runtime.tasks.search" => Box::pin(async move { self.search_tasks(payload).await }),
            "runtime.tasks.transcript" => Box::pin(async move { self.transcript(payload).await }),
            "runtime.tasks.transcript.search" => {
                Box::pin(async move { self.search_transcript(payload).await })
            }
            "runtime.tasks.transcript.sync_status" => {
                Box::pin(async move { self.transcript_sync_status(payload) })
            }
            "runtime.tasks.transcript.export" => {
                Box::pin(async move { self.export_transcript_segment(payload).await })
            }
            "runtime.tasks.transcript.restore" => {
                Box::pin(async move { self.restore_transcript_segments(payload).await })
            }
            "runtime.tasks.transcript.acknowledge" => {
                Box::pin(async move { self.acknowledge_transcript_turn(payload) })
            }
            "runtime.tasks.create" => Box::pin(async move { self.create_task(payload).await }),
            "runtime.collaboration.dispatch" => {
                Box::pin(async move { self.create_collaboration_dispatch(payload).await })
            }
            "runtime.text.generate" => Box::pin(async move { self.generate_text(payload).await }),
            "runtime.text.predict_reply" => {
                Box::pin(async move { self.predict_reply(payload).await })
            }
            "runtime.text.cancel" => Box::pin(async move { self.cancel_text_generation(payload) }),
            "runtime.tasks.fork_at_turn" => {
                Box::pin(async move { self.fork_task_at_turn(payload).await })
            }
            "runtime.tasks.send" => Box::pin(async move { self.send_message(payload).await }),
            "runtime.tasks.interrupt_and_send" => {
                Box::pin(async move { self.interrupt_and_send(payload).await })
            }
            "runtime.tasks.rollback" => Box::pin(async move { self.rollback_task(payload).await }),
            "runtime.tasks.guidance" => Box::pin(async move { self.send_guidance(payload).await }),
            "runtime.tasks.compact" => Box::pin(async move { self.compact_task(payload).await }),
            "runtime.tasks.background_terminals.clean" => {
                Box::pin(async move { self.clean_background_terminals(payload).await })
            }
            "runtime.tasks.prepare_fork_transfer" => {
                Box::pin(async move { self.prepare_fork_transfer(payload).await })
            }
            "runtime.tasks.import_fork" => Box::pin(async move { self.import_fork(payload).await }),
            "runtime.tasks.archive" => Box::pin(async move { self.archive_task(payload).await }),
            "runtime.tasks.rename" => Box::pin(async move { self.rename_task(payload).await }),
            "runtime.tasks.cancel" => Box::pin(async move { self.cancel_task(payload).await }),
            "runtime.tasks.force_start" => {
                Box::pin(async move { self.force_start_task(payload).await })
            }
            "runtime.tasks.queue.reorder" => {
                Box::pin(async move { self.reorder_queued_task(payload).await })
            }
            "runtime.automations.list" => Box::pin(async move { self.list_automations().await }),
            "runtime.automations.get" => {
                Box::pin(async move { self.get_automation(payload).await })
            }
            "runtime.automations.create" => {
                Box::pin(async move { self.create_automation(payload).await })
            }
            "runtime.automations.update" => {
                Box::pin(async move { self.update_automation(payload).await })
            }
            "runtime.automations.delete" => {
                Box::pin(async move { self.delete_automation(payload).await })
            }
            "runtime.automations.toggle" => {
                Box::pin(async move { self.toggle_automation(payload).await })
            }
            "runtime.automations.run_now" => {
                Box::pin(async move { self.run_automation_now(payload).await })
            }
            "runtime.automation_runs.list" => {
                Box::pin(async move { self.list_automation_runs(payload).await })
            }
            "runtime.tasks.goal.get" => Box::pin(async move { self.get_task_goal(payload).await }),
            "runtime.tasks.goal.set" => Box::pin(async move { self.set_task_goal(payload).await }),
            "runtime.tasks.goal.clear" => {
                Box::pin(async move { self.clear_task_goal(payload).await })
            }
            "runtime.tasks.supervisor.get" => {
                Box::pin(async move { self.get_task_supervisor(payload).await })
            }
            "runtime.tasks.supervisor.set" => {
                Box::pin(async move { self.set_task_supervisor(payload).await })
            }
            "runtime.tasks.supervisor.clear" => {
                Box::pin(async move { self.clear_task_supervisor(payload).await })
            }
            "runtime.tasks.supervisor.run_now" => {
                Box::pin(async move { self.run_task_supervisor_now(payload).await })
            }
            "runtime.tasks.supervisor.resolve" => {
                Box::pin(async move { self.resolve_task_supervisor(payload).await })
            }
            "runtime.keybindings.get" => Box::pin(async move { self.get_keybindings().await }),
            "runtime.keybindings.update" => {
                Box::pin(async move { self.update_keybindings(payload).await })
            }
            "runtime.settings.get" => Box::pin(async move { self.get_runtime_settings().await }),
            "runtime.settings.update" => {
                Box::pin(async move { self.update_runtime_settings(payload).await })
            }
            "runtime.capacity.get" => Box::pin(async move { self.get_runtime_capacity().await }),
            "runtime.hooks.list" | "runtime.hooks.reload" => {
                Box::pin(async move { Ok(json!({"plugins": self.hook_service.list()})) })
            }
            "runtime.hooks.create" => Box::pin(async move { self.create_hook(payload).await }),
            "runtime.hooks.install" => Box::pin(async move { self.install_hook(payload).await }),
            "runtime.hooks.update" => Box::pin(async move { self.update_hook(payload).await }),
            "runtime.hooks.set_enabled" => {
                Box::pin(async move { self.set_hook_enabled(payload).await })
            }
            "runtime.hooks.delete" => Box::pin(async move { self.delete_hook(payload).await }),
            "runtime.hooks.reveal" => Box::pin(async move { self.reveal_hook(payload).await }),
            "runtime.hooks.test" => Box::pin(async move { self.test_hook(payload).await }),
            "runtime.runner.catalog" => Box::pin(async move { self.runner_catalog().await }),
            "runtime.codex.models.list" => {
                Box::pin(async move { self.list_codex_models(payload).await })
            }
            "runtime.codex.ensure_started" => {
                Box::pin(async move { self.ensure_codex_started().await })
            }
            "runtime.codex.auth.read" => Box::pin(async move { self.read_codex_account().await }),
            "runtime.codex.accounts.list" => {
                Box::pin(async move { self.list_codex_accounts().await })
            }
            "runtime.codex.accounts.switch" => {
                Box::pin(async move { self.switch_codex_account(payload).await })
            }
            "runtime.codex.auth.login.start" => {
                Box::pin(async move { self.start_codex_login().await })
            }
            "runtime.codex.auth.login.cancel" => {
                Box::pin(async move { self.cancel_codex_login(payload).await })
            }
            "runtime.codex.catalog.custom.write" => {
                Box::pin(async move { self.write_custom_codex_catalog(payload).await })
            }
            "runtime.codex.catalog.overrides.read" => {
                Box::pin(async move { self.read_codex_model_overrides(payload).await })
            }
            "runtime.codex.catalog.overrides.write" => {
                Box::pin(async move { self.write_codex_model_override(payload).await })
            }
            "runtime.codex.catalog.overrides.delete" => {
                Box::pin(async move { self.delete_codex_model_override(payload).await })
            }
            "runtime.codex.instructions.read" => {
                Box::pin(async move { self.read_codex_instructions().await })
            }
            "runtime.codex.instructions.write" => {
                Box::pin(async move { self.write_codex_instructions(payload).await })
            }
            "runtime.codex.personality.read" => {
                Box::pin(async move { self.read_codex_personality().await })
            }
            "runtime.codex.personality.write" => {
                Box::pin(async move { self.write_codex_personality(payload).await })
            }
            "runtime.codex.plugin.install_local_first" => {
                Box::pin(async move { self.install_local_plugin(payload).await })
            }
            "runtime.codex.plugin.sync_bundled" => {
                Box::pin(async move { self.sync_bundled_plugin(payload).await })
            }
            "runtime.codex.plugin.uninstall_local" => {
                Box::pin(async move { self.uninstall_local_plugin(payload).await })
            }
            "runtime.codex.plugin.reconcile_bundled_marketplace" => {
                Box::pin(async move { self.reconcile_bundled_plugin_marketplace(payload).await })
            }
            "runtime.codex.rate_limits.read" => {
                Box::pin(async move { self.read_codex_rate_limits().await })
            }
            "runtime.codex.runtime_config.update" => {
                Box::pin(async move { self.update_codex_runtime_config(payload).await })
            }
            "runtime.codex.app_server.restart" => {
                Box::pin(async move { self.restart_codex_app_server(payload).await })
            }
            "runtime.codex.app_server.request" => {
                Box::pin(async move { self.handle_codex_app_server_rpc(payload).await })
            }
            "runtime.codex.stream_debug.get" => {
                Box::pin(async move { self.get_codex_stream_debug().await })
            }
            "runtime.codex.stream_debug.set" => {
                Box::pin(async move { self.set_codex_stream_debug(payload).await })
            }
            "runtime.harness_proxy.register" => {
                Box::pin(async move { self.register_harness_proxy(payload).await })
            }
            "runtime.harness_proxy.unregister" => {
                Box::pin(async move { self.unregister_harness_proxy(payload).await })
            }
            "runtime.decision_proxy.register" => {
                Box::pin(async move { self.register_decision_proxy(payload).await })
            }
            "runtime.decision_proxy.unregister" => {
                Box::pin(async move { self.unregister_decision_proxy(payload).await })
            }
            "runtime.harness_context.register" => {
                Box::pin(async move { self.register_harness_context(payload).await })
            }
            "runtime.harness_context.unregister" => {
                Box::pin(async move { self.unregister_harness_context(payload).await })
            }
            "runtime.connectors.configure" => {
                Box::pin(async move { self.connectors.configure(payload).await })
            }
            "runtime.connectors.clear" => {
                Box::pin(async move { self.connectors.clear(payload).await })
            }
            "runtime.connectors.status" => Box::pin(async move { self.connectors.status().await }),
            "runtime.connectors.tools" => Box::pin(async move { self.connectors.tools().await }),
            "runtime.connectors.call" => {
                Box::pin(async move { self.connectors.call(payload).await })
            }
            "runtime.connectors.apps.sync" => {
                Box::pin(async move { self.connectors.sync_apps(payload).await })
            }
            "runtime.local_connector_auth.health" => {
                Box::pin(async move { local_connector_auth::health(payload).await })
            }
            "runtime.local_connector_auth.start" => {
                Box::pin(async move { local_connector_auth::start(payload).await })
            }
            "runtime.local_connector_auth.poll" => {
                Box::pin(async move { local_connector_auth::poll(payload).await })
            }
            "runtime.local_connector_auth.cancel" => {
                Box::pin(async move { local_connector_auth::cancel(payload).await })
            }
            "runtime.local_connector_auth.logout" => {
                Box::pin(async move { local_connector_auth::logout(payload).await })
            }
            "runtime.archived_conversations.list" => {
                Box::pin(async move { self.list_archived_conversations(payload).await })
            }
            "runtime.archived_conversations.unarchive" => {
                Box::pin(async move { self.unarchive_task(payload).await })
            }
            "runtime.archived_conversations.delete" => {
                Box::pin(async move { self.delete_archived_task(payload).await })
            }
            "runtime.archived_conversations.delete_bulk" => {
                Box::pin(async move { self.delete_archived_tasks_bulk(payload).await })
            }
            "runtime.archived_conversations.cleanup_preview" => {
                Box::pin(async move { self.preview_archived_conversation_cleanup(payload).await })
            }
            "runtime.archived_conversations.cleanup" => {
                Box::pin(async move { self.cleanup_archived_conversations(payload).await })
            }
            "runtime.archived_conversations.archive_project" => {
                Box::pin(async move { self.archive_project_conversations(payload).await })
            }
            "runtime.archived_conversations.archive_all" => {
                Box::pin(async move { self.archive_all_conversations().await })
            }
            "runtime.worktrees.capabilities" => {
                Box::pin(async move { self.get_worktree_capabilities().await })
            }
            "runtime.worktrees.preflight" => {
                Box::pin(async move { self.preflight_worktree(payload).await })
            }
            "runtime.worktrees.settings.get" => {
                Box::pin(async move { self.get_worktree_settings().await })
            }
            "runtime.worktrees.settings.update" => {
                Box::pin(async move { self.update_worktree_settings(payload).await })
            }
            "runtime.worktrees.prepare" => {
                Box::pin(async move { self.prepare_worktree(payload).await })
            }
            "runtime.worktrees.list" => Box::pin(async move { self.list_worktrees().await }),
            "runtime.worktrees.delete" => {
                Box::pin(async move { self.delete_worktree(payload).await })
            }
            "runtime.worktrees.apply_issue_cleanup" => {
                Box::pin(async move { self.apply_issue_worktree_cleanup(payload).await })
            }
            "runtime.worktrees.restore" => {
                Box::pin(async move { self.restore_worktree(payload).await })
            }
            "runtime.worktrees.prune" => Box::pin(async move { self.prune_worktrees().await }),
            "runtime.workspaces.open" => {
                Box::pin(async move { self.open_workspace(payload).await })
            }
            "runtime.projects.upsert_local" => {
                Box::pin(async move { self.upsert_local_project(payload).await })
            }
            "runtime.workspaces.rename" => {
                Box::pin(async move { self.rename_workspace(payload).await })
            }
            "runtime.workspaces.remove" => {
                Box::pin(async move { self.remove_workspace(payload).await })
            }
            "runtime.composer.catalog.read" => {
                Box::pin(async move { self.read_composer_catalog(payload).await })
            }
            "runtime.workspace.search" => {
                Box::pin(async move { self.search_workspace(payload).await })
            }
            "runtime.sidebar.projects.reorder" => {
                Box::pin(async move { self.reorder_sidebar_projects(payload).await })
            }
            "runtime.sidebar.projects.pin" => {
                Box::pin(async move { self.pin_sidebar_project(payload).await })
            }
            "runtime.sidebar.projects.appearance" => {
                Box::pin(async move { self.set_sidebar_project_appearance(payload).await })
            }
            "runtime.sidebar.projects.sync_remote" => {
                Box::pin(async move { self.sync_sidebar_remote_projects(payload).await })
            }
            "runtime.sidebar.projects.activate" => {
                Box::pin(async move { self.activate_sidebar_project(payload).await })
            }
            "runtime.sidebar.tasks.reorder" => {
                Box::pin(async move { self.reorder_sidebar_project_task(payload).await })
            }
            "runtime.sidebar.tasks.pin" => {
                Box::pin(async move { self.pin_sidebar_task(payload).await })
            }
            unsupported => Box::pin(async move {
                Err(AppIpcError::new(
                    "unsupported_method",
                    format!("Unsupported runtime RPC method: {unsupported}"),
                ))
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_dispatch_future_does_not_embed_request_futures() {
        let handler = RuntimeWorkRpcHandler::new("windows", "unused");
        let future = handler.dispatch("runtime.stand_in.assignment", json!({}));
        let bytes = std::mem::size_of_val(&future);
        assert!(
            bytes <= 8192,
            "RPC dispatcher future occupies {bytes} bytes"
        );
        for method in [
            "runtime.stand_in.assignment",
            "runtime.stand_in.run",
            "runtime.tasks.create",
            "runtime.tasks.send",
            "runtime.local_connector_auth.health",
            "runtime.local_connector_auth.logout",
        ] {
            let request = handler.dispatch_request(method, json!({}));
            assert_eq!(
                std::mem::size_of_val(&request),
                std::mem::size_of::<Pin<Box<dyn Future<Output = ()>>>>(),
                "{method} must keep its request future behind a heap boundary"
            );
        }
        eprintln!("RPC dispatcher future: {bytes} bytes");
        let server = crate::local::app_ipc::AppIpcServer::new();
        eprintln!(
            "App IPC dispatcher future: {} bytes",
            std::mem::size_of_val(&server.dispatch("runtime.stand_in.assignment", json!({})))
        );
    }

    #[test]
    fn rpc_dispatch_preserves_errors_on_windows_sized_worker_stack() {
        const CHILD: &str = "WEGENT_TEST_RPC_STACK_CHILD";
        if std::env::var(CHILD).as_deref() != Ok("1") {
            let root = tempfile::tempdir().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "runtime_work::handler::dispatch::tests::rpc_dispatch_preserves_errors_on_windows_sized_worker_stack",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .env("WEGENT_TEST_RPC_STACK_ROOT", root.path())
                .current_dir(root.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "RPC worker child exited {}:\n{}\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let root = std::env::var("WEGENT_TEST_RPC_STACK_ROOT").unwrap();
        std::env::set_var("WEGENT_EXECUTOR_HOME", root);
        std::thread::Builder::new()
            .name("rpc-windows-worker-stack".into())
            .stack_size(2 * 1024 * 1024)
            .spawn(|| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                let handler = RuntimeWorkRpcHandler::new("windows", "unused");
                handler
                    .startup_recovery_deferred
                    .store(true, Ordering::Release);
                runtime.block_on(async {
                    let result = handler
                        .handle_runtime_rpc(json!({
                            "method": "runtime.tasks.create",
                            "payload": {"schemaVersion": 3}
                        }))
                        .await;
                    assert_eq!(result.unwrap_err().code, "unsupported_schema_version");
                    let result = handler
                        .handle_runtime_rpc(json!({"method": "unsupported.test.method"}))
                        .await;
                    assert_eq!(result.unwrap_err().code, "unsupported_method");
                    let result = handler
                        .handle_runtime_rpc(json!({"method": "runtime.stand_in.assignment"}))
                        .await;
                    assert_eq!(result.unwrap(), json!({"success": true}));
                    exercise_assigned_issue().await;
                });
            })
            .unwrap()
            .join()
            .unwrap();
    }

    async fn exercise_assigned_issue() {
        use axum::{routing::get, Json, Router};

        let bindings = Arc::new(Mutex::new(Vec::<Value>::new()));
        let saved = bindings.clone();
        let existing = bindings.clone();
        let router = Router::new()
            .route("/api/users/me", get(|| async { Json(json!({"id": 7})) }))
            .route("/api/v1/loop-items/issue", get(|| async {
                Json(json!({"id":"issue","title":"Assigned Issue","cloud_project_id":"project","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}}))
            }))
            .route("/api/v1/loop-items/issue/assignments", get(|| async {
                Json(json!({"items":[{"id":"assignment","status":"active","created_at":"2099-01-01T00:00:00Z"}]}))
            }))
            .route("/api/v1/loop-items/issue/tasks", get(move || {
                let rows = existing.lock().unwrap().clone();
                async move { Json(json!(rows)) }
            }).post(move |Json(binding): Json<Value>| {
                saved.lock().unwrap().push(binding);
                async { Json(json!({"id":1})) }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
        let root = PathBuf::from(std::env::var("WEGENT_TEST_RPC_STACK_ROOT").unwrap());
        let mut handler =
            RuntimeWorkRpcHandler::new("windows", root.join("missing-codex").to_string_lossy());
        handler.store = RuntimeWorkStore::new(root.join("runtime-index.json"));
        handler.worktrees = WorktreeManager::new(root.join("worktrees.json"));
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.codex_app_server = handler
            .codex_app_server
            .for_home(root.join("codex"))
            .unwrap();
        handler
            .startup_recovery_deferred
            .store(true, Ordering::Release);
        handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url,
            auth_token: "unit-test-token".into(),
            ..Default::default()
        })));
        LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap()
            .save_stand_in_settings("project", 7, json!({"projectStore":"cloud","enabled":true,"prompt":"Review","executionDeviceId":"windows","version":0}))
            .unwrap();
        let ipc =
            crate::local::app_ipc::AppIpcServer::new().with_runtime_work_handler(handler.clone());
        let line = json!({"type":"request","id":"assignment-stack-test","method":"runtime.stand_in.assignment","params":{"projectId":"project","itemId":"issue","assignmentId":"assignment","recipientUserId":7}}).to_string();
        let result = ipc.handle_line(&line).await.unwrap();
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(bindings.lock().unwrap().len(), 1);
        assert!(handler.local_task_link("stand-in-human-default").is_some());
        server.abort();
    }
}
