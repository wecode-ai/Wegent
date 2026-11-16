//! Background memory writes are bound to a live scheduled run and readable evidence.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;

pub(super) fn memory_review_save_result(
    result: Result<Value, crate::task_runtime::TaskRuntimeError>,
) -> Result<Value, AppIpcError> {
    match result {
        Ok(memory) => Ok(memory),
        Err(crate::task_runtime::TaskRuntimeError::MemorySuppressed) => Ok(json!({
            "saved":false,"status":"suppressed","reason":"forgotten_or_corrected",
            "message":"Respect the user's correction or forgetting. Do not retry or paraphrase this old evidence."
        })),
        Err(error) => Err(super::stand_in::settings_error(error)),
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn memory_review_run_has_work(
        &self,
        store: &LocalTaskStore,
        run: &crate::runtime_work::automations::AutomationRun,
    ) -> Result<bool, AppIpcError> {
        let current = match self.current_arrangement(run) {
            Ok(current) => current,
            Err(error) => {
                self.automation_store
                    .mark_needs_attention(&run.id, error.message)
                    .map_err(|error| AppIpcError::new("calendar_store_error", error))?;
                return Ok(false);
            }
        };
        let user = current.task_request["standInOwner"]["userId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("permission_denied", "Missing memory review owner"))?;
        if self.memory_review_has_pending_sources(
            user,
            run.scheduled_for.timestamp_millis(),
            store,
        )? {
            return Ok(true);
        }
        self.automation_store
            .settle_coordinated_run(&run.id, AutomationRunStatus::Succeeded, None, None)
            .map_err(|error| AppIpcError::new("calendar_store_error", error))?;
        self.emit_automation_runs_changed(&current.id, &run.id);
        Ok(false)
    }

    pub(super) fn memory_review_has_pending_sources(
        &self,
        user: i64,
        through: i64,
        store: &LocalTaskStore,
    ) -> Result<bool, AppIpcError> {
        for link in self.local_task_links(true) {
            if !super::stand_in_history::history_owned(&link, user)
                || link.runtime_handle["origin"]["memoryReview"] == true
                || self.archived_link_is_deleted(&link)
                || (link.created_at != 0 && link.created_at >= through)
                || !self.memory_review_source_visible(&link, user, store)
            {
                continue;
            }
            let progress = store
                .memory_review_progress(user, &link.local_task_id)
                .map_err(super::stand_in::settings_error)?;
            if link.updated_at == 0
                || link.updated_at >= progress["completedThrough"].as_i64().unwrap_or(0)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(super) fn ensure_memory_review_arrangements(&self) -> Result<(), AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        for settings in store
            .all_personal_stand_ins(&self.device_id)
            .map_err(super::stand_in::settings_error)?
        {
            if settings["executionDeviceId"] != self.device_id
                || !settings["lifecycle"]["status"].is_null()
                || settings["primary"]["enabled"] == false
            {
                continue;
            }
            let Some(user) = settings["userId"].as_i64().filter(|user| *user >= 0) else {
                continue;
            };
            if self
                .automation_store
                .ensure_stand_in_memory_review(user, &self.device_id)
                .map_err(|error| AppIpcError::new("automation_store_error", error))?
            {
                self.emit_automations_changed(&format!("stand-in-memory-review-{user}"), "created");
            }
        }
        Ok(())
    }

    pub(super) async fn remember_from_conversation(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let denied = || {
            AppIpcError::new(
                "permission_denied",
                "Memory review evidence is no longer authorized",
            )
        };
        if !identity.memory_review || identity.review || identity.readonly_worker {
            return Err(denied());
        }
        let task_id = super::stand_in_tasks::required(args, "taskId")?;
        let gate = self.task_send_gate(&format!("memory-source:{}:{task_id}", identity.user));
        let _guard = gate.lock().await;
        // Reading through the existing bounded-history path revalidates account,
        // device, scope and the opaque page cursor before accepting any evidence.
        let page = self
            .read_stand_in_conversations(identity, "read_task", args)
            .await?;
        let message_id = super::stand_in_tasks::required(args, "messageId")?;
        let excerpt = super::stand_in_tasks::required(args, "excerpt")?;
        if excerpt.len() > 2000 {
            return Err(AppIpcError::new(
                "bad_request",
                "Evidence excerpt exceeds 2000 bytes",
            ));
        }
        let chunk = json!({"id":page["messageId"],"content":page["content"],"role":page["role"],"createdAt":page["createdAt"]});
        let message = page["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(std::iter::once(&chunk))
            .find(|message| {
                message["id"] == message_id
                    && message["content"]
                        .as_str()
                        .is_some_and(|text| text.contains(excerpt))
            })
            .ok_or_else(denied)?;
        self.save_task_memory_evidence(
            identity,
            args,
            json!({
                "taskId":task_id,"messageId":message_id,"role":message["role"],
                "observedAt":message["createdAt"],"excerpt":excerpt
            }),
        )
    }

    // Callers hold the source gate and construct evidence only after validating
    // its exact content. Scope, authority and durable-write rules are shared.
    pub(super) fn save_task_memory_evidence(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
        evidence: Value,
    ) -> Result<Value, AppIpcError> {
        let denied = || {
            AppIpcError::new(
                "permission_denied",
                "Memory evidence is no longer authorized",
            )
        };
        let task_id = super::stand_in_tasks::required(args, "taskId")?;
        let actor = self.local_task_link(&identity.task_id).ok_or_else(denied)?;
        self.scheduled_review_run_end(&actor, identity.user, true)?;
        let run = actor.runtime_handle["executionRequest"]["standInSchedule"]["runId"]
            .as_str()
            .ok_or_else(denied)?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let link = self.local_task_link(task_id).ok_or_else(denied)?;
        self.validate_history_delivery(identity, &link, &store)?;
        let origin = &link.runtime_handle["origin"];
        let scope = if let Some(work_id) = origin["workId"].as_str() {
            let work = store
                .stand_in_work(identity.user, work_id)
                .map_err(super::stand_in::settings_error)?;
            crate::task_runtime::personal_stand_in::connection_memory_scope(&work["source"])
        } else if origin["cloudProjectId"].is_string() {
            json!({"kind":"project","id":origin["cloudProjectId"],"store":origin["projectStore"]})
        } else if let Some(role) = origin["standInId"]
            .as_str()
            .filter(|role| *role != "@primary")
        {
            json!({"kind":"role","roleId":role})
        } else {
            json!({"kind":"personal"})
        };
        if let Some(id) = args["id"].as_str() {
            let previous = store
                .stand_in_memories(identity.user)
                .map_err(super::stand_in::settings_error)?;
            if !previous
                .iter()
                .any(|row| row["id"] == id && row["scope"] == scope)
            {
                return Err(denied());
            }
        }
        let memory = json!({"id":args["id"],"version":args["version"],"content":args["content"],
            "scope":scope,"sourceTaskId":task_id,"evidence":evidence});
        // Persist intent before saving. Failed writes and process interruption
        // must not allow a fully read source to advance its watermark.
        use sha2::{Digest, Sha256};
        let write_id = format!(
            "{:x}",
            Sha256::digest(
                json!([
                    args["id"],
                    args["content"],
                    evidence["messageId"],
                    evidence["excerpt"]
                ])
                .to_string()
            )
        );
        store
            .record_memory_review_write(identity.user, task_id, run, &write_id, true)
            .map_err(super::stand_in::settings_error)?;
        let saved = memory_review_save_result(store.save_stand_in_memory(
            identity.user,
            &self.device_id,
            memory,
        ))?;
        store
            .record_memory_review_write(identity.user, task_id, run, &write_id, false)
            .map_err(super::stand_in::settings_error)?;
        Ok(saved)
    }
}
