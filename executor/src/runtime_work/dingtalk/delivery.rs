//! Source-bound, durable delivery of automatically authorized DingTalk replies.
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wegent_local_task_store::StandInDeliveryTransaction;

use crate::local::app_ipc::AppIpcError;
use crate::runtime_work::local_connector_auth::{
    prepare_declared_plugin_tool, run_declared_plugin_tool, PreparedPluginTool,
};
use crate::task_runtime::LocalTaskStore;

use super::{invalid, reply_args, required, validate_reply_text};

pub(crate) struct DeliveryIdentity<'a> {
    pub(crate) user_id: i64,
    pub(crate) account_id: &'a str,
    pub(crate) organization_id: &'a str,
}

impl DeliveryIdentity<'_> {
    fn profile(&self) -> String {
        format!("{}:{}", self.organization_id, self.account_id)
    }
}

pub(crate) struct DeliveryInput<'a> {
    pub(crate) text: &'a str,
    pub(crate) evidence: &'a Value,
}

pub(crate) struct PreparedReply(PreparedPluginTool);

static ACTIVE_DELIVERIES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct InFlightDelivery(String);

impl InFlightDelivery {
    fn start(id: String) -> Self {
        if let Ok(mut active) = ACTIVE_DELIVERIES.get_or_init(Mutex::default).lock() {
            active.insert(id.clone());
        }
        Self(id)
    }
}

impl Drop for InFlightDelivery {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_DELIVERIES.get_or_init(Mutex::default).lock() {
            active.remove(&self.0);
        }
    }
}

pub(crate) fn delivery_in_flight(record: &Value) -> bool {
    record["attemptId"].as_str().is_some_and(|id| {
        ACTIVE_DELIVERIES
            .get()
            .is_some_and(|active| active.lock().is_ok_and(|active| active.contains(id)))
    })
}

pub(crate) async fn prepare_reply() -> Result<PreparedReply, AppIpcError> {
    prepare_declared_plugin_tool("dingtalk", "dws")
        .await
        .map(PreparedReply)
        .map_err(|error| AppIpcError::new(error.code, "DingTalk transport could not be prepared"))
}

