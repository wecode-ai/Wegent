use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wegent_protocol::connection_events::{
    canonical_json, event_identity, matches_activation, matches_event,
    matches_subscription_request, observation_identity, validate_filter,
};

const LEASE_MS: i64 = 60_000;
type Result<T> = std::result::Result<T, &'static str>;

pub(super) fn empty() -> Value {
    json!({"version":2,"observations":{},"subscriptions":{},"deliveries":{}})
}
pub(super) fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical_json(value).as_bytes()))
}
pub(super) fn subscription_identity(device: &Value, task: &Value, key: &Value) -> String {
    hash(&json!([device, task, key]))
}
pub(super) fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 16_384)
        .ok_or("invalid_observation_input")
}
fn token() -> Result<Value> {
    let token = crate::random_token_urlsafe(32);
    if token.is_empty() {
        return Err("observation_entropy_failed");
    }
    Ok(json!(token))
}

pub(super) fn event_time(value: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|time| time.timestamp_millis())
}

pub(super) fn valid_activation(source: &Value) -> bool {
    event_time(&source["enabledAfter"]).is_some()
        && source
            .get("boundary")
            .filter(|value| !value.is_null())
            .is_none_or(|boundary| {
                boundary["partition"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                    && boundary["sequence"].as_u64().is_some()
            })
}

pub(super) fn apply(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    super::validation::validate(state)?;
    super::collector::upgrade_validated(state);
    match text(input, "action")? {
        "attach" => attach(state, input, now),
        "observe" => super::observers::observe(state, input, now),
        "renew_observer" => super::observers::renew(state, input, now),
        "stop_observer" => super::observers::stop(state, input, now),
        "cancel_registration" => {
            let attached = attach(state, input, now)?;
            cancel(
                state,
                &json!({"subscriptionId":attached["subscriptionId"]}),
                now,
            )
        }
        "list" => Ok(
            json!({"observations":state["observations"],"subscriptions":state["subscriptions"],"deliveries":state["deliveries"]}),
        ),
        "get_subscription" => get_subscription(state, input),
        "get_task_subscriptions" => get_task_subscriptions(state, input),
        "ack_projection" => ack_projection(state, input),
        "cancel" => cancel(state, input, now),
        "refresh" => refresh(state, input),
        "claim" => claim(state, now),
        "renew" => renew(state, input, now),
        "fail" => fail(state, input, now),
        "read_lease" => Ok(json!({"observation":leased(state,input,now)?})),
        "commit" => commit(state, input, now),
        "claim_delivery" => claim_delivery(state, now),
        "renew_delivery" => renew_delivery(state, input, now),
        "admit_delivery" => admit_delivery(state, input, now),
        "ack_delivery" => ack_delivery(state, input, now),
        _ => Err("invalid_observation_action"),
    }
}

fn ack_projection(state: &mut Value, input: &Value) -> Result<Value> {
    let id = text(input, "subscriptionId")?;
    let row = state["subscriptions"]
        .get_mut(id)
        .ok_or("observation_subscription_unavailable")?;
    if row["status"] != "cancelled" {
        return Err("observation_projection_conflict");
    }
    row["terminalSynced"] = json!(true);
    Ok(json!({"acknowledged":true}))
}

pub(super) fn get_subscription(state: &Value, input: &Value) -> Result<Value> {
    let id = text(input, "subscriptionId")?;
    let subscription = state["subscriptions"]
        .get(id)
        .ok_or("observation_subscription_unavailable")?;
    let observation = &state["observations"][subscription["observationId"]
        .as_str()
        .ok_or("observation_storage_conflict")?];
    let delivery = subscription["deliveryId"]
        .as_str()
        .and_then(|id| state["deliveries"].get(id))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(
        json!({"subscription":subscription,"observation":observation_projection(observation),"delivery":delivery}),
    )
}

pub(super) fn observation_projection(observation: &Value) -> Value {
    json!({"id":observation["id"],"source":observation["source"],"lastCollectedAt":observation["lastCollectedAt"],"errorCode":observation["errorCode"],"resourceStates":observation["resourceStates"],"refreshPending":observation["forceVersion"]!=observation["collectedForceVersion"]})
}

pub(super) fn validate_source(source: &Value) -> Result<()> {
    for key in ["providerId", "profile", "kind", "id", "name"] {
        text(source, key)?;
    }
    if !valid_activation(source) {
        return Err("invalid_observation_activation");
    }
    Ok(())
}

pub(super) fn ensure_observation(
    state: &mut Value,
    source: &Value,
    collector: &super::collector::Collector,
    checkpoint: &Value,
    now: i64,
) -> Result<String> {
    let id = collector.observation_id(source);
    if state["observations"][&id].is_null() || !active_observations(state, now).contains(&id) {
        if !checkpoint.is_object() {
            return Err("observation_checkpoint_required");
        }
        let sequence = state["observations"][&id]["sequence"]
            .as_u64()
            .unwrap_or_default();
        state["observations"][&id] = json!({"id":id,"collector":collector.value(),"source":source,"checkpoint":checkpoint,"sequence":sequence,"events":[],"nextPollAt":0,"forceVersion":0,"idle":false,"suspended":false,"failureCount":0,"collectedForceVersion":0,"lease":null});
    }
    Ok(id)
}

fn get_task_subscriptions(state: &Value, input: &Value) -> Result<Value> {
    let device = text(input, "deviceId")?;
    let task = text(input, "taskId")?;
    let subscriptions = state["subscriptions"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, row)| {
            row["intent"]["target"]["deviceId"] == device
                && row["intent"]["target"]["taskId"] == task
        })
        .map(|(id, _)| get_subscription(state, &json!({"subscriptionId":id})))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"subscriptions":subscriptions}))
}

