//! Run a scoped, tool-free reply decision and verify it again at the channel boundary.
use super::runtime_owner::runtime_user;
use super::stand_in::settings_error;
use super::stand_in_reply_policy::{decision_schema, Proposal, DECISION_INSTRUCTIONS};
use super::*;
use crate::runtime_work::dingtalk::{self, DeliveryIdentity, DeliveryInput};
use crate::task_runtime::personal_stand_in::{
    autonomous_dingtalk_reply, source_provider, stand_in_connection, stand_in_identities,
    DINGTALK_PROVIDER,
};
use chrono::{DateTime, TimeDelta, Utc};

impl RuntimeWorkRpcHandler {
    pub(super) async fn poll_dingtalk_replies(&self) -> Result<(), AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        for settings in store
            .all_personal_stand_ins(&self.device_id)
            .map_err(settings_error)?
        {
            let user = settings["userId"].as_i64().unwrap_or_default();
            if self.verify_local_stand_in_owner(user).is_err() {
                continue;
            }
            let mut works = store
                .list_stand_in_work(user, None)
                .map_err(settings_error)?;
            works.retain(|work| {
                work["status"] == "pending" && autonomous_dingtalk_reply(&work["source"])
            });
            works.sort_by(|a, b| {
                a["latestMessage"]["at"]
                    .as_str()
                    .cmp(&b["latestMessage"]["at"].as_str())
            });
            for work in works {
                if let Err(error) = self
                    .process_pending_dingtalk_replies(&store, user, &settings, &work)
                    .await
                {
                    log_executor_event(
                        "DingTalk reply processing deferred",
                        &[("code", error.code)],
                    );
                }
            }
        }
        Ok(())
    }

    pub(super) async fn refresh_dingtalk_reply_account(
        &self,
        store: &LocalTaskStore,
        user: i64,
        previous: Option<&Value>,
    ) -> Result<(), AppIpcError> {
        if let Ok(result) = self
            .connection_call("check", Some(DINGTALK_PROVIDER), json!({}))
            .await
        {
            let identity = &result["identity"];
            if identity_fields(identity).is_some() && previous != Some(identity) {
                store
                    .save_dingtalk_active_identity(user, identity)
                    .map_err(settings_error)?;
            }
        }
        Ok(())
    }

    async fn process_pending_dingtalk_replies(
        &self,
        store: &LocalTaskStore,
        user: i64,
        settings: &Value,
        work: &Value,
    ) -> Result<(), AppIpcError> {
        let roles = stand_in_identities(settings);
        let Some(role) = roles
            .iter()
            .find(|role| role["id"] == work["roleId"] && self.stand_in_role_runs_here(role))
        else {
            return Ok(());
        };
        let id =
            nonempty(&work["id"]).ok_or_else(|| blocked("bad_request", "Work ID is required"))?;
        let gate = self.task_send_gate(&format!("dingtalk-dispatch:{id}"));
        let _guard = gate.lock().await;
        let work = store.stand_in_work(user, id).map_err(settings_error)?;
        let pending: Vec<_> = store
            .stand_in_messages(user, id)
            .map_err(settings_error)?
            .into_iter()
            .filter(|message| message["dispatchStatus"] == "pending")
            .collect();
        self.dispatch_dingtalk_replies(store, user, &work, settings, role, &pending)
            .await
    }

    pub(super) async fn prepare_dingtalk_reply_bindings(
        &self,
        user: i64,
        settings: &mut Value,
        previous: &Value,
    ) -> Result<(), AppIpcError> {
        let roles = stand_in_identities(previous);
        if let Some(rows) = settings.get_mut("roles").and_then(Value::as_array_mut) {
            for role in rows {
                let old = roles.iter().find(|row| row["id"] == role["id"]);
                self.bind_dingtalk_reply_sources(user, role, old).await?;
            }
        }
        if let Some(primary) = settings.get_mut("primary") {
            let old = roles.iter().find(|row| row["id"] == "@primary");
            self.bind_dingtalk_reply_sources(user, primary, old).await?;
        }
        Ok(())
    }

    async fn bind_dingtalk_reply_sources(
        &self,
        user: i64,
        role: &mut Value,
        previous: Option<&Value>,
    ) -> Result<(), AppIpcError> {
        let enabled = role["enabled"] == true;
        let runs_here = self.stand_in_role_runs_here(role);
        let active_before = previous.filter(|before| {
            before["enabled"] == true && before["executionDeviceId"] == role["executionDeviceId"]
        });
        for source in role
            .get_mut("connections")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if source_provider(source) != DINGTALK_PROVIDER {
                continue;
            }
            if let Some(fields) = source.as_object_mut() {
                fields.remove("replyIdentity");
            }
            if !enabled || !autonomous_dingtalk_reply(source) {
                if let Some(old) = previous.and_then(|role| stand_in_connection(role, source)) {
                    if old["replyIdentity"].is_object() {
                        source["replyIdentity"] = old["replyIdentity"].clone();
                    }
                }
                continue;
            }
            let old = active_before
                .and_then(|role| stand_in_connection(role, source))
                .filter(|source| autonomous_dingtalk_reply(source));
            let identity = if let Some(old) = old.filter(|old| old["replyIdentity"].is_object()) {
                old["replyIdentity"].clone()
            } else {
                if !runs_here {
                    return Err(blocked(
                        "wrong_device",
                        "Enable automatic replies on the selected execution device",
                    ));
                }
                self.verify_local_stand_in_owner(user)?;
                self.connection_call("validate", Some(DINGTALK_PROVIDER), source.clone())
                    .await?["identity"]
                    .clone()
            };
            if identity_fields(&identity).is_none() || nonempty(&identity["openId"]).is_none() {
                return Err(blocked(
                    "identity_unverified",
                    "DingTalk account and organization could not be verified",
                ));
            }
            source["replyIdentity"] = identity;
        }
        Ok(())
    }

    async fn dispatch_dingtalk_replies(
        &self,
        store: &LocalTaskStore,
        user: i64,
        work: &Value,
        settings: &Value,
        role: &Value,
        pending: &[Value],
    ) -> Result<(), AppIpcError> {
        let work_id = work["id"].as_str().unwrap_or_default();
        for message in pending {
            let result = self
                .decide_dingtalk_reply(store, user, work, settings, role, message)
                .await
                .unwrap_or_else(|error| block_result(&error));
            store
                .finish_stand_in_reply(
                    user,
                    work_id,
                    message["recordId"].as_str().unwrap_or_default(),
                    &result,
                )
                .map_err(settings_error)?;
        }
        Ok(())
    }

    async fn decide_dingtalk_reply(
        &self,
        store: &LocalTaskStore,
        user: i64,
        work: &Value,
        settings: &Value,
        role: &Value,
        message: &Value,
    ) -> Result<Value, AppIpcError> {
        let identity = delivery_identity(user, &message["identity"])
            .ok_or_else(|| blocked("identity_unverified", "DingTalk identity is missing"))?;
        if let Some(result) =
            dingtalk::delivery_record(store, &message["source"], message, &identity)?
        {
            return Ok(result);
        }
        if !self.stand_in_role_runs_here(role) || !settings["lifecycle"]["status"].is_null() {
            return Err(blocked(
                "role_paused",
                "The stand-in is paused or runs on another device",
            ));
        }
        let source = active_source(role, message)?;
        ensure_available(work, message, source)?;
        let before = self.inspect_reply_context(source, message).await?;
        let trigger = fresh_trigger(source, message, &before)?;
        let context = before.as_slice();
        let prompt = format!(
            "{DECISION_INSTRUCTIONS}\n{}",
            json!({"trigger":trigger,"context":context})
        );
        let (model_result, model) = self.dingtalk_reply_decision(role, prompt).await?;
        let proposal =
            Proposal::parse(&model_result).map_err(|reason| blocked("decision_invalid", reason))?;
        let reply = match proposal {
            Proposal::NeedsUser { reason } => {
                return Ok(json!({"status":"needs_user","reason":reason}))
            }
            Proposal::Skip { reason } => return Ok(json!({"status":"skipped","reason":reason})),
            Proposal::Reply(reply) => reply,
        };
        if source["policy"]["replyTemplates"]
            .as_array()
            .is_some_and(|templates| !templates.iter().any(|name| name == reply.template()))
        {
            return Err(blocked(
                "template_disabled",
                "This reply template is disabled",
            ));
        }
        let transport = dingtalk::prepare_reply().await?;
        let after = self.inspect_reply_context(source, message).await?;
        let trigger = fresh_trigger(source, message, &after)?;
        if before != after {
            return Err(blocked(
                "context_changed",
                "The original conversation changed",
            ));
        }
        let text = reply
            .grounded_text(trigger, &after)
            .map_err(|reason| blocked("evidence_unverified", reason))?;
        let evidence = json!(reply.evidence_ids());
        let evidence = json!({
            "messageIds":evidence,
            "template":reply.template(),
            "settingsVersion":settings["version"],
            "model":model,
            "decidedAt":Utc::now().to_rfc3339()
        });
        transport
            .reply_once(
                store,
                source,
                message,
                &identity,
                DeliveryInput {
                    text: &text,
                    evidence: &evidence,
                },
                |connection| {
                    self.verify_local_stand_in_owner(user)?;
                    let settings_now = connection
                        .personal_stand_in(user, &self.device_id)
                        .map_err(settings_error)?;
                    if !settings_now["lifecycle"]["status"].is_null() {
                        return Err(blocked("role_paused", "The stand-in is paused"));
                    }
                    let roles = stand_in_identities(&settings_now);
                    let role = roles
                        .iter()
                        .find(|role| {
                            role["id"] == work["roleId"] && self.stand_in_role_runs_here(role)
                        })
                        .ok_or_else(|| blocked("role_removed", "The stand-in role was removed"))?;
                    let source_now = active_source(role, message)?;
                    let (work_now, message_now) = connection
                        .reply_target(
                            user,
                            work["id"].as_str().unwrap_or_default(),
                            message["recordId"].as_str().unwrap_or_default(),
                        )
                        .map_err(settings_error)?;
                    ensure_available(&work_now, &message_now, source_now)?;
                    if settings_now["version"] != settings["version"] || source_now != source {
                        return Err(blocked("settings_changed", "The reply delegation changed"));
                    }
                    Ok(())
                },
            )
            .await
    }

    async fn dingtalk_reply_decision(
        &self,
        role: &Value,
        prompt: String,
    ) -> Result<(Value, Value), AppIpcError> {
        let failed = || {
            blocked(
                "decision_failed",
                "The reply decision could not be completed",
            )
        };
        let request = self
            .prepare_coordination_text_request(
                role.get("model"),
                prompt,
                decision_schema(),
                format!("stand-in-reply-{}", uuid::Uuid::new_v4()),
            )
            .await
            .map_err(|_| failed())?;
        let model = request.model_config["model_id"]
            .as_str()
            .or_else(|| request.model_config["model"].as_str())
            .map(str::to_owned);
        let response = tokio::time::timeout(
            Duration::from_secs(60),
            self.generate_text(json!({"executionRequest":request})),
        )
        .await
        .map_err(|_| failed())?
        .map_err(|_| failed())?;
        let proposal = serde_json::from_str(response["content"].as_str().unwrap_or_default())
            .map_err(|_| failed())?;
        Ok((proposal, json!(model)))
    }

    async fn inspect_reply_context(
        &self,
        source: &Value,
        message: &Value,
    ) -> Result<Vec<Value>, AppIpcError> {
        let at = event_time(message)?;
        let response = self
            .connection_call(
                "inspectConversation",
                Some(DINGTALK_PROVIDER),
                json!({
                    "source":source,
                    "conversationId":message["conversationId"],
                    "start":(at - TimeDelta::minutes(30)).to_rfc3339(),
                    "end":Utc::now().to_rfc3339(),
                    "limit":50
                }),
            )
            .await?;
        if response["identity"] != source["replyIdentity"] {
            return Err(blocked(
                "identity_changed",
                "The DingTalk account or organization changed",
            ));
        }
        if response["complete"] != true || response["conversationId"] != message["conversationId"] {
            return Err(blocked(
                "context_gap",
                "The original conversation could not be verified",
            ));
        }
        response["events"].as_array().cloned().ok_or_else(|| {
            blocked(
                "context_gap",
                "DingTalk did not return verifiable conversation messages",
            )
        })
    }
}

fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| !value.trim().is_empty())
}

fn identity_fields(value: &Value) -> Option<(&str, &str)> {
    Some((
        nonempty(&value["accountId"])?,
        nonempty(&value["organizationId"])?,
    ))
}

fn delivery_identity(user_id: i64, value: &Value) -> Option<DeliveryIdentity<'_>> {
    let (account_id, organization_id) = identity_fields(value)?;
    Some(DeliveryIdentity {
        user_id,
        account_id,
        organization_id,
    })
}

fn event_time(event: &Value) -> Result<DateTime<Utc>, AppIpcError> {
    nonempty(&event["at"])
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|time| time.with_timezone(&Utc))
        .ok_or_else(|| {
            blocked(
                "context_gap",
                "A DingTalk event timestamp could not be verified",
            )
        })
}

fn active_source<'a>(role: &'a Value, message: &Value) -> Result<&'a Value, AppIpcError> {
    if role["enabled"] != true {
        return Err(blocked("role_paused", "The stand-in is paused"));
    }
    stand_in_connection(role, &message["source"])
        .ok_or_else(|| blocked("source_removed", "The selected source was removed"))
        .and_then(|source| {
            autonomous_dingtalk_reply(source)
                .then_some(source)
                .ok_or_else(|| {
                    blocked(
                        "source_paused",
                        "Automatic replies are disabled for this source",
                    )
                })
        })
}

