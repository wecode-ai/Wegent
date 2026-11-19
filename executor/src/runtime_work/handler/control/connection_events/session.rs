//! A logical conversation may close a native session while a source is waiting.
use super::*;

fn unavailable() -> AppIpcError {
    AppIpcError::new(
        "native_session_unavailable",
        "The original conversation session is unavailable",
    )
}

fn changed() -> AppIpcError {
    AppIpcError::new(
        "native_session_changed",
        "The original conversation session was closed or replaced",
    )
}

fn engine(link: &RuntimeTaskLink) -> Option<&'static str> {
    if is_claude_runtime(&link.runtime) {
        Some("ClaudeCode")
    } else if is_codex_runtime(&link.runtime) {
        Some("Codex")
    } else {
        None
    }
}

pub(super) fn binding(link: &RuntimeTaskLink) -> Result<Value, AppIpcError> {
    let engine = engine(link).ok_or_else(unavailable)?;
    let id = if engine == "ClaudeCode" {
        let mut request = runtime_event_request_from_link(link);
        request.new_session = false;
        crate::agent_session::load_saved_session_id(&request)
    } else {
        runtime_session_id_from_link(link)
    };
    let id = id.filter(|id| !id.is_empty()).ok_or_else(unavailable)?;
    Ok(json!({"engine":engine,"id":id}))
}

pub(super) fn validate(record: &Value, link: &RuntimeTaskLink) -> Result<(), AppIpcError> {
    let expected = &record["session"];
    if expected["engine"].as_str().is_none() || expected["id"].as_str().map_or(true, str::is_empty)
    {
        return Err(invalid("Event wait has no original native session binding"));
    }
    if expected["engine"].as_str() != engine(link) {
        return Err(changed());
    }
    if binding(link)? != *expected {
        return Err(changed());
    }
    Ok(())
}

impl RuntimeWorkRpcHandler {
    pub(in crate::runtime_work::handler) fn validate_event_input_session(
        &self,
        task: &str,
        operation: Option<&str>,
        link: &RuntimeTaskLink,
    ) -> Result<(), AppIpcError> {
        let operation =
            operation.ok_or_else(|| invalid("Source input has no durable event operation"))?;
        let records = event_store::read(
            &self.event_subscription_path(),
            event_store::Scope::Task(task),
            |state| {
                Ok(state["operations"]
                    .as_object()
                    .into_iter()
                    .flat_map(|records| records.iter())
                    .filter(|(_, record)| {
                        record["task_id"] == task && record["operation_id"] == operation
                    })
                    .map(|(id, record)| (id.clone(), record.clone()))
                    .collect::<Vec<_>>())
            },
        )?;
        if records.len() != 1 {
            return Err(invalid(
                "Source input has no unique durable native session binding",
            ));
        }
        for (id, mut record) in records {
            if record["status"] == "cancelled" {
                return Err(AppIpcError::new(
                    "subscription_cancelled",
                    "The event wait was cancelled before execution",
                ));
            }
            if let Err(error) = validate(&record, link) {
                if error.code == "native_session_changed" {
                    record["status"] = json!("cancelled");
                    record["error_code"] = json!(error.code);
                    self.save_event_subscription(&id, &record)?;
                }
                return Err(error);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_work::handler::control::tests::{seed, EnvGuard};

    #[test]
    fn durable_source_input_cannot_bypass_a_missing_subscription_journal() {
        let _lock = crate::test_env::lock();
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        let link = seed(&handler, "caller");
        let path = handler.event_subscription_path();
        handler.save_event_subscription("wait",&json!({"task_id":"caller","status":"delivered","operation_id":"source-operation","session":binding(&link).unwrap(),"source":{"name":"Review"}})).unwrap();
        let mut request = ExecutionRequest::default();
        request
            .extra
            .insert("resource_event_keys".into(), json!(["a".repeat(64)]));
        request
            .extra
            .insert("client_user_message_id".into(), json!("source-operation"));
        let checkpoint = handler
            .automatic_input_admission("caller", &request)
            .unwrap();
        checkpoint().unwrap();
        event_store::transact(&path, |state| {
            state["operations"].as_object_mut().unwrap().remove("wait");
            Ok(())
        })
        .unwrap();
        assert!(
            checkpoint().is_err(),
            "missing authority is not an ordinary input permit"
        );
        handler.store.update_task("caller", |link| {
            link.thread_id = Some("replacement-thread".into())
        });
        assert!(
            checkpoint().is_err(),
            "recovery must not bind a lost wait to the new session"
        );
        request.extra.remove("client_user_message_id");
        assert!(handler
            .automatic_input_admission("caller", &request)
            .unwrap()()
        .is_err());
        request.extra.remove("resource_event_keys");
        request.extra.insert("standInAutomatic".into(), json!(true));
        handler
            .automatic_input_admission("caller", &request)
            .unwrap()()
        .unwrap();
    }

    #[test]
    fn original_event_wait_cannot_wake_a_replacement_native_session() {
        let _lock = crate::test_env::lock();
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let root=tempfile::tempdir().unwrap();
            let _env=EnvGuard::home(root.path().to_str().unwrap());
            let handler=RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
            let mut link=seed(&handler,"caller");
            link.runtime_handle["origin"]=json!({"type":"stand_in_identity","userId":7});
            let original=binding(&link).unwrap();
            let record=json!({"task_id":"caller","subscription_key":"wait","status":"armed","session":original,"source":{"name":"Review"},"waiting_goal":null});
            handler.save_event_subscription("wait",&record).unwrap();
            assert!(crate::runtime_work::conversation_sessions::bind_thread(&mut link,"replacement-thread",now_ms()));
            handler.store.upsert_task(link);
            handler.collect_conversation_subscription("wait",record).await.unwrap();
            let saved=event_store::transact(&handler.event_subscription_path(),|state|Ok(state["operations"]["wait"].clone())).unwrap();
            assert_eq!(saved["status"],"cancelled");
            assert_eq!(saved["error_code"],"native_session_changed");
            assert_eq!(saved["session"],original);
            assert!(handler.command_journal.lock().unwrap().is_empty());
            assert_eq!(handler.store.get_task_summary("caller").unwrap().thread_id.as_deref(),Some("replacement-thread"));
        });
    }

    #[test]
    fn a_queued_source_is_rechecked_at_the_actual_input_checkpoint() {
        let _lock = crate::test_env::lock();
        let root = tempfile::tempdir().unwrap();
        let _env = EnvGuard::home(root.path().to_str().unwrap());
        let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
        let link = seed(&handler, "caller");
        handler.save_event_subscription("wait",&json!({"task_id":"caller","subscription_key":"wait","status":"delivered","operation_id":"source-operation","session":binding(&link).unwrap(),"source":{"name":"Review"}})).unwrap();
        let mut request = ExecutionRequest::default();
        request
            .extra
            .insert("resource_event_keys".into(), json!(["a".repeat(64)]));
        request
            .extra
            .insert("client_user_message_id".into(), json!("source-operation"));
        let admit = handler
            .automatic_input_admission("caller", &request)
            .unwrap();
        admit().unwrap();
        handler.store.update_task("caller", |link| {
            link.thread_id = Some("replacement-thread".into())
        });
        assert!(
            admit().is_err(),
            "a durable queued command cannot be redirected after its original session closes"
        );
        let saved = event_store::transact(&handler.event_subscription_path(), |state| {
            Ok(state["operations"]["wait"].clone())
        })
        .unwrap();
        assert_eq!(saved["status"], "cancelled");
        assert_eq!(saved["error_code"], "native_session_changed");
    }
}