fn leased_delivery<'a>(state: &'a mut Value, input: &Value, now: i64) -> Result<&'a mut Value> {
    let id = text(input, "deliveryId")?;
    let delivery = state["deliveries"]
        .get_mut(id)
        .ok_or("observation_delivery_unavailable")?;
    if delivery["status"] != "pending"
        || delivery["lease"]["id"] != input["leaseId"]
        || delivery["lease"]["expiresAt"].as_i64().unwrap_or_default() <= now
    {
        return Err("observation_delivery_lease_lost");
    }
    Ok(delivery)
}

fn renew_delivery(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let delivery = leased_delivery(state, input, now)?;
    delivery["lease"]["expiresAt"] = json!(now + LEASE_MS);
    Ok(json!({"lease":delivery["lease"]}))
}

fn admit_delivery(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let delivery = leased_delivery(state, input, now)?;
    if delivery["subscriptionId"] != input["subscriptionId"]
        || delivery["intent"]["target"]["deviceId"] != input["deviceId"]
        || delivery["intent"]["target"]["taskId"] != input["taskId"]
    {
        return Err("observation_delivery_target_conflict");
    }
    record_admission(delivery, input, now)
}

fn record_admission(delivery: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let operation = text(input, "operationId")?;
    if delivery["admission"].is_object() {
        if delivery["admission"]["operationId"] != operation {
            return Err("observation_delivery_admission_conflict");
        }
    } else {
        delivery["admission"] = json!({"operationId":operation,"at":now});
    }
    Ok(json!({"admitted":true,"admission":delivery["admission"]}))
}

fn attach(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let subscription = &input["subscription"];
    for key in ["subscription_key", "continuation"] {
        text(subscription, key)?;
    }
    let (target, collector) = super::target::Target::registration(subscription)?;
    if subscription
        .get("wait_for_event")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("invalid_observation_input");
    }
    let wait_for_event = subscription["wait_for_event"].as_bool().unwrap_or(false);
    validate_source(&subscription["source"])?;
    let filter = subscription
        .get("match")
        .cloned()
        .unwrap_or_else(|| json!({}));
    validate_filter(&filter)?;
    let source = observation_identity(&subscription["source"]);
    let id = target.subscription_id(&subscription["subscription_key"]);
    let intent = json!({"source":source,"target":target.value(),"match":filter,"continuation":subscription["continuation"],"goalIdentity":subscription["waiting_goal"]});
    let request_intent = subscription.get("request_intent");
    if request_intent.is_some_and(|request| {
        !matches_subscription_request(request, &intent, &json!(wait_for_event))
    }) {
        return Err("invalid_observation_request_intent");
    }
    if let Some(previous) = state["subscriptions"].get_mut(&id) {
        if previous["intent"] != intent
            || previous
                .get("subscriptionKey")
                .is_some_and(|key| key != &subscription["subscription_key"])
            || previous
                .get("waitForEvent")
                .is_some_and(|value| value.as_bool() != Some(wait_for_event))
            || request_intent.is_some_and(|request| {
                previous
                    .get("requestIntent")
                    .is_some_and(|value| value != request)
            })
        {
            return Err("observation_subscription_conflict");
        }
        // Backfill only from the original authenticated, hash-identical request.
        previous["subscriptionKey"] = subscription["subscription_key"].clone();
        previous["waitForEvent"] = json!(wait_for_event);
        if let Some(request) = request_intent {
            previous["requestIntent"] = request.clone();
        }
        return Ok(json!({"subscriptionId":id,"subscription":previous}));
    }
    let observation = ensure_observation(
        state,
        &subscription["source"],
        &collector,
        &input["initialCheckpoint"],
        now,
    )?;
    let after_sequence = wegent_protocol::connection_events::activation_sequence(
        &subscription["source"],
        &state["observations"][&observation],
        event_time,
    );
    state["subscriptions"][&id] = json!({"id":id,"subscriptionKey":subscription["subscription_key"],"waitForEvent":wait_for_event,"intent":intent,"activation":subscription["source"],"observationId":observation,"afterSequence":after_sequence,"status":"armed"});
    if let Some(request) = request_intent {
        state["subscriptions"][&id]["requestIntent"] = request.clone();
    }
    let retained = state["observations"][&observation]["events"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let matching: Vec<_> = retained
        .iter()
        .filter(|entry| {
            entry["sequence"].as_u64().unwrap_or_default() > after_sequence
                && matches_activation(&subscription["source"], &entry["event"], event_time)
                && matches_event(&filter, &entry["event"])
        })
        .collect();
    if !matching.is_empty() {
        let (delivery_id, delivery) = pending_delivery(&mut state["subscriptions"][&id], &matching);
        state["deliveries"][delivery_id] = delivery;
    }
    Ok(json!({"subscriptionId":id,"subscription":state["subscriptions"][&id]}))
}