fn ensure_available(work: &Value, message: &Value, source: &Value) -> Result<(), AppIpcError> {
    if !work["takenOverAt"].is_null() || !message["takenOverAt"].is_null() {
        return Err(blocked("taken_over", "The user took over this work"));
    }
    if message["identity"] != source["replyIdentity"] || message["identity"].is_null() {
        return Err(blocked(
            "identity_changed",
            "The DingTalk account or organization changed",
        ));
    }
    let boundary = event_time(&json!({"at":source["enabledAfter"]}))?;
    let at = event_time(message)?;
    if message["source"]["enabledAfter"] != source["enabledAfter"] || at <= boundary {
        return Err(blocked(
            "activation_boundary",
            "The message predates the current delegation",
        ));
    }
    let now = Utc::now();
    let recovery_time = if message["recoveredAt"].is_string() {
        event_time(&json!({"at":message["recoveredAt"]}))?
    } else {
        now
    };
    let window = TimeDelta::minutes(30);
    if at < recovery_time - window || recovery_time < now - window {
        return Err(blocked(
            "recovery_window",
            "The message is outside the reply recovery window",
        ));
    }
    if message["author"] != "other"
        || message["plainText"] != true
        || (source["kind"] == "group" && message["mentionedSelf"] != true)
    {
        return Err(blocked(
            "unsupported_message",
            "The message is outside automatic reply scope",
        ));
    }
    Ok(())
}

