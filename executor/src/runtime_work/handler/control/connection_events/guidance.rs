//! Deliver a matching event to the running native turn when it can accept input.
use super::*;
use crate::runtime_work::stand_in_task_permissions::task_permissions;

impl RuntimeWorkRpcHandler {
    pub(super) async fn steer_connection_event(
        &self,
        id: &str,
        record: &mut Value,
        link: &RuntimeTaskLink,
        context: &ControlContext,
    ) -> Result<bool, AppIpcError> {
        let task = &link.local_task_id;
        if record["native_guidance"] == "requested" {
            record["status"] = json!("needs_attention");
            record["error_code"] = json!("guidance_receipt_unknown");
            self.save_event_subscription(id, record)?;
            return Ok(true);
        }
        // An event needs its own turn on tasks with owner-configured permissions.
        if task_permissions(link).is_some()
            || !is_codex_runtime(&link.runtime)
            || !(self.is_busy_local_task(task) || self.native_task_holds_capacity(task))
        {
            return Ok(false);
        }
        let gate = self.task_send_gate(task);
        let _send_guard = gate.lock().await;
        let operation = record["operation_id"].as_str().unwrap().to_owned();
        let mut request = context.request.clone();
        request.prompt = record["continuation"].clone();
        request.extra.insert(
            "resource_event_keys".into(),
            record["resource_event_keys"].clone(),
        );
        if let Some(receipt) = self.prepare_resource_event_request(task, &mut request)? {
            mark_event_delivered(record, Some(&receipt["commandId"]));
            self.save_event_subscription(id, record)?;
            return Ok(true);
        }
        let display = event_user_message_presentation(record);
        let mut presentation = display.clone();
        presentation["clientUserMessageId"] = json!(operation);
        self.store.update_task(task, |link| {
            append_runtime_handle_user_message_presentation(&mut link.runtime_handle, presentation);
        });
        let facts = prompt_text(&request.prompt);
        let mut guidance_context = ExecutionRequest::default();
        let thread = runtime_session_id_from_link(link)
            .ok_or_else(|| invalid("Event conversation has no native session"))?;
        self.append_connection_event_context(task, &thread, &mut guidance_context)
            .await;
        let additional_context = guidance_context
            .extra
            .remove("additionalContext")
            .unwrap_or_else(|| json!({}));
        record["native_guidance"] = json!("requested");
        record["guided_event_keys"] = request.extra["resource_event_keys"].clone();
        self.save_event_subscription(id, record)?;

        let conversation_context = self
            .runtime_task_is_private_discussion(task)
            .then_some("private_discussion");
        let result = self
            .send_guidance_with_context(
                json!({
                    "taskId": task,
                    "message": facts,
                        "clientGuidanceId": operation,
                    "conversationContext": conversation_context,
                    "additionalContext": additional_context,
                }),
                Some(&operation),
                false,
            )
            .await;
        match result {
            Err(error) if error.code == "user_input_pending" => {
                record["native_guidance"] = Value::Null;
                self.save_event_subscription(id, record)?;
            }
            Ok(result) if result["code"] == "no_active_turn" => {
                record["native_guidance"] = Value::Null;
                self.save_event_subscription(id, record)?;
                return Ok(false);
            }
            Ok(result) if result["accepted"] == true => {
                record["native_guidance"] = json!("accepted");
                mark_event_delivered(record, None);
                self.save_event_subscription(id, record)?;
            }
            _ => {
                record["status"] = json!("needs_attention");
                record["error_code"] = json!("guidance_receipt_unknown");
                self.save_event_subscription(id, record)?;
            }
        }
        Ok(true)
    }
}
