//! Durable account HTTP coordination around the same Socket capability handler.
use super::plugin_route::required_profile_field;
use super::{AppIpcError, LocalBackendConnectionController};
use crate::{
    agents::{backend_url::backend_http_client, wework_codex_home},
    config::device::ConnectionConfig,
};
use fs2::FileExt;

#[cfg(test)]
mod execution_tests;
mod recovery;
mod scanning;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc, time::Duration};

struct LocalSyncSession<'a> {
    connection: &'a ConnectionConfig,
    handler: Arc<dyn super::super::capability::CapabilitySyncRpcHandler>,
    capabilities: &'a Value,
    instance: &'a str,
    path: &'a Path,
}

// Account HTTP does not consume Socket routes or Runtime credentials.
fn same_account_connection(current: &ConnectionConfig, expected: &ConnectionConfig) -> bool {
    current.backend_url == expected.backend_url && current.auth_token == expected.auth_token
}

fn error(code: &str) -> AppIpcError {
    AppIpcError::new(code, code)
}
fn persist(path: &Path, journal: &Value) -> Result<(), AppIpcError> {
    let bytes = serde_json::to_vec(journal).map_err(|_| error("plugin_local_journal_invalid"))?;
    wegent_filesystem::atomic_file::write_atomic_file(path, &bytes)
        .map_err(|_| error("plugin_local_journal_unavailable"))
}
fn load(path: &Path) -> Result<Value, AppIpcError> {
    match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| error("plugin_local_journal_invalid"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({"version":1,"pending":[]})),
        Err(_) => Err(error("plugin_local_journal_unavailable")),
    }
}
fn load_journal(path: &Path) -> Result<Value, AppIpcError> {
    let mut journal = load(path)?;
    let document = journal
        .as_object_mut()
        .ok_or_else(|| error("plugin_local_journal_invalid"))?;
    document.remove("receipts");
    // Older journals stored the plan only to mark unfinished application.
    // Keep that recovery intent without retaining an unused payload copy.
    if document
        .remove("snapshot")
        .is_some_and(|plan| plan.is_object())
    {
        document.insert("reconcilePending".into(), json!(true));
    }
    let valid = journal["version"] == 1
        && journal["pending"].as_array().is_some_and(|items| {
            items.iter().all(|item| {
                item.is_object() && item["operationId"].is_string() && item["action"].is_string()
            })
        });
    if !valid {
        return Err(error("plugin_local_journal_invalid"));
    }
    Ok(journal)
}

fn instance_id(root: &Path) -> Result<String, AppIpcError> {
    let path = root.join("instance.json");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("instance.lock"))
        .map_err(|_| error("plugin_local_journal_unavailable"))?;
    file.lock_exclusive()
        .map_err(|_| error("plugin_local_journal_unavailable"))?;
    let value = if path.exists() {
        load(&path)?
    } else {
        let value = json!({"id":uuid::Uuid::new_v4().to_string()});
        persist(&path, &value)?;
        value
    };
    value["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| error("plugin_local_journal_invalid"))
}
async fn post(
    connection: &ConnectionConfig,
    path: &str,
    body: &Value,
) -> Result<Value, AppIpcError> {
    let response = backend_http_client()
        .map_err(|_| error("plugin_local_http_unavailable"))?
        .post(format!(
            "{}{}",
            connection.backend_url.trim_end_matches('/'),
            path
        ))
        .bearer_auth(&connection.auth_token)
        .json(body)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| error("plugin_local_http_unavailable"))?;
    let status = response.status();
    if status.as_u16() == 404 {
        return Err(error("plugin_local_sync_unsupported"));
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| error("plugin_local_invalid_response"))?;
    if !status.is_success() {
        return Err(error(
            value["detail"]
                .as_str()
                .unwrap_or("plugin_local_http_failed"),
        ));
    }
    Ok(value)
}
fn optional_origin(value: &str) -> &str {
    if !value.is_empty()
        && value.len() <= 100
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
    {
        value
    } else {
        ""
    }
}