fn fresh_trigger<'a>(
    source: &Value,
    message: &Value,
    events: &'a [Value],
) -> Result<&'a Value, AppIpcError> {
    let trigger = events
        .iter()
        .find(|event| event["id"] == message["id"])
        .filter(|event| {
            [
                "conversationId",
                "senderId",
                "at",
                "text",
                "topicId",
                "quotedMessageId",
            ]
            .iter()
            .all(|field| event[*field] == message[*field])
                && event["author"] == "other"
                && (source["kind"] != "group" || event["mentionedSelf"] == true)
        })
        .ok_or_else(|| {
            blocked(
                "source_changed",
                "The original message changed or is unavailable",
            )
        })?;
    let at = event_time(trigger)?;
    for event in events.iter().filter(|event| event["id"] != trigger["id"]) {
        if event["conversationId"] != trigger["conversationId"] {
            return Err(blocked(
                "context_gap",
                "DingTalk returned an unrelated conversation",
            ));
        }
        if event_time(event)? >= at {
            match event["author"].as_str() {
                Some("owner") => {
                    return Err(blocked(
                        "owner_intervened",
                        "The user spoke in the original conversation",
                    ))
                }
                Some("assistant" | "other") => {}
                _ => {
                    return Err(blocked(
                        "context_gap",
                        "A later message author could not be verified",
                    ))
                }
            }
        }
    }
    Ok(trigger)
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn verify_dingtalk_delivery(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = runtime_user(&payload)?;
        self.verify_local_stand_in_owner(user)?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let work_id = nonempty(&payload["workId"])
            .ok_or_else(|| blocked("bad_request", "workId is required"))?;
        let record_id = nonempty(&payload["recordId"])
            .ok_or_else(|| blocked("bad_request", "recordId is required"))?;
        let (work, mut message) = store
            .stand_in_reply_target(user, work_id, record_id)
            .map_err(settings_error)?;
        let source = &message["source"];
        let identity = delivery_identity(user, &message["identity"])
            .filter(|_| autonomous_dingtalk_reply(source))
            .ok_or_else(|| blocked("identity_unverified", "DingTalk identity is missing"))?;
        let observed = self
            .connection_call("validate", Some(DINGTALK_PROVIDER), source.clone())
            .await?;
        if observed["identity"] != message["identity"] {
            return Err(blocked(
                "identity_changed",
                "The DingTalk account or organization changed",
            ));
        }
        dingtalk::refresh_delivery(&store, source, &message, &identity).await?;
        let roles = stand_in_identities(
            &store
                .personal_stand_in(user, &self.device_id)
                .map_err(settings_error)?,
        );
        project_reply_delivery(&store, user, &work, &mut message, &roles)?;
        Ok(json!({"replyDelivery":message["replyDelivery"]}))
    }
}