pub(super) fn cancel(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let id = text(input, "subscriptionId")?;
    if !state["subscriptions"][id].is_object() {
        return Err("observation_subscription_unavailable");
    }
    let delivery_admitted = state["subscriptions"][id]["deliveryId"]
        .as_str()
        .is_some_and(|delivery| state["deliveries"][delivery]["admission"].is_object());
    state["subscriptions"][id]["status"] = json!("cancelled");
    for delivery in state["deliveries"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .filter(|row| row["subscriptionId"] == id && row["status"] != "accepted")
    {
        delivery["status"] = json!("cancelled");
        delivery["lease"] = Value::Null;
    }
    revoke_idle_leases(state, now);
    Ok(json!({"subscription":state["subscriptions"][id],"deliveryAdmitted":delivery_admitted}))
}

fn active_observations(state: &Value, now: i64) -> std::collections::HashSet<String> {
    state["subscriptions"]
        .as_object()
        .unwrap()
        .values()
        .filter(|row| matches!(row["status"].as_str(), Some("armed" | "pending")))
        .map(|row| row["observationId"].as_str().unwrap().to_owned())
        .chain(
            state["observers"]
                .as_object()
                .into_iter()
                .flat_map(|rows| rows.values())
                .filter(|row| {
                    row["stopped"] != true && row["expiresAt"].as_i64().unwrap_or_default() > now
                })
                .map(|row| row["observationId"].as_str().unwrap().to_owned()),
        )
        .collect()
}

pub(super) fn revoke_idle_leases(state: &mut Value, now: i64) {
    let active = active_observations(state, now);
    for (id, observation) in state["observations"].as_object_mut().unwrap() {
        if !active.contains(id) {
            observation["lease"] = Value::Null;
            observation["idle"] = json!(true);
        }
    }
}
fn refresh(state: &mut Value, input: &Value) -> Result<Value> {
    let id = text(input, "observationId")?;
    let observation = state["observations"]
        .get_mut(id)
        .filter(|row| row.is_object())
        .ok_or("observation_unavailable")?;
    observation["forceVersion"] =
        json!(observation["forceVersion"].as_u64().unwrap_or_default() + 1);
    observation["nextPollAt"] = json!(0);
    observation["suspended"] = json!(false);
    Ok(json!({"observation":observation}))
}
fn collection_due(row: &Value) -> i64 {
    row["nextPollAt"]
        .as_i64()
        .unwrap_or_default()
        .max(row["lease"]["expiresAt"].as_i64().unwrap_or_default())
}

fn claim(state: &mut Value, now: i64) -> Result<Value> {
    revoke_idle_leases(state, now);
    let active = active_observations(state, now);
    let row = state["observations"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .filter(|row| {
            active.contains(row["id"].as_str().unwrap_or_default())
                && row["suspended"] != true
                && row["nextPollAt"].as_i64().unwrap_or_default() <= now
                && row["lease"]["expiresAt"].as_i64().unwrap_or_default() <= now
        })
        .min_by(|left, right| {
            collection_due(left)
                .cmp(&collection_due(right))
                .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
        });
    let Some(row) = row else {
        return Ok(json!({"lease":null}));
    };
    row["lease"] =
        json!({"id":token()?,"expiresAt":now+LEASE_MS,"forceVersion":row["forceVersion"]});
    Ok(json!({"lease":row["lease"],"observation":row}))
}
fn leased<'a>(state: &'a mut Value, input: &Value, now: i64) -> Result<&'a mut Value> {
    let id = text(input, "observationId")?;
    if !active_observations(state, now).contains(id) {
        return Err("observation_lease_lost");
    }
    let row = state["observations"]
        .get_mut(id)
        .ok_or("observation_unavailable")?;
    if row["lease"]["id"] != input["leaseId"]
        || row["lease"]["expiresAt"].as_i64().unwrap_or_default() <= now
    {
        return Err("observation_lease_lost");
    }
    Ok(row)
}
fn renew(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let row = leased(state, input, now)?;
    row["lease"]["expiresAt"] = json!(now + LEASE_MS);
    Ok(json!({"lease":row["lease"]}))
}

