//! Source identity and exact event matching are shared by durable collectors.
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 1;

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(fields) => {
            let sorted: BTreeMap<_, _> = fields
                .iter()
                .map(|(key, value)| (key, canonical_json(value)))
                .collect();
            format!(
                "{{{}}}",
                sorted
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{value}",
                        serde_json::to_string(key).expect("JSON object keys serialize")
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}

pub fn observation_identity(source: &Value) -> Value {
    let mut identity = source.clone();
    if let Some(fields) = identity.as_object_mut() {
        for field in ["enabledAfter", "boundary", "policy"] {
            fields.remove(field);
        }
    }
    identity
}

/// Initialization may add an event boundary, but cannot replace the selected source.
pub fn initialized_source(source: &Value, initialized: &Value) -> Result<Value, &'static str> {
    let mut expected = source.clone();
    let fields = expected
        .as_object_mut()
        .ok_or("invalid_observation_activation")?;
    if let Some(boundary) = initialized["source"].get("boundary") {
        if !boundary.is_null()
            && (boundary["partition"].as_str().map_or(true, str::is_empty)
                || boundary["sequence"].as_u64().is_none())
        {
            return Err("invalid_observation_activation");
        }
        fields.insert("boundary".into(), boundary.clone());
    }
    if !initialized["checkpoint"].is_object() || initialized["source"] != expected {
        return Err("invalid_observation_activation");
    }
    Ok(expected)
}

/// Keep the exact tool request while checking it describes the durable consumer.
pub fn matches_subscription_request(request: &Value, intent: &Value, wait: &Value) -> bool {
    request.as_object().is_some_and(|fields| fields.len() == 4)
        && request["source"].is_object()
        && observation_identity(&request["source"]) == intent["source"]
        && request["match"] == intent["match"]
        && request["continuation"]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty() && value.len() <= 16_384)
        && request["continuation"] == intent["continuation"]
        && request["wait_for_event"].is_boolean()
        && request["wait_for_event"] == *wait
}

pub fn event_identity(source: &Value, event: &Value) -> Value {
    let object = if event["objectId"].is_string() && event["version"].is_string() {
        json!(["object", event["objectId"], event["version"]])
    } else {
        json!([
            "event",
            source["kind"],
            source["id"],
            event["eventType"],
            event["id"]
        ])
    };
    json!([source["providerId"], source["profile"], object])
}

pub fn matches_event(filter: &Value, event: &Value) -> bool {
    if filter.is_null() {
        return true;
    }
    let Some(fields) = filter.as_object().filter(|fields| fields.len() <= 32) else {
        return false;
    };
    // Full pointer/size validation happens on activation and recovery, not per event.
    let mut condition_count = fields.len() - usize::from(fields.contains_key("$any"));
    if let Some(alternatives) = fields.get("$any") {
        let Some(branches) = alternatives
            .as_array()
            .filter(|rows| !rows.is_empty() && rows.len() <= 32)
        else {
            return false;
        };
        for branch in branches {
            let Some(branch) = branch.as_object().filter(|row| !row.is_empty()) else {
                return false;
            };
            condition_count += branch.len();
            if condition_count > 32 || branch.keys().any(|key| !key.starts_with('/')) {
                return false;
            }
        }
    }
    fields.iter().all(|(pointer, value)| {
        if pointer == "$any" {
            value.as_array().unwrap().iter().any(|branch| {
                branch
                    .as_object()
                    .unwrap()
                    .iter()
                    .all(|(key, expected)| event.pointer(key) == Some(expected))
            })
        } else {
            pointer.starts_with('/') && event.pointer(pointer) == Some(value)
        }
    })
}

/// Consumer activation is independent of a shared collector's opaque cursor.
/// Hosts supply their existing timestamp parser; ordered positions take precedence.
pub fn matches_activation(
    source: &Value,
    event: &Value,
    parse_time: impl Fn(&Value) -> Option<i64>,
) -> bool {
    if let Some(boundary) = source.get("boundary").filter(|value| !value.is_null()) {
        let position = &event["position"];
        return boundary["partition"]
            .as_str()
            .is_some_and(|partition| !partition.is_empty())
            && boundary["partition"] == position["partition"]
            && boundary["sequence"]
                .as_u64()
                .zip(position["sequence"].as_u64())
                .is_some_and(|(start, received)| received > start);
    }
    parse_time(&source["enabledAfter"])
        .zip(parse_time(&event["at"]))
        .is_some_and(|(enabled, received)| received >= enabled)
}