pub(super) fn ensure_reply_work_visible(
    store: &LocalTaskStore,
    user: i64,
    device: &str,
    work: &Value,
) -> Result<(), AppIpcError> {
    if work["source"]["replyIdentity"].is_object() {
        let roles = stand_in_identities(
            &store
                .read_personal_stand_in(user, device)
                .map_err(settings_error)?,
        );
        let account = store
            .dingtalk_active_identity(user)
            .map_err(settings_error)?;
        if !reply_history_visible(work, &roles, account.as_ref()) {
            return Err(blocked(
                "identity_changed",
                "This work belongs to another DingTalk account",
            ));
        }
    }
    Ok(())
}

pub(super) fn project_reply_delivery(
    store: &LocalTaskStore,
    user: i64,
    work: &Value,
    message: &mut Value,
    roles: &[Value],
) -> Result<(), AppIpcError> {
    if !autonomous_dingtalk_reply(&message["source"]) {
        return Ok(());
    }
    if let Some(identity) = delivery_identity(user, &message["identity"]) {
        if let Some(mut delivery) =
            dingtalk::delivery_record(store, &message["source"], message, &identity)?
        {
            if delivery["status"] == "unknown" && dingtalk::delivery_in_flight(&delivery) {
                delivery["status"] = json!("processing");
                delivery["reason"] = Value::Null;
            }
            message["replyDelivery"] = delivery;
        }
    }
    if message["replyDelivery"].is_null() {
        let available = roles
            .iter()
            .find(|role| role["id"] == work["roleId"])
            .ok_or_else(|| blocked("role_removed", "The stand-in role was removed"))
            .and_then(|role| active_source(role, message))
            .and_then(|source| ensure_available(work, message, source));
        message["replyDelivery"] = available
            .map(|()| json!({"status":"processing"}))
            .unwrap_or_else(|error| block_result(&error));
    }
    if !work["takenOverAt"].is_null() || !message["takenOverAt"].is_null() {
        message["replyDelivery"]["takenOver"] = json!(true);
    }
    message["replyDelivery"]["recordId"] = message["recordId"].clone();
    Ok(())
}

