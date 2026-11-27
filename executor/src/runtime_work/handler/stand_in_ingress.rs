//! Every connected identity receives source messages under its saved session policy.
use super::stand_in::settings_error;
use super::*;
use crate::task_runtime::personal_stand_in::{
    requires_dingtalk_delegation, source_collection_namespace, source_provider,
    stand_in_collection_connection, stand_in_connection, stand_in_identities,
};
use crate::task_runtime::stand_in_projection::project_visible_work;

#[derive(Clone, Copy)]
enum ConnectionSubscriber {
    Assistant,
    Conversation,
    Observations,
    SidebarLease,
    GitDisconnects,
}

#[derive(Default)]
pub(super) struct ConnectionSubscribers {
    maintenance_at: i64,
    jobs: [Option<tokio::task::JoinHandle<()>>; 5],
}

impl RuntimeWorkRpcHandler {
    pub(super) fn start_connection_dispatcher(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        if self
            .connection_dispatcher_started
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let handler = self.clone();
        runtime.spawn(async move {
            loop {
                handler.connection_observation_wakeup.notified().await;
                if let Err(error) = handler
                    .dispatch_conversation_connection_events(false, false)
                    .await
                {
                    log_executor_event("Connection event delivery failed", &[("code", error.code)]);
                }
            }
        });
    }

    pub(super) fn schedule_connection_subscribers(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let now = chrono::Utc::now().timestamp_millis();
        let mut subscribers = self
            .connection_subscribers
            .lock()
            .expect("connection subscriber lock");
        let maintenance = Self::connection_maintenance_due(&mut subscribers.maintenance_at, now);
        for (kind, enabled) in [
            (ConnectionSubscriber::Assistant, maintenance),
            (ConnectionSubscriber::Conversation, true),
            (ConnectionSubscriber::Observations, true),
            (ConnectionSubscriber::SidebarLease, maintenance),
            (ConnectionSubscriber::GitDisconnects, maintenance),
        ] {
            let index = kind as usize;
            if !enabled
                || subscribers.jobs[index]
                    .as_ref()
                    .is_some_and(|job| !job.is_finished())
            {
                continue;
            }
            let handler = self.clone();
            subscribers.jobs[index] = Some(runtime.spawn(async move {
                let result = match kind {
                    ConnectionSubscriber::Assistant => handler.poll_connection_stand_ins().await,
                    ConnectionSubscriber::Conversation => {
                        handler
                            .dispatch_conversation_connection_events(maintenance, true)
                            .await
                    }
                    ConnectionSubscriber::Observations => {
                        handler.poll_connection_observation_sources().await
                    }
                    ConnectionSubscriber::SidebarLease => handler.poll_ui_observers().await,
                    ConnectionSubscriber::GitDisconnects => handler.poll_git_disconnections().await,
                };
                if let Err(error) = result {
                    log_executor_event("Connection subscriber failed", &[("code", error.code)]);
                }
            }));
        }
    }