fn next_intent_order(journal: &mut Value) -> Result<u64, AppIpcError> {
    let current = match journal.get("nextIntentOrder") {
        None => 0,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| error("plugin_local_journal_invalid"))?,
    };
    let order = current
        .checked_add(1)
        .filter(|value| *value < i64::MAX as u64)
        .ok_or_else(|| error("plugin_local_journal_invalid"))?;
    journal["nextIntentOrder"] = json!(order);
    Ok(order)
}

fn retire_superseded(journal: &mut Value, operation: &str) {
    journal["pending"]
        .as_array_mut()
        .unwrap()
        .retain(|entry| entry["operationId"].as_str() != Some(operation));
    journal["revision"] = Value::Null;
    journal["reconcilePending"] = json!(true);
}

#[derive(Debug)]
enum SubmitOutcome {
    Accepted,
    Rejected { failure: AppIpcError, status: u16 },
    Superseded,
}

fn acknowledged(headers: &reqwest::header::HeaderMap, operation: &str, order: u64) -> bool {
    let value = |name: &str| headers.get(name).and_then(|header| header.to_str().ok());
    value("X-Plugin-Delivery-Mode") == Some("local_pull_v1")
        && value("X-Plugin-Operation-Id") == Some(operation)
        && value("X-Plugin-Intent-Order").and_then(|value| value.parse::<u64>().ok()) == Some(order)
}

async fn submit(
    connection: &ConnectionConfig,
    instance: &str,
    request: &Value,
    source_device_id: &str,
) -> Result<SubmitOutcome, AppIpcError> {
    let action = request["action"]
        .as_str()
        .ok_or_else(|| error("invalid_params"))?;
    let id = request["targetId"].as_u64().unwrap_or(0);
    let plugin_key = request["targetId"].as_str().unwrap_or_default();
    if action == "ensure_builtin" {
        if plugin_key.is_empty()
            || plugin_key.len() > 128
            || !plugin_key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        {
            return Err(error("invalid_params"));
        }
    } else if id == 0 {
        return Err(error("invalid_params"));
    }
    let operation = request["operationId"]
        .as_str()
        .ok_or_else(|| error("invalid_params"))?;
    let intent_order = request["intentOrder"]
        .as_u64()
        .filter(|value| *value > 0 && *value < i64::MAX as u64)
        .ok_or_else(|| error("plugin_local_journal_invalid"))?;
    let client = backend_http_client().map_err(|_| error("plugin_local_http_unavailable"))?;
    let base = connection.backend_url.trim_end_matches('/');
    let (method, path) = match action {
        "install" => (
            reqwest::Method::POST,
            format!("/api/plugins/marketplace/{id}/install"),
        ),
        "update" => (reqwest::Method::PUT, format!("/api/plugins/installed/{id}")),
        "ensure_builtin" => (
            reqwest::Method::POST,
            format!("/api/plugins/builtin/{plugin_key}/ensure-installed"),
        ),
        "uninstall" => (
            reqwest::Method::DELETE,
            format!("/api/plugins/installed/{id}"),
        ),
        _ => return Err(error("invalid_params")),
    };
    let mut builder = client
        .request(method, format!("{base}{path}"))
        .bearer_auth(&connection.auth_token)
        .query(&[
            ("delivery_mode", "local_pull_v1"),
            ("local_instance_id", instance),
            ("operation_id", operation),
            ("source_device_id", optional_origin(source_device_id)),
        ])
        .query(&[("local_intent_order", intent_order)])
        .header("Idempotency-Key", operation)
        .timeout(Duration::from_secs(30));
    if action == "ensure_builtin" {
        builder = builder.json(&json!({}));
    }
    if action == "update" {
        builder = builder.json(&request["payload"]);
    }
    if action == "install" {
        if let Some(release) = request["payload"]["releaseId"].as_i64() {
            builder = builder.query(&[("release_id", release)]);
        }
    }
    let response = builder
        .send()
        .await
        .map_err(|_| error("plugin_local_http_unavailable"))?;
    let status = response.status();
    let ack = acknowledged(response.headers(), operation, intent_order);
    let terminal = response
        .headers()
        .get("X-Plugin-Operation-State")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let rejected = terminal == "rejected";
    if !status.is_success() {
        let value = response.json::<Value>().await.unwrap_or_default();
        let code = value["detail"]
            .as_str()
            .unwrap_or("plugin_local_intent_failed");
        if ack && terminal == "superseded" && status.as_u16() == 409 && code == "INTENT_SUPERSEDED"
        {
            return Ok(SubmitOutcome::Superseded);
        }
        let definitive = matches!(status.as_u16(), 400 | 403 | 404 | 422)
            || (status.as_u16() == 409 && code == "INTENT_SUPERSEDED");
        if ack && rejected && definitive && value["detail"].is_string() {
            return Ok(SubmitOutcome::Rejected {
                failure: error(code),
                status: status.as_u16(),
            });
        }
        return Err(error(code));
    }
    // Missing acknowledgements can mean an old replica ignored the new mode.
    if !ack || rejected {
        return Err(error("plugin_local_acceptance_unconfirmed"));
    }
    Ok(SubmitOutcome::Accepted)
}