impl PreparedReply {
    pub(crate) async fn reply_once(
        self,
        store: &LocalTaskStore,
        source: &Value,
        message: &Value,
        identity: &DeliveryIdentity<'_>,
        input: DeliveryInput<'_>,
        final_gate: impl FnOnce(&StandInDeliveryTransaction<'_>) -> Result<(), AppIpcError>,
    ) -> Result<Value, AppIpcError> {
        validate_reply_text(input.text)?;
        let id = delivery_key(source, message, identity)?;
        // Bind the DWS invocation to both parts of the authenticated profile.
        let args = reply_args(&identity.profile(), message, input.text, &id)?;
        let mut record = new_delivery(&id, message, &input);
        let mut _in_flight = None;
        if let Some(existing) = reserve_delivery(store, &mut record, |transaction| {
            final_gate(transaction)?;
            _in_flight = Some(InFlightDelivery::start(id));
            Ok(())
        })? {
            return Ok(existing);
        }

        // A committed attempt is in flight. Start the prepared command without
        // yielding, and never replay a committed attempt after losing its outcome.
        let response = self.0.run(&args).await;
        apply_submit_result(&mut record, response);
        let record = write_delivery_result(store, record)?;
        if record["status"] == "unknown" && record["channelTaskId"].is_string() {
            return query_delivery_status(store, identity, record).await;
        }
        Ok(record)
    }
}

pub(crate) fn delivery_record(
    store: &LocalTaskStore,
    source: &Value,
    message: &Value,
    identity: &DeliveryIdentity<'_>,
) -> Result<Option<Value>, AppIpcError> {
    read_delivery(store, &delivery_key(source, message, identity)?)
}

/// Recheck an unresolved channel task without submitting another message.
/// The caller must verify the current connector account before calling this.
pub(crate) async fn refresh_delivery(
    store: &LocalTaskStore,
    source: &Value,
    message: &Value,
    identity: &DeliveryIdentity<'_>,
) -> Result<Option<Value>, AppIpcError> {
    let Some(record) = delivery_record(store, source, message, identity)? else {
        return Ok(None);
    };
    if record["status"] != "unknown" || !record["channelTaskId"].is_string() {
        return Ok(Some(record));
    }
    query_delivery_status(store, identity, record)
        .await
        .map(Some)
}

fn delivery_key(
    source: &Value,
    message: &Value,
    identity: &DeliveryIdentity<'_>,
) -> Result<String, AppIpcError> {
    if [identity.account_id, identity.organization_id]
        .into_iter()
        .any(|part| !valid_channel_id(part) || part.contains(':'))
    {
        return Err(invalid("Missing DingTalk account or organization identity"));
    }
    if source["kind"] == "group" && source["id"] != message["conversationId"] {
        return Err(invalid(
            "DingTalk group does not match the original conversation",
        ));
    }
    if source["kind"] == "direct" && source["id"] != message["senderId"] {
        return Err(invalid("DingTalk peer does not match the original sender"));
    }
    // Different roles, profiles and drafts targeting the same message share a claim.
    let binding = json!([
        "dingtalk",
        identity.user_id,
        identity.account_id,
        identity.organization_id,
        required(message, "conversationId")?,
        required(message, "id")?,
    ]);
    Ok(format!(
        "{:x}",
        Sha256::digest(binding.to_string().as_bytes())
    ))
}

fn new_delivery(id: &str, message: &Value, input: &DeliveryInput<'_>) -> Value {
    json!({
        "attemptId": id,
        "status": "unknown",
        "reason": "channel_result_unconfirmed",
        "conversationId": message["conversationId"],
        "messageId": message["id"],
        "receivedAt": message["at"],
        "replyText": input.text,
        "evidence": input.evidence,
    })
}

fn reserve_delivery(
    store: &LocalTaskStore,
    record: &mut Value,
    final_gate: impl FnOnce(&StandInDeliveryTransaction<'_>) -> Result<(), AppIpcError>,
) -> Result<Option<Value>, AppIpcError> {
    let id = required(record, "attemptId")?.to_owned();
    store
        .reserve_stand_in_delivery(&id, record, final_gate)
        .map_err(storage_error)?
}

fn read_delivery(store: &LocalTaskStore, id: &str) -> Result<Option<Value>, AppIpcError> {
    store.read_stand_in_delivery(id).map_err(storage_error)
}

fn write_delivery_result(store: &LocalTaskStore, mut record: Value) -> Result<Value, AppIpcError> {
    record["updatedAt"] = json!(timestamp());
    let id = required(&record, "attemptId")?;
    store
        .write_stand_in_delivery_result(id, &record)
        .map_err(storage_error)
}

fn apply_submit_result(record: &mut Value, response: Result<Value, AppIpcError>) {
    match response {
        Ok(response) if response["success"] == true => {
            if let Some(task) = channel_id(&response["result"]["openTaskId"]) {
                record["channelTaskId"] = json!(task);
            }
            apply_channel_receipt(record, &response);
        }
        Err(error) => {
            if error.code == "connection_cli_unavailable" {
                // The local launcher reports this code only when spawn fails.
                record["status"] = json!("definite_failure");
            }
            record["reason"] = json!(error.code);
        }
        Ok(_) => {}
    }
}

async fn query_delivery_status(
    store: &LocalTaskStore,
    identity: &DeliveryIdentity<'_>,
    mut record: Value,
) -> Result<Value, AppIpcError> {
    let args = [
        "chat",
        "message",
        "query-send-status",
        "--open-task-id",
        required(&record, "channelTaskId")?,
        "--profile",
        &identity.profile(),
        "--format",
        "json",
    ]
    .map(str::to_owned);
    let response = run_declared_plugin_tool("dingtalk", "dws", &args).await;
    if response.is_ok_and(|receipt| apply_channel_receipt(&mut record, &receipt)) {
        return write_delivery_result(store, record);
    }
    read_delivery(store, required(&record, "attemptId")?)?
        .ok_or_else(|| storage_error("Missing attempt"))
}

fn apply_channel_receipt(record: &mut Value, response: &Value) -> bool {
    if response["success"] != true {
        return false;
    }
    let result = &response["result"];
    let Some(id) = channel_id(&result["openMessageId"]) else {
        return false;
    };
    if record["messageId"] == id
        || (!result["openConversationId"].is_null()
            && result["openConversationId"] != record["conversationId"])
        || (!result["openTaskId"].is_null()
            && !record["channelTaskId"].is_null()
            && result["openTaskId"] != record["channelTaskId"])
    {
        return false;
    }
    record["status"] = json!("confirmed_sent");
    record["reason"] = Value::Null;
    record["receipt"] = json!({
        "provider": "dingtalk",
        "messageId": id,
        "conversationId": record["conversationId"],
        "confirmedAt": timestamp(),
    });
    true
}

fn channel_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| valid_channel_id(id))
}