    async fn poll_git_disconnections(&self) -> Result<(), AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        for settings in store
            .all_personal_stand_ins(&self.device_id)
            .map_err(settings_error)?
        {
            let user = settings["userId"].as_i64().unwrap_or_default();
            if let Err(error) = self.verify_local_stand_in_owner(user) {
                log_executor_event(
                    "Git disconnection owner unavailable",
                    &[("code", error.code)],
                );
                continue;
            }
            if let Err(error) = self.reconcile_git_disconnects(&store, user).await {
                log_executor_event(
                    "Stand-in Git disconnection reconciliation deferred",
                    &[("code", error.code)],
                );
            }
        }
        Ok(())
    }

    async fn poll_connection_stand_ins(&self) -> Result<(), AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        for settings in store
            .all_personal_stand_ins(&self.device_id)
            .map_err(settings_error)?
        {
            let user = settings["userId"].as_i64().unwrap_or_default();
            let identities = stand_in_identities(&settings);
            let receiving: Vec<Value> = identities
                .iter()
                .filter(|role| self.stand_in_role_runs_here(role))
                .cloned()
                .collect();
            let sources = collection_sources(&receiving);
            if !sources.is_empty() {
                if let Err(error) = self.verify_local_stand_in_owner(user) {
                    log_executor_event(
                        "Stand-in owner verification deferred",
                        &[("code", error.code)],
                    );
                    continue;
                }
            }
            let store_ref = &store;
            let version = &settings["version"];
            let mut collection = stream::iter(sources.into_values())
                .map(|(source, roles)| async move {
                    self.poll_stand_in_connection_source(store_ref, user, &source, &roles, version)
                        .await
                })
                .buffer_unordered(4);
            while let Some(result) = collection.next().await {
                if let Err(error) = result {
                    log_executor_event(
                        "Stand-in source collection deferred",
                        &[("code", error.code)],
                    );
                }
            }
            for mut work in store
                .list_stand_in_work(user, None)
                .map_err(settings_error)?
            {
                self.reconcile_connection_dispatch(&store, user, &mut work)?;
                let messages = store
                    .stand_in_messages(user, work["id"].as_str().unwrap_or_default())
                    .map_err(settings_error)?;
                let Some(visible) = project_visible_work(&settings, work, messages) else {
                    continue;
                };
                let work = visible.work;
                if work["status"] != "pending" {
                    continue;
                }
                let Some(role) = identities
                    .iter()
                    .find(|role| role["id"] == work["roleId"] && role["enabled"] == true)
                else {
                    continue;
                };
                for message in visible.messages {
                    let source = &message["source"];
                    if message["dispatchStatus"] != "pending"
                        || !stand_in_collection_connection(role, source).is_some_and(|connection| {
                            connection["policy"]["automatic"] == true
                                && !requires_dingtalk_delegation(role, connection)
                        })
                    {
                        continue;
                    }
                    let event = json!({"kind":"connection","source":source,"message":message,"roleIds":[role["id"]],"roleScoped":true});
                    let identity = LocalTaskStore::canonical_connection_event_identity(&event)
                        .unwrap_or_else(|| {
                            json!([
                                source_provider(source),
                                source["profile"],
                                source["kind"],
                                source["id"],
                                message["id"],
                                role["id"]
                            ])
                        });
                    store
                        .enqueue_stand_in_event(user, identity, event)
                        .map_err(settings_error)?;
                }
            }
        }
        Ok(())
    }

    async fn poll_stand_in_connection_source(
        &self,
        store: &LocalTaskStore,
        user: i64,
        source: &Value,
        roles: &[Value],
        version: &Value,
    ) -> Result<(), AppIpcError> {
        let mut state = store
            .stand_in_source(user, source)
            .map_err(settings_error)?;
        if ["enabledAfter", "generation", "subscriptionId"]
            .into_iter()
            .any(|key| state["source"][key] != source[key])
        {
            state = Value::Null;
        }
        // Older versions could leave this source waiting an hour on the same timed-out query.
        let legacy_timeout = is_dingtalk_group_timeout(source, &state["error"]["code"])
            && state["checkpoint"]["windowMinutes"].is_null();
        if !legacy_timeout && collection_retry_pending(&state, version) {
            return Ok(());
        }
        let outcome = self
            .collect_connection_source(store, user, source, roles, &state, version)
            .await;
        save_collection_result(store, user, source, version, &state, outcome)
    }

    async fn collect_connection_source(
        &self,
        store: &LocalTaskStore,
        user: i64,
        source: &Value,
        roles: &[Value],
        state: &Value,
        settings_version: &Value,
    ) -> Result<Value, AppIpcError> {
        let _stage = super::stand_in_diagnostics::CoordinationStage::start(user, "collect_source");
        let checkpoint = state.get("checkpoint").cloned().unwrap_or_else(|| {
            if source_provider(source) == crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER
                && state["after"].is_string()
            {
                let mut checkpoint = json!({"after":state["after"],"cursor":state["cursor"]});
                if state["until"].is_string() {
                    checkpoint["until"] = state["until"].clone();
                }
                checkpoint
            } else {
                Value::Null
            }
        });
        let page = self
            .connection_call(
                "collectObservation",
                Some(source_provider(source)),
                json!({"source":source,"checkpoint":checkpoint}),
            )
            .await?;
        let messages = page["events"]
            .as_array()
            .ok_or_else(|| {
                AppIpcError::new("connection_response_invalid", "Missing connection events")
            })?
            .clone();
        let checkpoint = page["nextCheckpoint"].as_object().cloned().ok_or_else(|| {
            AppIpcError::new(
                "connection_response_invalid",
                "Missing connection checkpoint",
            )
        })?;
        validate_collection_version(store, user, &self.device_id, settings_version)?;
        let next = json!({"checkpoint":checkpoint});
        let event_count = messages.len();
        let page = (messages, next);
        let next = self
            .collect_connection_page(store, user, source, roles, page)
            .await?;
        if event_count > 0 {
            log_executor_event(
                "Stand-in source page collected",
                &[
                    ("provider", source_provider(source).to_owned()),
                    (
                        "kind",
                        source["kind"].as_str().unwrap_or_default().to_owned(),
                    ),
                    ("event_count", event_count.to_string()),
                ],
            );
        }
        Ok(next)
    }

    async fn collect_connection_page(
        &self,
        store: &LocalTaskStore,
        user: i64,
        source: &Value,
        roles: &[Value],
        page: (Vec<Value>, Value),
    ) -> Result<Value, AppIpcError> {
        let (messages, next) = page;
        let mut failure = None;
        for message in messages {
            let concrete = concrete_connection_source(source, &message)?;
            let source = &concrete;
            if git_message_is_echo(store, user, source, &message)? {
                continue;
            }
            if !["id", "text", "at"]
                .iter()
                .all(|key| message[*key].as_str().is_some_and(|text| !text.is_empty()))
            {
                return Err(AppIpcError::new(
                    "connection_response_invalid",
                    "Connection event is missing required fields",
                ));
            }
            LocalTaskStore::validate_connection_message_version(&message)
                .map_err(settings_error)?;
            message_time(&message["at"])?;
            let mut manual_roles = Vec::new();
            let mut matched = false;
            for role in roles {
                let role_id = role["id"].as_str().unwrap_or_default();
                let Some(grant) = stand_in_collection_connection(role, source) else {
                    if is_dingtalk_group(source) {
                        if let Some(connection) = stand_in_connection(role, source) {
                            matched = true;
                            let reason =
                                if connection.get("collectionKey") != source.get("collectionKey") {
                                    "collection_partition_mismatch"
                                } else {
                                    "excluded_group"
                                };
                            log_dingtalk_group_intake(source, &message, role_id, reason);
                        }
                    }
                    continue;
                };
                matched = true;
                if requires_dingtalk_delegation(role, grant) {
                    continue;
                }
                if !source_accepts_message(grant, &message) {
                    log_dingtalk_group_intake(
                        source,
                        &message,
                        role_id,
                        "outside_subscription_boundary",
                    );
                    continue;
                }
                if grant["policy"]["automatic"] != true {
                    log_dingtalk_group_intake(source, &message, role_id, "manual_only");
                    manual_roles.push(role);
                    continue;
                }
                let role = &role["id"];
                // A shared poll starts at the earliest activation. Dispatch and
                // later receipt matching use this recipient's concrete grant.
                let scoped = concrete_role_grant(grant, source);
                let event = json!({"kind":"connection","source":scoped,"message":message,"roleIds":[role],
                        "roleScoped":true,"roleEnabledAfter":grant["enabledAfter"]});
                let event_identity = LocalTaskStore::canonical_connection_event_identity(&event)
                    .unwrap_or_else(|| {
                        json!([
                            source_provider(source),
                            source["profile"],
                            source["kind"],
                            source["id"],
                            message["id"],
                            role
                        ])
                    });
                let record = store
                    .enqueue_stand_in_event(user, event_identity, event)
                    .map_err(|error| {
                        log_dingtalk_group_intake(source, &message, role_id, "enqueue_failed");
                        settings_error(error)
                    })?;
                log_dingtalk_group_intake(
                    source,
                    &message,
                    role_id,
                    record["status"].as_str().unwrap_or("unknown_queue_status"),
                );
            }
            if !matched {
                log_dingtalk_group_intake(source, &message, "", "no_matching_subscription");
            }
            for role in manual_roles {
                if let Err(error) = self
                    .collect_connection_message(store, user, role, source, &message)
                    .await
                {
                    log_executor_event(
                        "Connection message persistence failed",
                        &[
                            ("role_id", role["id"].to_string()),
                            ("message_id", message["id"].to_string()),
                            ("error", error.message.clone()),
                        ],
                    );
                    failure.get_or_insert(error);
                }
            }
        }
        failure.map_or(Ok(next), Err)
    }

    pub(super) async fn collect_connection_message(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role: &Value,
        source: &Value,
        message: &Value,
    ) -> Result<(), AppIpcError> {
        let role_id = role["id"].as_str().unwrap_or_default();
        if git_message_is_echo(store, user, source, message)? {
            return Ok(());
        }
        let target = self.connection_session_target(store, user, role, source, message)?;
        let connection = stand_in_collection_connection(role, source)
            .ok_or_else(|| AppIpcError::new("source_removed", "Source was disconnected"))?;
        let connection = concrete_role_grant(connection, source);
        if let Some(id) = &target {
            store
                .ensure_coordinated_work(
                    user,
                    role_id,
                    id,
                    &connection,
                    message["text"].as_str().unwrap_or("Work"),
                )
                .map_err(settings_error)?;
        }
        store
            .ingest_stand_in_message(user, role_id, &connection, message, target.as_deref())
            .map_err(settings_error)?;
        Ok(())
    }
}