fn valid_snapshot(snapshot: &Value) -> bool {
    let payload = &snapshot["payload"];
    let metadata = &payload["plugin_sync"];
    let version = metadata["version"].as_u64();
    let scope = payload["scope"].as_str();
    let valid_scope =
        matches!(
            (metadata["complete"].as_bool(), scope),
            (Some(true), Some("plugins")) | (Some(false), Some("plugin_delta"))
        ) || (version == Some(3) && metadata["complete"] == false && scope == Some("plugins"));
    let valid_revisions = version != Some(3)
        || metadata["revisions"].as_object().is_some_and(|revisions| {
            ["plugins", "removed_plugins"]
                .into_iter()
                .flat_map(|field| payload[field].as_array().into_iter().flatten())
                .all(|item| {
                    item["installed_plugin_id"].as_i64().is_some_and(|id| {
                        revisions
                            .get(&id.to_string())
                            .and_then(Value::as_u64)
                            .is_some_and(|value| value > 0)
                    })
                })
        });
    snapshot["protocolVersion"] == 1
        && snapshot["generation"].as_u64().is_some_and(|g| g > 0)
        && snapshot["revision"].as_str().is_some_and(|revision| {
            revision.len() == 64 && revision.bytes().all(|c| c.is_ascii_hexdigit())
        })
        && matches!(version, Some(2 | 3))
        && metadata["generation"] == snapshot["generation"]
        && valid_scope
        && valid_revisions
        && payload["mode"] == "merge"
        && payload["plugins"].is_array()
}

fn select_pending(pending: &[Value], params: &Value) -> Option<Value> {
    if params["action"].is_string() {
        pending.last().cloned()
    } else {
        None
    }
}

fn local_result(payload: &Value, result: Value) -> Value {
    if result["plugin_sync"] == payload["plugin_sync"]
        && result["scope"] == payload["scope"]
        && result["plugins"].is_array()
    {
        return result;
    }
    // Installer validation can reject an entire malformed request before it
    // creates per-item ACKs. Report rejection without claiming materialization.
    let mut items = Vec::new();
    for (field, operation) in [("plugins", "upsert"), ("removed_plugins", "remove")] {
        for target in payload[field].as_array().into_iter().flatten() {
            items.push(json!({"id":target["installed_plugin_id"],"operation":operation,"status":"failed","generation":if payload["plugin_sync"]["version"]==3 { payload["plugin_sync"]["revisions"][target["installed_plugin_id"].as_i64().unwrap_or(0).to_string()].clone() } else {payload["plugin_sync"]["generation"].clone()},"error_code":"APPLY_REQUEST_REJECTED"}));
        }
    }
    json!({"success":false,"scope":payload["scope"],"plugin_sync":payload["plugin_sync"],"plugins":items,"error":result["error"]})
}