pub(super) fn reply_history_visible(
    work: &Value,
    roles: &[Value],
    account: Option<&Value>,
) -> bool {
    let identity = &work["source"]["replyIdentity"];
    if identity.is_null() {
        return true;
    }
    if let Some(account) = account {
        return account == identity;
    }
    let mut bindings = roles
        .iter()
        .filter(|role| role["id"] == work["roleId"])
        .flat_map(|role| role["connections"].as_array().into_iter().flatten())
        .filter_map(|source| source.get("replyIdentity"));
    let Some(first) = bindings.next() else {
        return true;
    };
    first == identity || bindings.any(|binding| binding == identity)
}

pub(super) fn save_reply_recovery(
    messages: &mut [Value],
    next: &mut Value,
    page: &Value,
    state: &Value,
) {
    if page["recovery"].is_object() {
        next["recovery"] = page["recovery"].clone();
        if page["recovery"]["end"].is_string() {
            for message in messages {
                message["recoveredAt"] = page["recovery"]["end"].clone();
            }
        }
    } else if state["recovery"].is_object() {
        next["recovery"] = state["recovery"].clone();
    }
    if page["gap"].is_object() {
        next["gap"] = page["gap"].clone();
    } else if state["gap"].is_object() {
        next["gap"] = state["gap"].clone();
    }
    if next["gap"].is_object() {
        next["error"] = json!({
            "code":"dingtalk_recovery_gap",
            "message":"Some DingTalk messages could not be recovered"
        });
    }
}

fn blocked(code: &str, message: &str) -> AppIpcError {
    AppIpcError::new(code, message)
}

fn block_result(error: &AppIpcError) -> Value {
    let status = match error.code.as_str() {
        "unsupported_message" => "skipped",
        "evidence_unverified" => "needs_user",
        _ => "blocked",
    };
    json!({
        "status":status,
        "reason":error.message,
        "reasonCode":error.code,
        "takenOver":matches!(error.code.as_str(), "owner_intervened" | "taken_over")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_snapshot_distinguishes_owner_assistant_and_missing_mention() {
        let source = json!({"kind":"group"});
        let trigger = json!({
            "id":"q", "conversationId":"room", "senderId":"peer", "text":"Where?",
            "at":"2026-11-24T08:20:00Z", "author":"other", "mentionedSelf":true
        });
        let mut later = json!({
            "id":"reply", "conversationId":"room",
            "at":"2026-11-24T08:20:01Z", "author":"assistant"
        });
        assert!(fresh_trigger(&source, &trigger, &[trigger.clone(), later.clone()]).is_ok());
        later["author"] = json!("owner");
        assert_eq!(
            fresh_trigger(&source, &trigger, &[trigger.clone(), later])
                .unwrap_err()
                .code,
            "owner_intervened"
        );
        let mut edited = trigger.clone();
        edited["mentionedSelf"] = json!(false);
        assert_eq!(
            fresh_trigger(&source, &trigger, &[edited])
                .unwrap_err()
                .code,
            "source_changed"
        );
    }

    #[test]
    fn receipt_state_and_takeover_remain_independent() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.db")).unwrap();
        let work = json!({"takenOverAt":"2026-11-24T08:20:00Z"});
        let identity = json!({"accountId":"owner","organizationId":"org","openId":"open-owner"});
        let mut message = json!({
            "id":"question",
            "conversationId":"conversation",
            "senderId":"peer",
            "identity":identity,
            "source":{
                "id":"peer",
                "profile":"org:owner",
                "kind":"direct",
                "providerId":DINGTALK_PROVIDER,
                "replyIdentity":identity,
                "policy":{"automatic":true,"askBeforeAct":false,"autonomousReply":true}
            },
            "replyDelivery":{"status":"unknown"}
        });
        project_reply_delivery(&store, 7, &work, &mut message, &[]).unwrap();
        assert_eq!(message["replyDelivery"]["status"], "unknown");
        assert_eq!(message["replyDelivery"]["takenOver"], true);
    }
}
