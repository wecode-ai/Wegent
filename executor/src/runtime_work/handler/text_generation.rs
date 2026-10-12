use super::*;

struct TextGenerationGuard {
    requests: Arc<Mutex<HashMap<String, Option<oneshot::Sender<()>>>>>,
    task_id: String,
}

impl Drop for TextGenerationGuard {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(&self.task_id);
        }
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn cancel_text_generation(&self, payload: Value) -> Result<Value, AppIpcError> {
        let task_id = runtime_task_id(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let sender = self
            .active_text_generations
            .lock()
            .map_err(|_| {
                AppIpcError::new("internal_error", "text generation registry unavailable")
            })?
            .get_mut(&task_id)
            .and_then(Option::take);
        let cancelled = sender.is_some_and(|sender| sender.send(()).is_ok());
        Ok(json!({"success": true, "cancelled": cancelled}))
    }

    pub(super) async fn generate_text(&self, payload: Value) -> Result<Value, AppIpcError> {
        let mut request = execution_request(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "executionRequest is required"))?;
        request.ephemeral = true;
        let local_task_id = request.task_id.clone();
        let stream_request = request.clone();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        {
            let mut active = self.active_text_generations.lock().map_err(|_| {
                AppIpcError::new("internal_error", "text generation registry unavailable")
            })?;
            if active.contains_key(&local_task_id) {
                return Err(AppIpcError::new(
                    "generation_busy",
                    "text generation already running",
                ));
            }
            active.insert(local_task_id.clone(), Some(cancel_tx));
        }
        let _guard = TextGenerationGuard {
            requests: self.active_text_generations.clone(),
            task_id: local_task_id.clone(),
        };
        let (notification_tx, mut notification_rx) = mpsc::unbounded_channel::<Value>();
        let mut turn_future = Box::pin(self.codex_app_server.run_turn_with_cancel(
            request,
            CodexAppServerTurnOptions {
                notifications: Some(notification_tx),
                cancellation: Some(cancel_rx),
                ..CodexAppServerTurnOptions::default()
            },
        ));
        let mut mapper = CodexNotificationEventMapper::default();
        let result = loop {
            tokio::select! {
                result = &mut turn_future => break result,
                message = notification_rx.recv() => {
                    let Some(message) = message else { break turn_future.await; };
                    mapper.map(&self.event_tx, &self.device_id, &local_task_id, &stream_request, message);
                }
            }
        };
        while let Ok(message) = notification_rx.try_recv() {
            mapper.map(
                &self.event_tx,
                &self.device_id,
                &local_task_id,
                &stream_request,
                message,
            );
        }
        match result
            .map_err(|error| AppIpcError::new("model_transport_failed", error))?
            .outcome
        {
            ExecutionOutcome::Completed { content } => Ok(json!({"content": content})),
            ExecutionOutcome::Failed { message } => {
                Err(AppIpcError::new("model_request_failed", message))
            }
            outcome => Err(AppIpcError::new(
                "model_request_incomplete",
                format!("text generation did not complete: {outcome:?}"),
            )),
        }
    }
}