fn finish_collection(row: &mut Value, page: &Value, now: i64) -> Result<()> {
    let error = page.get("errorCode").filter(|value| !value.is_null());
    if error.is_some_and(|error| {
        error
            .as_str()
            .is_none_or(|code| code.is_empty() || code.len() > 256)
    }) {
        return Err("invalid_observation_error");
    }
    let retry = page
        .get("retryAfterMs")
        .map(|value| {
            value
                .as_i64()
                .filter(|delay| (1..=3_600_000).contains(delay))
                .ok_or("invalid_observation_retry")
        })
        .transpose()?;
    let failures = if error.is_some() {
        row["failureCount"].as_u64().unwrap() + 1
    } else {
        0
    };
    let refresh_pending = row["forceVersion"] != row["lease"]["forceVersion"];
    row["errorCode"] = error.cloned().unwrap_or(Value::Null);
    row["failureCount"] = json!(failures);
    row["suspended"] = json!(error.is_some() && retry.is_none() && !refresh_pending);
    let delay = retry
        .map(|delay| {
            delay
                .saturating_mul(1_i64 << failures.saturating_sub(1).min(20))
                .min(3_600_000)
        })
        .unwrap_or(15_000);
    row["nextPollAt"] = json!(if refresh_pending { 0 } else { now + delay });
    row["collectedForceVersion"] = row["lease"]["forceVersion"].clone();
    row["lease"] = Value::Null;
    Ok(())
}
fn fail(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    if !input["errorCode"].is_string() {
        return Err("invalid_observation_error");
    }
    let row = leased(state, input, now)?;
    finish_collection(row, input, now)?;
    Ok(json!({"accepted":true,"collected":false,"errorCode":row["errorCode"]}))
}