fn concrete_role_grant(grant: &Value, source: &Value) -> Value {
    let mut scoped = grant.clone();
    if scoped["scope"] == "all" {
        scoped.as_object_mut().unwrap().remove("scope");
        scoped["id"] = source["id"].clone();
        scoped["name"] = source["name"].clone();
    }
    scoped
}

fn collection_sources(
    identities: &[Value],
) -> std::collections::BTreeMap<String, (Value, Vec<Value>)> {
    let mut sources = std::collections::BTreeMap::<String, (Value, Vec<Value>)>::new();
    for identity in identities
        .iter()
        .filter(|identity| identity["enabled"] == true)
    {
        for source in identity["connections"].as_array().into_iter().flatten() {
            if requires_dingtalk_delegation(identity, source) {
                continue;
            }
            let key = json!([
                source_collection_namespace(source),
                source["kind"],
                source["id"]
            ])
            .to_string();
            let entry = sources
                .entry(key)
                .or_insert_with(|| (source.clone(), Vec::new()));
            if source["enabledAfter"].as_str() < entry.0["enabledAfter"].as_str() {
                entry.0 = source.clone();
            }
            entry.1.push(identity.clone());
        }
    }
    sources
}

fn concrete_connection_source(source: &Value, message: &Value) -> Result<Value, AppIpcError> {
    let mut result = source.clone();
    if source["scope"] != "all" {
        return Ok(result);
    }
    let resource = &message["resource"];
    if resource["kind"] != source["kind"]
        || !["id", "name"].iter().all(|key| {
            resource[*key]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty() && value.len() <= 512)
        })
        || resource["id"] == "*"
    {
        return Err(AppIpcError::new(
            "connection_response_invalid",
            "Missing concrete event resource",
        ));
    }
    result.as_object_mut().unwrap().remove("scope");
    result["id"] = resource["id"].clone();
    result["name"] = resource["name"].clone();
    Ok(result)
}

