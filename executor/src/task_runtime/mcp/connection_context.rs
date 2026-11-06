//! Provider-neutral projections keep original events available through bounded reads.
use serde_json::{json, Value};

const PAGE_SIZE: usize = 50;
const PAYLOAD_CHARS: usize = 12000;
const SUMMARY_CHARS: usize = 5000;

pub(super) fn work_messages(messages: &[Value], args: &Value) -> Result<Value, String> {
    if let Some(id) = args["messageId"].as_str() {
        let message = exact_message(messages, id)?;
        let mut chunk = payload_chunk(message, args)?;
        chunk["messageId"] = json!(id);
        return Ok(chunk);
    }
    let offset = offset(args, "offset")?;
    if offset > messages.len() {
        return Err("offset is outside this work".into());
    }
    let page = messages
        .iter()
        .skip(offset)
        .take(PAGE_SIZE)
        .cloned()
        .map(summarize)
        .collect::<Vec<_>>();
    Ok(
        json!({"messages":page,"hasMore":offset+PAGE_SIZE<messages.len(),
        "nextOffset":(offset+PAGE_SIZE<messages.len()).then_some(offset+PAGE_SIZE)}),
    )
}

pub(super) fn exact_message<'a>(messages: &'a [Value], id: &str) -> Result<&'a Value, String> {
    if let Some(message) = messages.iter().find(|message| message["recordId"] == id) {
        return Ok(message);
    }
    let mut matching = messages.iter().filter(|message| message["id"] == id);
    let message = matching.next().ok_or("Unknown source event")?;
    if matching.next().is_some() {
        return Err("Ambiguous source event ID; use the immutable recordId from read_work".into());
    }
    Ok(message)
}

/// Chunk the complete immutable record without interpreting provider-owned fields.
pub(super) fn payload_chunk(record: &Value, args: &Value) -> Result<Value, String> {
    let payload = record.to_string();
    let offset = offset(args, "payloadOffset")?;
    let total = payload.chars().count();
    if offset > total {
        return Err("payloadOffset is outside this event".into());
    }
    let text = payload
        .chars()
        .skip(offset)
        .take(PAYLOAD_CHARS)
        .collect::<String>();
    Ok(
        json!({"payload":text,"offset":offset,"totalCharacters":total,
        "nextOffset":(offset+PAYLOAD_CHARS<total).then_some(offset+PAYLOAD_CHARS)}),
    )
}

fn offset(args: &Value, key: &str) -> Result<usize, String> {
    args.get(key).map_or(Ok(0), |value| {
        value
            .as_u64()
            .and_then(|number| usize::try_from(number).ok())
            .ok_or_else(|| format!("{key} must be a nonnegative integer"))
    })
}

pub(crate) fn summarize(mut value: Value) -> Value {
    fn visit(value: &mut Value) {
        match value {
            Value::Array(rows) => rows.iter_mut().for_each(visit),
            Value::Object(row) => {
                if row.remove("payload").is_some() {
                    row.insert("payloadAvailable".into(), json!(true));
                }
                if let Some(text) = row.get("text").and_then(Value::as_str) {
                    if text.chars().count() > SUMMARY_CHARS {
                        let text = text.chars().take(SUMMARY_CHARS).collect::<String>();
                        row.insert("text".into(), json!(text));
                        row.insert("textTruncated".into(), json!(true));
                    }
                }
                row.values_mut().for_each(visit);
            }
            _ => {}
        }
    }
    visit(&mut value);
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versioned_events_require_an_exact_immutable_record() {
        let messages = vec![
            json!({"id":"stable", "recordId":"record-v1", "version":"v1", "text":"passed"}),
            json!({"id":"stable", "recordId":"record-v2", "version":"v2", "text":"failed"}),
            json!({"id":"unique", "recordId":"record-other", "version":"v1"}),
        ];
        for original in &messages {
            let page =
                work_messages(&messages, &json!({"messageId":original["recordId"]})).unwrap();
            let payload: Value = serde_json::from_str(page["payload"].as_str().unwrap()).unwrap();
            assert_eq!(&payload, original);
        }
        assert!(work_messages(&messages, &json!({"messageId":"stable"}))
            .unwrap_err()
            .contains("recordId"));
        let unique = work_messages(&messages, &json!({"messageId":"unique"})).unwrap();
        let payload: Value = serde_json::from_str(unique["payload"].as_str().unwrap()).unwrap();
        assert_eq!(payload, messages[2]);
        assert!(work_messages(&messages, &json!({"messageId":"foreign-record"})).is_err());
    }

    #[test]
    fn immutable_record_identity_precedes_another_events_upstream_id() {
        let exact = json!({"id":"stable", "recordId":"record-v2", "version":"v2"});
        let messages = [json!({"id":"record-v2", "recordId":"other"}), exact.clone()];
        let page = work_messages(&messages, &json!({"messageId":"record-v2"})).unwrap();
        let payload: Value = serde_json::from_str(page["payload"].as_str().unwrap()).unwrap();
        assert_eq!(payload, exact);
    }

    #[test]
    fn provider_neutral_projection_preserves_original_events() {
        let original = json!({"events":[{"message":{"text":"文".repeat(5001),
            "external":{"platform":"third-party","payload":{"untrusted":"original"}}}}]});
        let projected = summarize(original.clone());
        let message = &projected["events"][0]["message"];
        assert_eq!(message["external"]["payloadAvailable"], true);
        assert!(message["external"].get("payload").is_none());
        assert_eq!(
            message["text"].as_str().unwrap().chars().count(),
            SUMMARY_CHARS
        );
        assert_eq!(message["textTruncated"], true);
        assert_eq!(
            original["events"][0]["message"]["external"]["payload"]["untrusted"],
            "original"
        );
    }

    #[test]
    fn all_source_event_shapes_support_lossless_chunked_reads() {
        let original = json!({"id":"event","recordId":"record","custom":{"content":"文".repeat(16000)},
            "external":{"platform":"third-party","payload":{"arbitrary":true}}});
        let mut chunks = String::new();
        let mut offset = 0;
        loop {
            let page = work_messages(
                std::slice::from_ref(&original),
                &json!({"messageId":"record","payloadOffset":offset}),
            )
            .unwrap();
            chunks.push_str(page["payload"].as_str().unwrap());
            match page["nextOffset"].as_u64() {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(serde_json::from_str::<Value>(&chunks).unwrap(), original);
        assert!(work_messages(
            std::slice::from_ref(&original),
            &json!({"messageId":"foreign"})
        )
        .is_err());
        assert!(work_messages(
            &[original],
            &json!({"messageId":"event","payloadOffset":-1})
        )
        .is_err());
    }

    #[test]
    fn event_lists_are_paged_for_any_provider() {
        let events = (0..51)
            .map(|id| json!({"id":id,"payload":{"original":true}}))
            .collect::<Vec<_>>();
        let first = work_messages(&events, &json!({})).unwrap();
        assert_eq!(first["messages"].as_array().unwrap().len(), PAGE_SIZE);
        assert_eq!(first["nextOffset"], PAGE_SIZE);
        assert_eq!(first["messages"][0]["payloadAvailable"], true);
        let last = work_messages(&events, &json!({"offset":50})).unwrap();
        assert_eq!(last["messages"].as_array().unwrap().len(), 1);
        assert_eq!(last["hasMore"], false);
        assert!(work_messages(&events, &json!({"offset":52})).is_err());
    }
}