impl LocalBackendConnectionController {
    fn plugin_source_device_id(&self) -> String {
        if !self
            .connection_status
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return String::new();
        }
        self.device_route_id
            .lock()
            .ok()
            .and_then(|route| route.clone())
            .filter(|route| !optional_origin(route).is_empty())
            .unwrap_or_default()
    }

    pub(super) async fn local_plugin_sync(&self, params: Value) -> Result<Value, AppIpcError> {
        let root = wework_codex_home().join("plugin-local-sync");
        self.local_plugin_sync_at(params, &root).await
    }

    async fn local_plugin_sync_at(&self, params: Value, root: &Path) -> Result<Value, AppIpcError> {
        let backend = required_profile_field(&params, "backend_url")?.trim_end_matches('/');
        let token = required_profile_field(&params, "auth_token")?;
        let (connection, handler) = {
            let state = self.state.lock().await;
            let profile = state
                .profile
                .as_ref()
                .ok_or_else(|| error("plugin_local_profile_unavailable"))?;
            if profile.connection.backend_url != backend || profile.connection.auth_token != token {
                return Err(error("plugin_route_profile_mismatch"));
            }
            (
                profile.connection.clone(),
                state
                    .plugin_sync
                    .clone()
                    .ok_or_else(|| error("plugin_local_sync_unsupported"))?,
            )
        };
        std::fs::create_dir_all(root).map_err(|_| error("plugin_local_journal_unavailable"))?;
        // This short cross-process identity lease is independent of installer
        // execution. Waiting for it must not occupy a Tokio worker.
        let identity_root = root.to_path_buf();
        let instance = tokio::task::spawn_blocking(move || instance_id(&identity_root))
            .await
            .map_err(|_| error("plugin_local_journal_unavailable"))??;
        let capabilities = post(
            &connection,
            "/api/plugins/local-sync",
            &json!({"protocolVersion":1,"instanceId":instance,"probeOnly":true}),
        )
        .await?;
        if capabilities["protocolVersion"] != 1 || capabilities["contractRevision"] != 3 {
            return Err(error("plugin_local_sync_unsupported"));
        }
        let account = capabilities["accountId"]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or_else(|| error("plugin_local_invalid_response"))?;
        let scope = format!(
            "{:x}",
            Sha256::digest(format!("{}:{account}", connection.backend_url).as_bytes())
        );
        // Independent Backend profiles must not advance each other's receipt
        // watermarks, including two URLs routing to the same Backend database.
        let instance = format!(
            "{:x}",
            Sha256::digest(format!("{instance}:{scope}").as_bytes())
        );
        let path = root.join(format!("{scope}.json"));
        if params["probeOnly"] == true {
            let journal = load_journal(&path)?;
            let recovery = journal["pending"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
                || journal["reconcilePending"] == true;
            let mut capabilities = capabilities;
            capabilities["recoveryPending"] = json!(recovery);
            capabilities["sourceDeviceId"] = json!(self.plugin_source_device_id());
            return Ok(capabilities);
        }

        let targeted = params["action"].is_string()
            || params["installedPluginId"]
                .as_u64()
                .is_some_and(|id| id > 0)
                && params["full"] != true;
        let _foreground = targeted.then(|| {
            scanning::ForegroundOperation::begin(self.local_sync_foreground.clone(), &path)
        });
        if !targeted && self.has_foreground_plugin_operation(&path) {
            return Err(error("plugin_local_sync_busy"));
        }

        let mut lease = Some(self.acquire_local_sync_lease(&connection, &path).await?);
        let journal = load_journal(&path)?;
        self.apply_local_plugin_sync(
            params,
            LocalSyncSession {
                connection: &connection,
                handler,
                capabilities: &capabilities,
                instance: &instance,
                path: &path,
            },
            journal,
            &mut lease,
        )
        .await
    }

    // Full scans temporarily release the lease and revalidate before continuing.
    // Prepared recovery submits HTTP independently of both execution and scans.
    async fn apply_local_plugin_sync(
        &self,
        params: Value,
        session: LocalSyncSession<'_>,
        mut journal: Value,
        lease: &mut Option<scanning::LocalSyncLease>,
    ) -> Result<Value, AppIpcError> {
        let LocalSyncSession {
            connection,
            ref handler,
            capabilities,
            instance,
            path,
        } = session;
        if journal["version"] != 1 {
            return Err(error("plugin_local_journal_invalid"));
        }
        if let Some(action) = params["action"].as_str() {
            if capabilities["enabled"] != true {
                return Err(error("LOCAL_SYNC_DISABLED"));
            }
            if !matches!(
                action,
                "install" | "update" | "uninstall" | "ensure_builtin"
            ) || (action != "ensure_builtin"
                && params["targetId"].as_u64().filter(|id| *id > 0).is_none())
            {
                return Err(error("invalid_params"));
            }
            let intent_order = next_intent_order(&mut journal)?;
            let request = json!({"intentOrder":intent_order,"action":action,"targetId":params["targetId"],"payload":params.get("payload").cloned().unwrap_or(json!({})),"operationId":uuid::Uuid::new_v4().to_string()});
            journal["pending"]
                .as_array_mut()
                .ok_or_else(|| error("plugin_local_journal_invalid"))?
                .push(request);
            persist(path, &journal)?;
        }
        let selected = select_pending(
            journal["pending"]
                .as_array()
                .ok_or_else(|| error("plugin_local_journal_invalid"))?,
            &params,
        );
        let operation = selected
            .as_ref()
            .and_then(|request| request["operationId"].as_str());
        if let Some(request) = &selected {
            recovery::record_submission_attempt(&mut journal, operation.unwrap());
            persist(path, &journal)?;
            drop(lease.take());
            let outcome = submit(
                connection,
                instance,
                request,
                &self.plugin_source_device_id(),
            )
            .await;
            journal = self
                .resume_local_sync_journal(connection, path, lease)
                .await?;
            recovery::record_submission_result(&mut journal, operation.unwrap(), &outcome);
            persist(path, &journal)?;
            if !matches!(outcome, Ok(SubmitOutcome::Accepted)) {
                return Err(match outcome {
                    Err(failure) | Ok(SubmitOutcome::Rejected { failure, .. }) => failure,
                    Ok(SubmitOutcome::Superseded) => error("INTENT_SUPERSEDED"),
                    Ok(SubmitOutcome::Accepted) => unreachable!(),
                });
            }
        }
        let installed_plugin_id = params["installedPluginId"]
            .as_u64()
            .filter(|_| selected.is_none() && params["full"] != true);
        let targeted = selected.is_some() || installed_plugin_id.is_some();
        let _reconciliation = if targeted {
            None
        } else {
            // Full checks share scan evidence. Queue them without holding the
            // short journal lease; foreground plugin operations never join it.
            drop(lease.take());
            let guard = scanning::full_reconciliation_gate(path).lock_owned().await;
            journal = self
                .resume_local_sync_journal(connection, path, lease)
                .await?;
            if self.has_foreground_plugin_operation(path) {
                return Err(error("plugin_local_sync_busy"));
            }
            Some(guard)
        };
        if installed_plugin_id.is_some() {
            // Target-only refreshes also fence older full plans after cancellation.
            next_intent_order(&mut journal)?;
            persist(path, &journal)?;
        }
        if !targeted && !journal["pending"].as_array().unwrap().is_empty() {
            if let Err(failure) =
                self.schedule_local_recovery(connection, instance, path, &mut journal)
            {
                if failure.code != "plugin_local_sync_busy" {
                    crate::logging::write_executor_error_line(&failure.code);
                }
            }
        }
        // Only a complete reconciliation can reuse global content evidence.
        // Deltas always fetch a plan and retain the installer's target checks.
        let digest = if targeted {
            None
        } else {
            self.scan_local_plugin_content(&session, &mut journal, lease)
                .await?
        };
        let verified = digest
            .as_ref()
            .is_some_and(|digest| journal["verifiedDigest"].as_str() == Some(digest.as_str()));
        let known_revision = journal["revision"]
            .as_str()
            .filter(|_| verified)
            .map(str::to_owned);
        // Recovery may have settled while the scan ran. Use its current status
        // without losing original requests or replaying an old journal snapshot.
        let pending = journal["pending"].as_array().unwrap().clone();
        let operation_ids: Vec<String> = if let Some(operation) = operation {
            vec![operation.to_owned()]
        } else if !targeted {
            pending
                .iter()
                .filter(|entry| entry["accepted"] == true)
                .filter_map(|entry| entry["operationId"].as_str().map(str::to_owned))
                .take(64)
                .collect()
        } else {
            Vec::new()
        };
        if !targeted && self.has_foreground_plugin_operation(path) {
            return Err(error("plugin_local_sync_busy"));
        }
        let plan_order = journal["nextIntentOrder"].clone();
        let mut plan_request = json!({"protocolVersion":1,"instanceId":instance,"operationId":operation,"recoveryPending":!pending.is_empty() || journal["reconcilePending"] == true,"knownRevision":known_revision,"actualRevision":known_revision,"targeted":targeted,"installedPluginId":installed_plugin_id});
        if capabilities["pluginSyncVersions"]
            .as_array()
            .is_some_and(|versions| versions.contains(&json!(3)))
        {
            plan_request["pluginSyncVersion"] = json!(3);
        }
        crate::logging::log_executor_event(
            "plugin_local_sync_plan",
            &[
                (
                    "protocol_version",
                    plan_request["pluginSyncVersion"]
                        .as_u64()
                        .unwrap_or(2)
                        .to_string(),
                ),
                ("targeted", targeted.to_string()),
            ],
        );
        drop(lease.take());
        let snapshot = post(connection, "/api/plugins/local-sync", &plan_request).await?;
        journal = self
            .resume_local_sync_journal(connection, path, lease)
            .await?;
        if !targeted
            && (journal["nextIntentOrder"] != plan_order
                || self.has_foreground_plugin_operation(path))
        {
            return Err(error("plugin_local_sync_busy"));
        }
        // Profile replacement fences the shared installer as well as this HTTP scope.
        {
            let state = self.state.lock().await;
            if !state
                .profile
                .as_ref()
                .is_some_and(|p| same_account_connection(&p.connection, connection))
            {
                return Err(error("plugin_route_profile_mismatch"));
            }
        }
        if snapshot["unchanged"] == true {
            if !verified
                || !journal["pending"].as_array().unwrap().is_empty()
                || journal["reconcilePending"] == true
                || snapshot["revision"] != journal["revision"]
            {
                return Err(error("plugin_local_invalid_response"));
            }

            return Ok(
                json!({"enabled":capabilities["enabled"], "protocolVersion":1, "localCompleted":true, "unchanged":true, "result":journal["lastResult"]}),
            );
        }
        if !valid_snapshot(&snapshot)
            || (selected.is_some()
                && !matches!(
                    snapshot["operation"]["state"].as_str(),
                    Some("intent_saved" | "superseded")
                ))
        {
            return Err(error("plugin_local_invalid_response"));
        }
        if snapshot["operation"]["state"] == "superseded" {
            recovery::record_submission_result(
                &mut journal,
                operation.unwrap(),
                &Ok(SubmitOutcome::Superseded),
            );
            persist(path, &journal)?;
            return Err(error("INTENT_SUPERSEDED"));
        }
        journal["reconcilePending"] = json!(true);
        persist(path, &journal)?;
        drop(lease.take());
        let result = local_result(
            &snapshot["payload"],
            handler
                .handle_sync_capabilities(snapshot["payload"].clone())
                .await,
        );
        journal = self
            .resume_local_sync_journal(connection, path, lease)
            .await?;
        let completed = result["success"] == true
            && result["plugins"].as_array().is_some_and(|items| {
                items
                    .iter()
                    .all(|item| matches!(item["status"].as_str(), Some("synced" | "removed")))
            });
        if completed {
            let intervening = journal["nextIntentOrder"] != plan_order
                || !targeted && self.has_foreground_plugin_operation(path);
            journal["revision"] = if targeted || intervening {
                Value::Null
            } else {
                snapshot["revision"].clone()
            };
            journal["verifiedDigest"] = Value::Null;
            journal["lastResult"] = result.clone();
            if let Some(operation) = operation {
                journal["pending"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|entry| entry["operationId"].as_str() != Some(operation));
            } else if !targeted {
                journal["pending"].as_array_mut().unwrap().retain(|entry| {
                    !entry["operationId"]
                        .as_str()
                        .is_some_and(|id| operation_ids.iter().any(|item| item == id))
                });
            }
            journal["reconcilePending"] = json!(
                targeted || intervening || !journal["pending"].as_array().unwrap().is_empty()
            );
        }
        persist(path, &journal)?;
        if !completed {
            if result["success"] == true
                && result["plugins"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["status"] == "superseded"))
            {
                if targeted {
                    if let Some(operation) = operation {
                        retire_superseded(&mut journal, operation);
                        persist(path, &journal)?;
                    }
                }
                return Err(error(if targeted {
                    "INTENT_SUPERSEDED"
                } else {
                    "plugin_local_sync_busy"
                }));
            }
            return Err(error("plugin_local_apply_failed"));
        }
        if !targeted
            && journal["nextIntentOrder"] == plan_order
            && !self.has_foreground_plugin_operation(path)
        {
            let digest = self
                .scan_local_plugin_content(&session, &mut journal, lease)
                .await?;
            journal["verifiedDigest"] = json!(digest);
            persist(path, &journal)?;
        }
        Ok(
            json!({"enabled":capabilities["enabled"],"protocolVersion":1,"localCompleted":true,"operation":snapshot["operation"],"result":result}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn mutation_transports_the_persisted_order_and_requires_its_acknowledgement() {
        use axum::{extract::Query, response::IntoResponse, routing::delete, Json, Router};
        use std::collections::HashMap;
        async fn mutate(Query(params): Query<HashMap<String, String>>) -> axum::response::Response {
            assert_eq!(params["local_intent_order"], "42");
            assert_eq!(params["local_instance_id"], "native");
            if params["operation_id"] == "older" {
                return (
                    axum::http::StatusCode::CONFLICT,
                    Json(json!({"detail":"INTENT_SUPERSEDED"})),
                )
                    .into_response();
            }
            let mut response = axum::http::StatusCode::NO_CONTENT.into_response();
            response
                .headers_mut()
                .insert("X-Plugin-Delivery-Mode", "local_pull_v1".parse().unwrap());
            response.headers_mut().insert(
                "X-Plugin-Operation-Id",
                params["operation_id"].parse().unwrap(),
            );
            if params["operation_id"] != "unconfirmed" {
                response
                    .headers_mut()
                    .insert("X-Plugin-Intent-Order", "42".parse().unwrap());
            }
            response
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connection = ConnectionConfig {
            backend_url: format!("http://{}", listener.local_addr().unwrap()),
            auth_token: "test-token".into(),
            ..ConnectionConfig::default()
        };
        let router = Router::new().route("/api/plugins/installed/7", delete(mutate));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        for (operation, expected) in [
            ("accepted", None),
            ("older", Some("INTENT_SUPERSEDED")),
            ("unconfirmed", Some("plugin_local_acceptance_unconfirmed")),
        ] {
            let request =
                json!({"action":"uninstall","targetId":7,"operationId":operation,"intentOrder":42});
            let result = submit(&connection, "native", &request, "").await;
            match expected {
                None => assert!(matches!(result.unwrap(), SubmitOutcome::Accepted)),
                Some(code) => assert_eq!(result.unwrap_err().code, code),
            }
        }
        server.abort();
        let _ = server.await;
    }

    #[test]
    fn intent_order_survives_restart_and_superseded_recovery_retires_only_its_request() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal.json");
        let mut journal = json!({"version":1,"pending":[],"receipts":[]});
        let first = next_intent_order(&mut journal).unwrap();
        journal["pending"] = json!([{"operationId":"old-remove","action":"uninstall","intentOrder":first,"targetId":7}]);
        persist(&path, &journal).unwrap();
        let mut journal = load_journal(&path).unwrap();
        assert_eq!(next_intent_order(&mut journal).unwrap(), first + 1);
        journal["pending"].as_array_mut().unwrap().push(
            json!({"operationId":"other-plugin","action":"install","intentOrder":2,"targetId":8}),
        );
        retire_superseded(&mut journal, "old-remove");
        persist(&path, &journal).unwrap();
        let mut journal = load_journal(&path).unwrap();
        assert_eq!(journal["pending"].as_array().unwrap().len(), 1);
        assert_eq!(journal["pending"][0]["operationId"], "other-plugin");
        assert_eq!(journal["reconcilePending"], true);
        assert_eq!(next_intent_order(&mut journal).unwrap(), first + 2);
        journal["nextIntentOrder"] = json!(i64::MAX);
        assert!(next_intent_order(&mut journal).is_err());
    }

    #[test]
    fn an_unusable_optional_device_hint_does_not_gate_local_execution() {
        assert_eq!(optional_origin("runtime-1"), "runtime-1");
        for value in ["", "device with spaces", "../device", "_device"] {
            assert_eq!(optional_origin(value), "");
        }
    }

    #[test]
    fn a_failed_older_operation_does_not_block_a_new_target_or_starve_recovery() {
        let pending = vec![
            json!({"operationId":"failed","lastAttemptAt":20}),
            json!({"operationId":"recover","lastAttemptAt":0}),
            json!({"operationId":"new","lastAttemptAt":10}),
        ];
        assert_eq!(
            select_pending(&pending, &json!({"action":"install"})).unwrap()["operationId"],
            "new"
        );
        assert_eq!(
            recovery::select_pending(&pending).unwrap()["operationId"],
            "recover"
        );
        assert!(select_pending(&pending, &json!({"full":true})).is_none());
        assert!(select_pending(&pending, &json!({"installedPluginId":7})).is_none());
    }

    #[test]
    fn rejected_installation_does_not_create_an_unreportable_or_successful_receipt() {
        let payload = json!({"scope":"plugin_delta","plugin_sync":{"version":2,"generation":3,"complete":false},"plugins":[{"installed_plugin_id":7}]});
        let result = local_result(&payload, json!({"success":false,"error":"invalid package"}));
        assert_eq!(result["success"], false);
        assert_eq!(result["plugins"][0]["id"], 7);
        assert_eq!(result["plugins"][0]["status"], "failed");
        assert_eq!(result["plugin_sync"], payload["plugin_sync"]);
    }

    #[tokio::test]
    async fn supersession_requires_matching_backend_proof() {
        use axum::{response::IntoResponse, routing::delete, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connection = ConnectionConfig {
            backend_url: format!("http://{}", listener.local_addr().unwrap()),
            auth_token: "token".into(),
            ..Default::default()
        };
        let router = Router::new().route(
            "/api/plugins/installed/7",
            delete(
                |axum::extract::Query(q): axum::extract::Query<
                    std::collections::HashMap<String, String>,
                >| async move {
                    let mut response = (
                        axum::http::StatusCode::CONFLICT,
                        axum::Json(json!({"detail":"INTENT_SUPERSEDED"})),
                    )
                        .into_response();
                    if q["operation_id"] == "proven" {
                        for (key, value) in [
                            ("X-Plugin-Delivery-Mode", "local_pull_v1"),
                            ("X-Plugin-Operation-Id", "proven"),
                            ("X-Plugin-Intent-Order", "7"),
                            ("X-Plugin-Operation-State", "superseded"),
                        ] {
                            response.headers_mut().insert(key, value.parse().unwrap());
                        }
                    }
                    response
                },
            ),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        for operation in ["proven", "unconfirmed"] {
            let request =
                json!({"operationId":operation,"intentOrder":7,"action":"uninstall","targetId":7});
            let result = submit(&connection, "native", &request, "").await;
            if operation == "proven" {
                assert!(matches!(result, Ok(SubmitOutcome::Superseded)));
            } else {
                assert!(result.is_err());
            }
        }
        server.abort();
    }

    #[test]
    fn http_sync_cannot_downgrade_to_an_unversioned_installer_payload() {
        let mut snapshot = json!({"protocolVersion":1,"generation":3,"snapshotId":"issued","revision":"a".repeat(64),"payload":{"scope":"plugins","mode":"merge","plugins":[],"plugin_sync":{"version":2,"generation":3,"complete":true}}});
        assert!(valid_snapshot(&snapshot));
        snapshot["payload"]["plugin_sync"] = Value::Null;
        assert!(!valid_snapshot(&snapshot));
        assert!(!valid_snapshot(&json!({"payload":{}})));
    }

    #[test]
    fn journal_is_atomic_and_retains_operation_without_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal.json");
        let journal = json!({"version":1,"pending":[{"operationId":"id","action":"uninstall","targetId":1}],"receipts":[]});
        persist(&path, &journal).unwrap();
        assert_eq!(load(&path).unwrap(), journal);
        assert_eq!(
            instance_id(temp.path()).unwrap(),
            instance_id(temp.path()).unwrap()
        );
        std::fs::write(&path, br#"{"version":1,"pending":[7],"receipts":[]}"#).unwrap();
        assert!(load_journal(&path).is_err());
        std::fs::write(&path, b"broken").unwrap();
        assert!(load(&path).is_err());
    }
}