/// Retain events collected during activation, even when a shared cursor advanced.
/// Earlier source events remain excluded by the original activation contract.
pub fn activation_sequence(
    source: &Value,
    observation: &Value,
    parse_time: impl Fn(&Value) -> Option<i64>,
) -> u64 {
    observation["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| matches_activation(source, &entry["event"], &parse_time))
        .filter_map(|entry| entry["sequence"].as_u64())
        .min()
        .map(|sequence| sequence.saturating_sub(1))
        .unwrap_or_else(|| observation["sequence"].as_u64().unwrap_or_default())
}

pub fn validate_filter(filter: &Value) -> Result<(), &'static str> {
    if filter.is_null() {
        return Ok(());
    }
    let fields = filter.as_object().ok_or("match must be an object")?;
    let mut conditions = Vec::new();
    for (pointer, value) in fields {
        if pointer == "$any" {
            let branches = value
                .as_array()
                .ok_or("$any must be an array of condition objects")?;
            if branches.is_empty() || branches.len() > 32 {
                return Err("$any requires between 1 and 32 alternatives");
            }
            for branch in branches {
                let branch = branch
                    .as_object()
                    .filter(|fields| !fields.is_empty())
                    .ok_or("$any alternatives must be nonempty condition objects")?;
                conditions.extend(branch.keys());
            }
        } else {
            conditions.push(pointer);
        }
    }
    if conditions.len() > 32 {
        return Err("At most 32 event conditions are supported");
    }
    for pointer in conditions {
        if !pointer.starts_with('/') || pointer.len() > 512 {
            return Err("match keys must be RFC6901 JSON pointers");
        }
        let mut chars = pointer.chars();
        while let Some(ch) = chars.next() {
            if ch == '~' && !matches!(chars.next(), Some('0' | '1')) {
                return Err("Invalid JSON pointer escape");
            }
        }
    }
    if canonical_json(filter).len() > 16_384 {
        return Err("Event filter is too large");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_replays_retained_events_without_replaying_older_source_history() {
        let observation = json!({"sequence":3,"events":[{"sequence":1,"event":{"at":90}},{"sequence":2,"event":{"at":100}},{"sequence":3,"event":{"at":101}}]});
        assert_eq!(
            activation_sequence(&json!({"enabledAfter":100}), &observation, Value::as_i64),
            1
        );
        assert_eq!(
            activation_sequence(&json!({"enabledAfter":102}), &observation, Value::as_i64),
            3
        );
        let positioned = json!({"sequence":4,"events":[{"sequence":3,"event":{"position":{"partition":"other","sequence":8}}},{"sequence":4,"event":{"position":{"partition":"chosen","sequence":8}}}]});
        assert_eq!(
            activation_sequence(
                &json!({"boundary":{"partition":"chosen","sequence":7}}),
                &positioned,
                Value::as_i64
            ),
            3
        );
    }

    #[test]
    fn alternatives_keep_common_scope_and_exact_json_types() {
        let filter = json!({"/topicId":"pr-4749", "/sha":"head", "$any":[{"/state":"SUCCESS"},{"/state":"FAILURE"}]});
        assert!(validate_filter(&filter).is_ok());
        for state in ["SUCCESS", "FAILURE"] {
            assert!(matches_event(
                &filter,
                &json!({"topicId":"pr-4749","sha":"head","state":state})
            ));
        }
        for event in [
            json!({"topicId":"other","sha":"head","state":"FAILURE"}),
            json!({"topicId":"pr-4749","sha":"old","state":"SUCCESS"}),
            json!({"topicId":"pr-4749","sha":"head","state":"PENDING"}),
        ] {
            assert!(!matches_event(&filter, &event));
        }
        assert!(!matches_event(
            &json!({"$any":[{"/missing":null},{"/id":7}]}),
            &json!({"id":"7"})
        ));
        assert!(matches_event(
            &json!({"/value":{"items":[1,2]}}),
            &json!({"value":{"items":[1,2]}})
        ));
    }

    #[test]
    fn invalid_alternatives_fail_closed_and_share_the_condition_budget() {
        for filter in [
            json!({"$any":[]}),
            json!({"$any":[{}]}),
            json!({"$any":"SUCCESS"}),
            json!({"$any":[null]}),
            json!({"$any":[{"$any":[{"/state":"SUCCESS"}]}]}),
            json!({"$any":[{"/bad~2":true}]}),
            json!(7),
        ] {
            assert!(validate_filter(&filter).is_err());
            assert!(!matches_event(&filter, &json!({})));
        }
        let branches: Vec<_> = (0..33).map(|i| json!({format!("/field{i}"):i})).collect();
        assert!(validate_filter(&json!({"$any":branches})).is_err());
        assert!(validate_filter(&json!({"/scope":1,"$any":branches[..32]})).is_err());
    }

    #[test]
    fn initialization_receipts_bind_the_selected_source_and_bounded_event_boundary() {
        let source = json!({"providerId":"documents","profile":"account","id":"release"});
        let mut receipt = json!({"source":source,"checkpoint":{"cursor":7}});
        assert_eq!(initialized_source(&source, &receipt).unwrap(), source);
        receipt["source"]["boundary"] = json!({"partition":"events","sequence":7});
        assert_eq!(
            initialized_source(&source, &receipt).unwrap(),
            receipt["source"]
        );
        for (pointer, value) in [
            ("/source/id", json!("other")),
            ("/source/profile", json!("other")),
            ("/source/boundary/partition", json!("")),
            ("/source/boundary/sequence", json!("7")),
            ("/checkpoint", Value::Null),
        ] {
            let mut changed = receipt.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(initialized_source(&source, &changed).is_err(), "{pointer}");
        }
    }
    #[test]
    fn immutable_ids_are_resource_scoped_but_object_versions_cross_overlapping_sources() {
        let source = json!({"providerId":"mail","profile":"account","kind":"folder","id":"inbox"});
        let mut other = source.clone();
        other["id"] = json!("archive");
        let message = json!({"id":"123:7","eventType":"mail.received"});
        assert_ne!(
            event_identity(&source, &message),
            event_identity(&other, &message)
        );
        let object = json!({"id":"delivery-a","objectId":"global-object-id","version":"v2","eventType":"updated"});
        assert_eq!(
            event_identity(&source, &object),
            event_identity(&other, &object)
        );
        other["profile"] = json!("another-account");
        assert_ne!(
            event_identity(&source, &object),
            event_identity(&other, &object)
        );
    }
    #[test]
    fn resource_configuration_identity_is_independent_of_json_field_order() {
        let a: Value =
            serde_json::from_str(r#"{"id":"1","selection":{"b":2,"a":1},"enabledAfter":"old"}"#)
                .unwrap();
        let b: Value = serde_json::from_str(
            r#"{"selection":{"a":1,"b":2},"id":"1","enabledAfter":"new","policy":{}}"#,
        )
        .unwrap();
        assert_eq!(
            canonical_json(&observation_identity(&a)),
            canonical_json(&observation_identity(&b))
        );
    }

    #[test]
    fn original_tool_request_matches_only_its_consumer_and_wait_mode() {
        let request = json!({"source":{"id":"resource","policy":{"automatic":true}},"match":{"/type":"updated"},"continuation":"Continue","wait_for_event":true});
        let intent = json!({"source":{"id":"resource"},"match":{"/type":"updated"},"continuation":"Continue"});
        assert!(matches_subscription_request(
            &request,
            &intent,
            &json!(true)
        ));
        assert!(!matches_subscription_request(
            &request,
            &intent,
            &json!(false)
        ));
        for (pointer, value) in [
            ("/source/id", json!("foreign")),
            ("/match", json!({})),
            ("/continuation", json!("Other work")),
            ("/wait_for_event", Value::Null),
        ] {
            let mut changed = request.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(!matches_subscription_request(
                &changed,
                &intent,
                &json!(true)
            ));
        }
        let mut extra = request.clone();
        extra["executionRequest"] = json!({"prompt":"Unrelated work"});
        assert!(!matches_subscription_request(&extra, &intent, &json!(true)));
        let mut corrupt_request = request;
        let mut corrupt_intent = intent;
        corrupt_request["continuation"] = json!(7);
        corrupt_intent["continuation"] = json!(7);
        assert!(!matches_subscription_request(
            &corrupt_request,
            &corrupt_intent,
            &json!(true)
        ));
    }

    #[test]
    fn consumer_activation_uses_its_own_position_or_event_time() {
        let mut source = json!({"enabledAfter":100,"boundary":{"partition":"inbox","sequence":9}});
        let mut event = json!({"at":0,"position":{"partition":"inbox","sequence":10}});
        assert!(matches_activation(&source, &event, Value::as_i64));
        source["boundary"]["sequence"] = json!(10);
        assert!(!matches_activation(&source, &event, Value::as_i64));
        source["boundary"]["sequence"] = json!(9);
        event["position"]["partition"] = json!("another-inbox");
        assert!(!matches_activation(&source, &event, Value::as_i64));
        source.as_object_mut().unwrap().remove("boundary");
        assert!(!matches_activation(&source, &event, Value::as_i64));
        event["at"] = json!(100);
        assert!(matches_activation(&source, &event, Value::as_i64));
        event.as_object_mut().unwrap().remove("at");
        assert!(!matches_activation(&source, &event, Value::as_i64));
    }
}
