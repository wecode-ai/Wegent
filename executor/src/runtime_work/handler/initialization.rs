//! Runtime handler construction and background-service startup.
use super::*;

impl RuntimeWorkRpcHandler {
    pub fn new(device_id: impl Into<String>, codex_binary: impl Into<String>) -> Self {
        Self::with_optional_event_sender(
            device_id,
            codex_binary,
            None,
            Arc::new(Mutex::new(None)),
            None,
        )
    }

    pub(super) fn with_optional_event_sender(
        device_id: impl Into<String>,
        codex_binary: impl Into<String>,
        event_tx: Option<broadcast::Sender<Value>>,
        backend_connection: Arc<Mutex<Option<ConnectionConfig>>>,
        backend_device_route: Option<Arc<Mutex<Option<String>>>>,
    ) -> Self {
        let codex_binary = codex_binary.into();
        let device_id = normalize_device_id(device_id.into());
        let (archived_delete_tx, archived_delete_rx) = mpsc::unbounded_channel();
        let codex_app_server = CodexAppServerClient::new(codex_binary);
        let runtime_settings = system::read_runtime_settings();
        let store = RuntimeWorkStore::from_env();
        let worktrees = WorktreeManager::from_env(&device_id);
        let turn_queue_path = turns::runtime_turn_queue_path();
        let mut persisted_turns =
            turns::read_runtime_turn_state(&turn_queue_path).unwrap_or_else(|error| {
                log_executor_event("runtime turn queue restore failed", &[("error", error)]);
                turns::RuntimeTurnQueueState::default()
            });
        for command in persisted_turns.commands.values_mut() {
            if command.is_owner_abandoned()
                || matches!(
                    command.state,
                    command_journal::CommandState::Dispatching
                        | command_journal::CommandState::Started
                )
            {
                command.state = command_journal::CommandState::RecoveryRequired;
            }
        }
        persisted_turns.active_goal_turns.retain(|task, turn| {
            let Some(id) = turn
                .request
                .extra
                .get("runtime_command_id")
                .and_then(Value::as_str)
            else {
                return true;
            };
            let Some(command) = persisted_turns
                .commands
                .get(&command_journal::key(task, id))
            else {
                return false;
            };
            if command.is_owner_abandoned()
                || matches!(
                    command.state,
                    command_journal::CommandState::Cancelled
                        | command_journal::CommandState::Failed
                )
            {
                return false;
            }
            let known_native = command.native.is_some()
                || store
                    .read_task(task, |link| {
                        link.runtime_handle["turnIdsBySubtask"][&turn.request.subtask_id]
                            .is_string()
                    })
                    .unwrap_or(false);
            command.state != command_journal::CommandState::RecoveryRequired || known_native
        });
        let active_goal_turns = persisted_turns.active_goal_turns.clone();
        let command_journal = persisted_turns.commands;
        for turn in persisted_turns.active_goal_turns.values_mut() {
            turn.initial_thread_goal = None;
            turn.request.prompt = Value::String(String::new());
            // Goal continuation is not a resubmission of its original user command.
            turn.request.extra.remove("runtime_command_id");
            turn.request.extra.remove("runtime_command_input");
            turn.request
                .extra
                .insert(RESUME_GOAL_ONLY_MARKER.to_owned(), Value::Bool(true));
        }
        let mut queued_turns = persisted_turns.queued_turns;
        let mut restored_inputs = queued_turns
            .iter()
            .map(|turn| (turn.local_task_id.clone(), turn.request.subtask_id.clone()))
            .collect::<HashSet<_>>();
        queued_turns.extend(
            persisted_turns
                .active_goal_turns
                .into_values()
                .filter(|turn| {
                    restored_inputs
                        .insert((turn.local_task_id.clone(), turn.request.subtask_id.clone()))
                })
                .filter(|turn| {
                    turn.request
                        .extra
                        .get(GOAL_NEEDS_ATTENTION_MARKER)
                        .and_then(Value::as_bool)
                        != Some(true)
                }),
        );
        for turn in &mut queued_turns {
            turn.bind_task_kind(&store);
            turn.request
                .extra
                .insert(RESTORED_TURN_MARKER.to_owned(), Value::Bool(true));
        }
        let restored_turn_count = queued_turns.len();
        let restore_startup_concurrency =
            restore_startup_concurrency(runtime_settings.total_limit());
        if restored_turn_count > 0 {
            log_executor_event(
                "runtime persisted turn startup ramp configured",
                &[
                    ("restored_turn_count", restored_turn_count.to_string()),
                    (
                        "restore_startup_concurrency",
                        restore_startup_concurrency.to_string(),
                    ),
                ],
            );
        }
        let removed_worktree_turn_count =
            turns::remove_worktree_turns_after_restart(&worktrees, &mut queued_turns);
        if removed_worktree_turn_count > 0 {
            log_executor_event(
                "persisted worktree turns removed after executor restart",
                &[("count", removed_worktree_turn_count.to_string())],
            );
        }
        let handler = Self {
            #[cfg(test)]
            transcript_test_workers: None,
            device_id,
            connectors: ConnectorRuntime::new(codex_app_server.clone()),
            codex_app_server,
            claude_process_engine: AgentProcessEngine::new(AgentCommandPlanner::from_env()),
            codex_runtime_proxy_config: Arc::new(AsyncMutex::new(
                CodexRuntimeProxyConfig::default(),
            )),
            startup_recovery_deferred: Arc::new(AtomicBool::new(false)),
            bundled_plugin_marketplace_reconciliation: Arc::new(AsyncMutex::new(())),
            event_tx,
            next_execution_id: Arc::new(AtomicU64::new(1)),
            task_send_gates: Arc::new(Mutex::new(HashMap::new())),
            stand_in_lifecycle_gate: Arc::new(Mutex::new(())),
            turn_scheduler: Arc::new(Mutex::new(RuntimeTurnScheduler::new(
                runtime_settings,
                queued_turns,
            ))),
            active_goal_turns: Arc::new(Mutex::new(active_goal_turns)),
            command_journal: Arc::new(Mutex::new(command_journal)),
            restore_startup_semaphore: Arc::new(Semaphore::new(restore_startup_concurrency)),
            turn_queue_operation: Arc::new(AsyncMutex::new(())),
            turn_queue_path: Arc::new(turn_queue_path),
            preparing_worktree_turns: Arc::new(Mutex::new(HashMap::new())),
            active_local_executions: Arc::new(Mutex::new(HashMap::new())),
            active_text_generations: Arc::new(Mutex::new(HashMap::new())),
            active_codex_transcript_items: Arc::new(Mutex::new(HashMap::new())),
            codex_transcript_navigation_cache: Arc::new(Mutex::new(HashMap::new())),
            active_request_user_inputs: Arc::new(Mutex::new(HashMap::new())),
            supervisor_evaluating: Arc::new(Mutex::new(HashSet::new())),
            supervisor_model_configs: Arc::new(Mutex::new(HashMap::new())),
            runtime_model_configs: Arc::new(Mutex::new(HashMap::new())),
            creation_model_profiles: Arc::new(Mutex::new(Vec::new())),
            submitted_model_bindings: Arc::new(Mutex::new(HashMap::new())),
            local_runner_models: Arc::new(Mutex::new(Vec::new())),
            active_collaboration_rounds: Arc::new(Mutex::new(HashSet::new())),
            thread_event_routing: Arc::new(Mutex::new(RuntimeThreadEventRouting::default())),
            codex_notification_delivery: Arc::new(Mutex::new(())),
            notification_router: Arc::new(Mutex::new(None)),
            local_issue_scheduler_started: Arc::new(AtomicBool::new(false)),
            archived_delete_tx,
            automation_store: AutomationStore::new(
                crate::runtime_work::store::runtime_work_dir().join("automations.json"),
            ),
            task_store_path: Arc::new(LocalTaskStore::default_path()),
            store,
            worktrees,
            worktree_reconciliation_state: Arc::new(AsyncMutex::new(
                WorktreeReconciliationState::default(),
            )),
            worktree_cleanup_generation: Arc::new(AtomicU64::new(0)),
            opened_workspace_roots: Arc::new(Mutex::new(HashSet::new())),
            hook_service: HookService::new(
                crate::hooks::registry::HookRegistryStore::from_env(),
                crate::agents::wework_codex_home(),
            ),
            backend_connection,
            backend_device_route,
        };
        for (local_task_id, turn) in handler
            .active_goal_turns
            .lock()
            .expect("active Goal turn map lock should not be poisoned")
            .iter()
        {
            handler.set_goal_execution_status(
                local_task_id,
                if turn
                    .request
                    .extra
                    .get(GOAL_NEEDS_ATTENTION_MARKER)
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    Some("needsAttention")
                } else {
                    Some("recovering")
                },
            );
        }
        handler.reconcile_command_recovery();
        handler.spawn_archived_delete_worker(archived_delete_rx);
        crate::workbench_control::register(&handler.device_id, Arc::new(handler.clone()));
        handler
    }

    pub fn with_event_sender(
        device_id: impl Into<String>,
        codex_binary: impl Into<String>,
        event_tx: broadcast::Sender<Value>,
    ) -> Self {
        Self::with_event_sender_and_backend_connection(
            device_id,
            codex_binary,
            event_tx,
            None,
            None,
        )
    }

    pub fn with_event_sender_and_backend_connection(
        device_id: impl Into<String>,
        codex_binary: impl Into<String>,
        event_tx: broadcast::Sender<Value>,
        backend_connection: Option<Arc<Mutex<Option<ConnectionConfig>>>>,
        backend_device_route: Option<Arc<Mutex<Option<String>>>>,
    ) -> Self {
        let handler = Self::with_event_sender_deferred_startup_recovery(
            device_id,
            codex_binary,
            event_tx,
            backend_connection,
            backend_device_route,
        );
        handler
            .startup_recovery_deferred
            .store(false, Ordering::Release);
        handler.spawn_startup_worktree_reconciliation();
        handler
    }

    pub fn with_event_sender_deferred_startup_recovery(
        device_id: impl Into<String>,
        codex_binary: impl Into<String>,
        event_tx: broadcast::Sender<Value>,
        backend_connection: Option<Arc<Mutex<Option<ConnectionConfig>>>>,
        backend_device_route: Option<Arc<Mutex<Option<String>>>>,
    ) -> Self {
        let has_backend = backend_connection.is_some();
        let handler = Self::with_optional_event_sender(
            device_id,
            codex_binary,
            Some(event_tx),
            backend_connection.unwrap_or_else(|| Arc::new(Mutex::new(None))),
            backend_device_route,
        );
        if let Some(sender) = handler.event_tx.clone() {
            crate::task_runtime::mcp_http::register_runtime_event_sender(sender.clone());
            handler.hook_service.set_event_sender(sender);
        }
        handler
            .startup_recovery_deferred
            .store(true, Ordering::Release);
        handler.start_automation_scheduler();
        handler.start_local_issue_scheduler();
        if has_backend {
            handler.start_backend_services();
        }
        handler
    }

    #[cfg(test)]
    pub fn with_backend_device_route(mut self, route: Arc<Mutex<Option<String>>>) -> Self {
        self.backend_device_route = Some(route);
        self
    }

    #[cfg(test)]
    pub fn with_backend_connection(
        mut self,
        backend_connection: Arc<Mutex<Option<ConnectionConfig>>>,
    ) -> Self {
        self.backend_connection = backend_connection;
        self.start_backend_services();
        self
    }

    pub(super) fn start_backend_services(&self) {
        crate::workbench_control::register(&self.device_id, Arc::new(self.clone()));
        self.start_local_stand_in_scheduler();
        self.start_connection_stand_in_scheduler();
        self.register_cloud_collaboration_dispatcher();
        self.register_stand_in_task_dispatcher();
        self.resume_cloud_collaboration_rounds();
        for link in self.local_task_links(false) {
            self.sync_issue_human_requests(&link.local_task_id);
            self.sync_stand_in_issue_replies(&link.local_task_id);
        }
        self.start_supervisor_scheduler();
    }
}