fn collection_retry_pending(state: &Value, version: &Value) -> bool {
    state["version"] == *version
        && state["error"]["retryable"] == true
        && state["retryAt"]
            .as_i64()
            .is_some_and(|at| at > chrono::Utc::now().timestamp_millis())
}

fn is_dingtalk_group(source: &Value) -> bool {
    source_provider(source) == crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER
        && source["kind"] == "group"
}

fn log_dingtalk_group_intake(source: &Value, message: &Value, role_id: &str, outcome: &str) {
    if is_dingtalk_group(source) {
        log_executor_event(
            "DingTalk group intake",
            &[
                ("group_id", source["id"].to_string()),
                ("message_id", message["id"].to_string()),
                ("role_id", role_id.to_owned()),
                ("outcome", outcome.to_owned()),
            ],
        );
    }
}

fn is_dingtalk_group_timeout(source: &Value, code: &Value) -> bool {
    is_dingtalk_group(source)
        && source["collectionKey"] == "all-messages"
        && code == "request_timeout"
}

fn recover_dingtalk_group_checkpoint(
    source: &Value,
    state: &mut Value,
    now: chrono::DateTime<chrono::Utc>,
) {
    let checkpoint = &state["checkpoint"];
    let after = checkpoint["after"]
        .as_str()
        .or_else(|| state["after"].as_str())
        .unwrap_or_else(|| source["enabledAfter"].as_str().unwrap_or_default());
    let window = checkpoint["windowMinutes"].as_u64().unwrap_or(15);
    let (minutes, backlog_cutoff) = match window {
        1 => (1, Some(now - chrono::Duration::minutes(1))),
        5 => (1, Some(now - chrono::Duration::minutes(5))),
        _ => (5, None),
    };
    if let Some(cutoff) = backlog_cutoff.filter(|cutoff| {
        chrono::DateTime::parse_from_rfc3339(after).is_ok_and(|start| start < *cutoff)
    }) {
        log_executor_event(
            "DingTalk group collection skipped timed-out backlog",
            &[
                ("group_id", source["id"].to_string()),
                ("from", after.to_owned()),
                ("until", cutoff.to_rfc3339()),
            ],
        );
        state["checkpoint"] =
            json!({"after":cutoff.to_rfc3339(),"cursor":"0","windowMinutes":minutes});
    } else if window != minutes {
        // A cursor belongs to its original time window. Replay from the same start when shrinking.
        state["checkpoint"] = json!({"after":after,"cursor":"0","windowMinutes":minutes});
    }
}