fn commit(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let id = text(input, "observationId")?.to_owned();
    if state["observations"][&id]["lastCommit"]["leaseId"].is_string()
        && state["observations"][&id]["lastCommit"]["leaseId"] == input["leaseId"]
    {
        if state["observations"][&id]["lastCommit"]["pageFingerprint"] != hash(&input["page"]) {
            return Err("observation_commit_conflict");
        }
        return Ok(state["observations"][&id]["lastCommit"].clone());
    }
    let row = leased(state, input, now)?;
    let page = &input["page"];
    let events = page["events"]
        .as_array()
        .filter(|events| events.len() <= 1000)
        .ok_or("invalid_observation_page")?;
    if !page["nextCheckpoint"].is_object() {
        return Err("invalid_observation_page");
    }
    let mut retained = row["events"].as_array().unwrap().clone();
    let mut seen: std::collections::HashSet<_> = retained
        .iter()
        .filter_map(|entry| entry["key"].as_str().map(str::to_owned))
        .collect();
    let mut sequence = row["sequence"].as_u64().unwrap_or_default();
    let mut incoming = Vec::new();
    for event in events {
        text(event, "id")?;
        text(event, "eventType")?;
        if event_time(&event["at"]).is_none() {
            return Err("invalid_observation_event_time");
        }
        let key = hash(&event_identity(&row["source"], event));
        if !seen.insert(key.clone()) {
            continue;
        }
        sequence += 1;
        let entry = json!({"key":key,"sequence":sequence,"event":event});
        incoming.push(entry.clone());
        retained.push(entry);
    }
    if retained.len() > 1000 {
        retained.drain(..retained.len() - 1000);
    }
    row["events"] = json!(retained);
    row["sequence"] = json!(sequence);
    row["checkpoint"] = page["nextCheckpoint"].clone();
    if page["resourceStates"].is_array() {
        row["resourceStates"] = page["resourceStates"].clone();
    }
    row["lastCollectedAt"] = json!(now);
    finish_collection(row, page, now)?;
    row["lastCommit"] = json!({"leaseId":input["leaseId"],"accepted":true,"sequence":sequence,"pageFingerprint":hash(page)});
    let receipt = row["lastCommit"].clone();
    let mut deliveries = Vec::new();
    for subscription in state["subscriptions"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .filter(|row| row["observationId"] == id && row["status"] == "armed")
    {
        let matching: Vec<_> = incoming
            .iter()
            .filter(|entry| {
                entry["sequence"].as_u64().unwrap()
                    > subscription["afterSequence"].as_u64().unwrap_or_default()
                    && matches_activation(&subscription["activation"], &entry["event"], event_time)
                    && matches_event(&subscription["intent"]["match"], &entry["event"])
            })
            .collect();
        subscription["afterSequence"] = json!(sequence);
        if matching.is_empty() {
            continue;
        }
        deliveries.push(pending_delivery(subscription, &matching));
    }
    for (id, delivery) in deliveries {
        state["deliveries"][id] = delivery;
    }
    Ok(receipt)
}

fn pending_delivery(subscription: &mut Value, matching: &[&Value]) -> (String, Value) {
    let delivery_id = hash(&json!([
        subscription["id"],
        matching
            .iter()
            .map(|entry| &entry["key"])
            .collect::<Vec<_>>()
    ]));
    subscription["status"] = json!("pending");
    subscription["deliveryId"] = json!(delivery_id);
    (
        delivery_id.clone(),
        json!({"id":delivery_id,"subscriptionId":subscription["id"],"intent":subscription["intent"],"source":subscription["activation"],"events":matching.iter().map(|entry|&entry["event"]).collect::<Vec<_>>(),"eventKeys":matching.iter().map(|entry|&entry["key"]).collect::<Vec<_>>(),"status":"pending"}),
    )
}

fn claim_delivery(state: &mut Value, now: i64) -> Result<Value> {
    let ready = state["subscriptions"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<std::collections::HashSet<_>>();
    let row = state["deliveries"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .filter(|row| {
            row["status"] == "pending"
                && row["subscriptionId"]
                    .as_str()
                    .is_some_and(|id| ready.contains(id))
                && row["lease"]["expiresAt"].as_i64().unwrap_or_default() <= now
        })
        .min_by(|left, right| {
            left["lease"]["expiresAt"]
                .as_i64()
                .unwrap_or_default()
                .cmp(&right["lease"]["expiresAt"].as_i64().unwrap_or_default())
                .then_with(|| left["id"].as_str().cmp(&right["id"].as_str()))
        });
    let Some(row) = row else {
        return Ok(json!({"delivery":null}));
    };
    row["lease"] = json!({"id":token()?,"expiresAt":now+LEASE_MS});
    Ok(json!({"delivery":row}))
}
fn ack_delivery(state: &mut Value, input: &Value, now: i64) -> Result<Value> {
    let id = text(input, "deliveryId")?;
    let delivery = state["deliveries"]
        .get_mut(id)
        .ok_or("observation_delivery_unavailable")?;
    if delivery["status"] == "accepted" && delivery["acceptedLeaseId"] == input["leaseId"] {
        if delivery["receipt"] != input["receipt"] {
            return Err("observation_delivery_conflict");
        }
        return Ok(json!({"accepted":true,"receipt":delivery["receipt"]}));
    }
    if delivery["status"] != "pending"
        || delivery["lease"]["id"] != input["leaseId"]
        || delivery["lease"]["expiresAt"].as_i64().unwrap_or_default() <= now
    {
        return Err("observation_delivery_lease_lost");
    }
    if input["receipt"]["accepted"] != true {
        return Err("observation_delivery_not_accepted");
    }
    if !delivery["admission"].is_object()
        || input["receipt"]["operationId"] != delivery["admission"]["operationId"]
    {
        return Err("observation_delivery_admission_conflict");
    }
    delivery["status"] = json!("accepted");
    delivery["receipt"] = input["receipt"].clone();
    delivery["acceptedLeaseId"] = input["leaseId"].clone();
    delivery["lease"] = Value::Null;
    let subscription = delivery["subscriptionId"].as_str().unwrap().to_owned();
    state["subscriptions"][&subscription]["status"] = json!("delivered");
    revoke_idle_leases(state, now);
    Ok(json!({"accepted":true,"receipt":input["receipt"]}))
}