fn valid_channel_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 512 && !id.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn storage_error(_: impl std::fmt::Display) -> AppIpcError {
    AppIpcError::new(
        "dingtalk_delivery_store_unavailable",
        "DingTalk delivery state could not be accessed",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> DeliveryIdentity<'static> {
        DeliveryIdentity {
            user_id: 1,
            account_id: "ding-user",
            organization_id: "ding-org",
        }
    }

    fn message() -> Value {
        json!({
            "id": "source-message",
            "senderId": "sender",
            "conversationId": "conversation",
            "at": "2026-11-24T02:00:00Z",
        })
    }

    fn record() -> Value {
        new_delivery(
            "attempt",
            &message(),
            &DeliveryInput {
                text: "See the original conversation",
                evidence: &json!(["evidence-message"]),
            },
        )
    }

    #[test]
    fn provider_identity_and_original_conversation_scope_the_attempt() {
        let source = json!({"kind":"group", "id":"conversation", "profile":"old-alias"});
        let renamed = json!({"kind":"group", "id":"conversation", "profile":"new-alias"});
        let message = message();
        let identity = identity();
        assert_eq!(identity.profile(), "ding-org:ding-user");
        let key = delivery_key(&source, &message, &identity).unwrap();
        assert_eq!(key, delivery_key(&renamed, &message, &identity).unwrap());
        for other in [
            DeliveryIdentity {
                user_id: 2,
                ..identity
            },
            DeliveryIdentity {
                account_id: "other-user",
                ..identity
            },
            DeliveryIdentity {
                organization_id: "other-org",
                ..identity
            },
        ] {
            assert_ne!(key, delivery_key(&source, &message, &other).unwrap());
        }
        assert!(delivery_key(
            &json!({"kind":"group", "id":"another"}),
            &message,
            &identity
        )
        .is_err());
    }

    #[test]
    fn durable_attempt_serializes_independent_stores_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.db");
        let store = LocalTaskStore::open(&path).unwrap();
        let other_store = LocalTaskStore::open(&path).unwrap();
        let barrier = std::sync::Barrier::new(2);
        let mut first = record();
        let mut second = record();
        second["replyText"] = json!("Another model output");
        let outcomes = std::thread::scope(|scope| {
            let a = scope.spawn(|| {
                barrier.wait();
                reserve_delivery(&store, &mut first, |_| Ok(())).unwrap()
            });
            let b = scope.spawn(|| {
                barrier.wait();
                reserve_delivery(&other_store, &mut second, |_| Ok(())).unwrap()
            });
            [a.join().unwrap(), b.join().unwrap()]
        });
        assert_eq!(
            outcomes.iter().filter(|outcome| outcome.is_none()).count(),
            1
        );
        drop(store);
        drop(other_store);
        let reopened = LocalTaskStore::open(&path).unwrap();
        let persisted = read_delivery(&reopened, "attempt").unwrap().unwrap();
        assert_eq!(&persisted, outcomes.iter().flatten().next().unwrap());
        assert_eq!(persisted["status"], "unknown");
        assert!(reserve_delivery(&reopened, &mut first, |_| panic!(
            "An existing claim never sends"
        ))
        .unwrap()
        .is_some());

        let mut confirmed = persisted.clone();
        assert!(apply_channel_receipt(
            &mut confirmed,
            &json!({"success":true,"result":{"openMessageId":"reply"}}),
        ));
        let confirmed = write_delivery_result(&reopened, confirmed).unwrap();
        assert_eq!(
            write_delivery_result(&reopened, persisted).unwrap(),
            confirmed
        );
    }

    #[test]
    fn a_final_gate_rejection_does_not_create_a_delivery_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(dir.path().join("tasks.db")).unwrap();
        let denied = reserve_delivery(&store, &mut record(), |_| {
            Err(AppIpcError::new("paused", "The source was paused"))
        })
        .unwrap_err();
        assert_eq!(denied.code, "paused");
        assert!(read_delivery(&store, "attempt").unwrap().is_none());
    }

    #[test]
    fn channel_task_acceptance_and_transport_errors_do_not_confirm_delivery() {
        let mut record = record();
        apply_submit_result(
            &mut record,
            Ok(json!({"success":true,"result":{"openTaskId":"task"}})),
        );
        assert_eq!(record["status"], "unknown");
        assert_eq!(record["channelTaskId"], "task");
        assert!(record["receipt"].is_null());
        apply_submit_result(
            &mut record,
            Err(AppIpcError::new("connection_cli_timeout", "timeout")),
        );
        assert_eq!(record["status"], "unknown");
        apply_submit_result(
            &mut record,
            Err(AppIpcError::new(
                "connection_cli_unavailable",
                "could not start",
            )),
        );
        assert_eq!(record["status"], "definite_failure");
    }

    #[test]
    fn a_channel_receipt_requires_a_new_message_with_matching_binding() {
        let mut record = record();
        record["channelTaskId"] = json!("task");
        for bad_receipt in [
            json!({"success":true,"result":{"openMessageId":"source-message"}}),
            json!({"success":true,"result":{"openMessageId":"reply","openConversationId":"different"}}),
            json!({"success":true,"result":{"openMessageId":"reply","openTaskId":"other-task"}}),
            json!({"success":false,"result":{"openMessageId":"reply"}}),
        ] {
            assert!(!apply_channel_receipt(&mut record, &bad_receipt));
        }
        assert!(apply_channel_receipt(
            &mut record,
            &json!({
                "success":true,"result":{"openMessageId":"reply","openConversationId":"conversation","openTaskId":"task"},
            })
        ));
        assert_eq!(record["status"], "confirmed_sent");
        assert_eq!(record["receipt"]["messageId"], "reply");
        assert_eq!(record["receipt"]["conversationId"], "conversation");
    }
}