fn save_collection_result(
    store: &LocalTaskStore,
    user: i64,
    source: &Value,
    version: &Value,
    state: &Value,
    outcome: Result<Value, AppIpcError>,
) -> Result<(), AppIpcError> {
    let mut next = match outcome {
        Ok(next) => next,
        // Startup and host restarts must not latch a source error until settings change.
        Err(error) if error.code == "connection_host_unavailable" => return Ok(()),
        Err(error) => {
            let mut next = if state.is_object() {
                state.clone()
            } else {
                json!({})
            };
            next["error"] = json!({"code":error.code,"message":error.message,"retryable":true});
            if let Some(code) = &error.provider_code {
                next["error"]["providerCode"] = json!(code);
            }
            if let Some(delay) = error.retry_after_ms.or_else(|| {
                super::super::connection_host::collection_runtime_retry_after_ms(&error.code)
            }) {
                let now = chrono::Utc::now();
                let failures = state["failures"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(1)
                    .min(10);
                next["failures"] = json!(failures);
                let retry_after_ms = if is_dingtalk_group_timeout(source, &next["error"]["code"]) {
                    recover_dingtalk_group_checkpoint(source, &mut next, now);
                    30_000
                } else {
                    (30_000_i64 << failures.saturating_sub(1).min(7)).min(3_600_000)
                }
                .max(delay as i64);
                next["retryAt"] = json!(now.timestamp_millis() + retry_after_ms);
                log_executor_event(
                    "Stand-in source collection retry scheduled",
                    &[
                        ("provider", source_provider(source).to_owned()),
                        (
                            "kind",
                            source["kind"].as_str().unwrap_or_default().to_owned(),
                        ),
                        ("code", error.code),
                        ("retry_after_ms", retry_after_ms.to_string()),
                        (
                            "group_id",
                            if is_dingtalk_group(source) {
                                source["id"].to_string()
                            } else {
                                String::new()
                            },
                        ),
                    ],
                );
            } else {
                next.as_object_mut().unwrap().remove("retryAt");
                next.as_object_mut().unwrap().remove("failures");
            }
            next
        }
    };
    next["version"] = version.clone();
    store
        .save_stand_in_source(user, source, &next)
        .map_err(settings_error)?;
    Ok(())
}

fn validate_collection_version(
    store: &LocalTaskStore,
    user: i64,
    device: &str,
    version: &Value,
) -> Result<(), AppIpcError> {
    let current = store
        .personal_stand_in(user, device)
        .map_err(settings_error)?;
    if current["version"] != *version {
        return Err(AppIpcError::new(
            "connection_configuration_changed",
            "Connection settings changed during collection",
        ));
    }
    Ok(())
}

pub(super) fn git_message_is_echo(
    store: &LocalTaskStore,
    user: i64,
    source: &Value,
    message: &Value,
) -> Result<bool, AppIpcError> {
    if source_provider(source).starts_with(super::super::git_connections::PACKAGE) {
        if let (Some(profile), Some(id)) = (
            source["profile"].as_str(),
            message["id"]
                .as_str()
                .filter(|id| id.starts_with("git-canonical:")),
        ) {
            return store
                .git_sent_event(user, profile, id)
                .map_err(settings_error);
        }
    }
    Ok(false)
}

// Keep existing intake policy separate from generic subscription initialization receipts.
pub(super) fn source_accepts_message(source: &Value, message: &Value) -> bool {
    if source_provider(source) == crate::task_runtime::personal_stand_in::EMAIL_PROVIDER
        || (source_provider(source).starts_with(super::super::git_connections::PACKAGE)
            && super::super::git_connections::uses_webhook(source))
    {
        let boundary = &source["boundary"];
        let position = &message["position"];
        return boundary["partition"].is_string()
            && boundary["partition"] == position["partition"]
            && boundary["sequence"]
                .as_u64()
                .zip(position["sequence"].as_u64())
                .is_some_and(|(start, received)| received > start);
    }
    source["enabledAfter"]
        .as_str()
        .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
        .is_some_and(|enabled| {
            message_time(&message["at"])
                .is_ok_and(|received| received >= enabled.timestamp_millis())
        })
}

#[cfg(test)]
mod ordered_email_tests {
    use super::*;

    #[test]
    fn dingtalk_intake_keeps_its_time_gate_even_with_a_newer_position() {
        let source = json!({"providerId":"@wegent/dsh-connection-dingtalk/dingtalk",
            "enabledAfter":"2026-11-04T00:00:00Z",
            "boundary":{"partition":"events","sequence":5}});
        let mut message = json!({"at":"2000-01-01T00:00:00Z",
            "position":{"partition":"events","sequence":6}});
        assert!(!source_accepts_message(&source, &message));
        message["at"] = Value::Null;
        assert!(!source_accepts_message(&source, &message));
        message["at"] = json!("2026-11-04T00:00:01Z");
        assert!(source_accepts_message(&source, &message));
    }

    #[test]
    fn git_cli_repository_intake_uses_activation_time_without_a_cloud_boundary() {
        let source = json!({"providerId":"@wegent/dsh-connection-git/github", "kind":"repository", "transport":"cli", "enabledAfter":"2026-11-04T00:00:00Z"});
        assert!(!source_accepts_message(
            &source,
            &json!({"at":"2026-11-03T23:59:59Z"})
        ));
        assert!(source_accepts_message(
            &source,
            &json!({"at":"2026-11-04T00:00:01Z"})
        ));
        let mut webhook = source.clone();
        webhook.as_object_mut().unwrap().remove("transport");
        assert!(!source_accepts_message(
            &webhook,
            &json!({"at":"2026-11-04T00:00:01Z"})
        ));
    }

    #[test]
    fn ordered_email_intake_uses_each_roles_uid_boundary_instead_of_timestamp_precision() {
        let mut source = json!({"providerId":crate::task_runtime::personal_stand_in::EMAIL_PROVIDER,
            "boundary":{"partition":"123","sequence":5},"enabledAfter":"2026-11-04T00:00:00.500Z"});
        let mut message =
            json!({"at":"2026-11-04T00:00:00Z","position":{"partition":"123","sequence":6}});
        assert!(source_accepts_message(&source, &message));
        source["boundary"]["sequence"] = json!(6);
        assert!(!source_accepts_message(&source, &message));
        message["position"]["sequence"] = json!(7);
        assert!(source_accepts_message(&source, &message));
        message["position"]["partition"] = json!("reset");
        assert!(!source_accepts_message(&source, &message));
        source.as_object_mut().unwrap().remove("boundary");
        assert!(!source_accepts_message(&source, &message));
    }
}

pub(super) fn message_time(value: &Value) -> Result<i64, AppIpcError> {
    value
        .as_str()
        .and_then(wegent_local_task_store::store::connection_message_millis)
        .ok_or_else(|| {
            AppIpcError::new(
                "connection_response_invalid",
                "Message timestamp is invalid or ambiguous",
            )
        })
}

#[cfg(test)]
#[path = "stand_in_ingress_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "stand_in_event_versions_tests.rs"]
mod event_versions_tests;
