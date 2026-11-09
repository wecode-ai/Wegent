//! Every connected identity receives source messages under its saved session policy.
use super::stand_in::settings_error;
use super::*;
use crate::task_runtime::personal_stand_in::{
    source_collection_namespace, source_provider, stand_in_collection_connection,
    stand_in_identities,
};
use chrono::TimeZone;

impl RuntimeWorkRpcHandler {
    pub(super) fn start_connection_stand_in_scheduler(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let handler = self.clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if let Err(error) = handler.poll_connection_stand_ins().await {
                    log_executor_event(
                        "Connection stand-in collection failed",
                        &[("code", error.code), ("error", error.message)],
                    );
                }
            }
        });
    }

    async fn poll_connection_stand_ins(&self) -> Result<(), AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        for settings in store
            .all_personal_stand_ins(&self.device_id)
            .map_err(settings_error)?
        {
            let user = settings["userId"].as_i64().unwrap_or_default();
            self.reconcile_git_disconnects(&store, user).await?;
            let identities = stand_in_identities(&settings);
            let sources = collection_sources(&identities);
            if sources.is_empty() {
                continue;
            }
            if self.backend_connection_snapshot()?.is_some() {
                self.verify_runtime_user(&json!({"userId":user})).await?;
            }
            for (source, roles) in sources.values() {
                let mut state = store
                    .stand_in_source(user, source)
                    .map_err(settings_error)?;
                if state["source"]["enabledAfter"] != source["enabledAfter"]
                    || state["source"]["generation"] != source["generation"]
                    || state["source"]["subscriptionId"] != source["subscriptionId"]
                {
                    state = Value::Null;
                }
                if collection_error_latched(&state, &settings["version"]) {
                    continue;
                }
                let outcome = self
                    .collect_connection_source(
                        &store,
                        user,
                        source,
                        roles,
                        &state,
                        &settings["version"],
                    )
                    .await;
                save_collection_result(
                    &store,
                    user,
                    source,
                    &settings["version"],
                    &state,
                    outcome,
                )?;
            }
            for mut work in store
                .list_stand_in_work(user, None)
                .map_err(settings_error)?
            {
                self.reconcile_connection_dispatch(&store, user, &mut work)?;
                if work["status"] != "pending" {
                    continue;
                }
                let Some(role) = identities
                    .iter()
                    .find(|role| role["id"] == work["roleId"] && role["enabled"] == true)
                else {
                    continue;
                };
                for message in store
                    .stand_in_messages(user, work["id"].as_str().unwrap_or_default())
                    .map_err(settings_error)?
                {
                    let source = &message["source"];
                    if message["dispatchStatus"] != "pending"
                        || !stand_in_collection_connection(role, source)
                            .is_some_and(|connection| connection["policy"]["automatic"] == true)
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

    async fn collect_connection_source(
        &self,
        store: &LocalTaskStore,
        user: i64,
        source: &Value,
        roles: &[Value],
        state: &Value,
        settings_version: &Value,
    ) -> Result<Value, AppIpcError> {
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
                "collect",
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
        let checkpoint = page["nextCheckpoint"].as_object().ok_or_else(|| {
            AppIpcError::new(
                "connection_response_invalid",
                "Missing connection checkpoint",
            )
        })?;
        validate_collection_version(store, user, &self.device_id, settings_version)?;
        let page = (messages, json!({"checkpoint":checkpoint}));
        self.collect_connection_page(store, user, source, roles, page)
            .await
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
            {
                let eligible: Vec<Value> = roles
                    .iter()
                    .filter(|role| {
                        stand_in_collection_connection(role, source).is_some_and(|connection| {
                            connection["policy"]["automatic"] == true
                                && source_accepts_message(connection, &message)
                        })
                    })
                    .map(|role| role["id"].clone())
                    .collect();
                for role in eligible {
                    let event = json!({"kind":"connection","source":source,"message":message,"roleIds":[role],"roleScoped":true});
                    let event_identity = LocalTaskStore::canonical_connection_event_identity(
                        &event,
                    )
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
                    store
                        .enqueue_stand_in_event(user, event_identity, event)
                        .map_err(settings_error)?;
                }
            }
            for role in roles.iter().filter(|role| {
                stand_in_collection_connection(role, source).is_some_and(|connection| {
                    connection["policy"]["automatic"] != true
                        && source_accepts_message(connection, &message)
                })
            }) {
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
        let mut connection = connection.clone();
        if connection["scope"] == "all" {
            connection.as_object_mut().unwrap().remove("scope");
            connection["id"] = source["id"].clone();
            connection["name"] = source["name"].clone();
        }
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

fn collection_sources(
    identities: &[Value],
) -> std::collections::BTreeMap<String, (Value, Vec<Value>)> {
    let mut sources = std::collections::BTreeMap::<String, (Value, Vec<Value>)>::new();
    for identity in identities
        .iter()
        .filter(|identity| identity["enabled"] == true)
    {
        for source in identity["connections"].as_array().into_iter().flatten() {
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

fn collection_error_latched(state: &Value, version: &Value) -> bool {
    if !state["error"].is_object() || state["version"] != *version {
        return false;
    }
    if state["error"]["retryable"] == true {
        return state["retryAt"]
            .as_i64()
            .is_some_and(|at| at > chrono::Utc::now().timestamp_millis());
    }
    // Previously persisted runtime timeouts must recover without changing settings
    // or discarding the original collection checkpoint.
    if super::super::connection_host::collection_runtime_retry_after_ms(
        state["error"]["code"].as_str().unwrap_or_default(),
    )
    .is_some()
    {
        return false;
    }
    true
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
            next["error"] = json!({"code":error.code,"message":error.message});
            if let Some(delay) = error.retry_after_ms.or_else(|| {
                super::super::connection_host::collection_runtime_retry_after_ms(&error.code)
            }) {
                let failures = state["failures"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(1)
                    .min(10);
                next["failures"] = json!(failures);
                next["error"]["retryable"] = json!(true);
                // Apply the base delay on the first failure, then back off repeated failures.
                next["retryAt"] = json!(
                    chrono::Utc::now().timestamp_millis()
                        + ((30_000_i64 << failures.saturating_sub(1).min(7)).min(3_600_000))
                            .max(delay as i64)
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
    let text = value.as_str().unwrap_or_default();
    if let Ok(time) = chrono::DateTime::parse_from_rfc3339(text) {
        return Ok(time.timestamp_millis());
    }
    chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S")
        .ok()
        .and_then(|time| chrono::Local.from_local_datetime(&time).single())
        .map(|time| time.timestamp_millis())
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
