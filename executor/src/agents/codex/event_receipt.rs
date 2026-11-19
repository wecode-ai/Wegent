//! Read native execution evidence without relying on the UI history projection.
use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use serde_json::Value;

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct EventReceipt {
    pub injected: bool,
    pub activated: bool,
    pub turn_id: Option<String>,
    pub completed: bool,
}

pub(crate) fn read(
    home: &Path,
    path: &Path,
    thread_id: &str,
    item: &Value,
) -> Result<EventReceipt, String> {
    let home = home
        .canonicalize()
        .map_err(|_| "Native event home is unavailable")?;
    let path = path
        .canonicalize()
        .map_err(|_| "Native event history is unavailable")?;
    if !["sessions", "archived_sessions"]
        .iter()
        .any(|directory| path.starts_with(home.join(directory)))
    {
        return Err("Native event history does not belong to the session home".into());
    }
    let file = File::open(path).map_err(|_| "Native event history is unavailable")?;
    read_rows(BufReader::new(file), thread_id, item)
}

fn read_rows(
    mut reader: impl BufRead,
    thread_id: &str,
    item: &Value,
) -> Result<EventReceipt, String> {
    let id = item["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Native event item identity is missing")?;
    // Older executors persisted the same digest without the Responses prefix.
    let legacy_id = id
        .strip_prefix("msg_")
        .filter(|id| id.starts_with("wework_event_"));
    let mut receipt = EventReceipt::default();
    let mut scoped = false;
    let mut line = String::new();
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .map_err(|_| "Cannot read native event evidence")?
            == 0
        {
            break;
        }
        // A partial append cannot prove absence or permit another injection.
        if !line.ends_with('\n') {
            return Err("Native event history has an incomplete record".into());
        }
        let row: Value = serde_json::from_str(&line)
            .map_err(|_| "Native event history contains an invalid record")?;
        if !scoped {
            if row["type"] != "session_meta" || row["payload"]["id"] != thread_id {
                return Err("Native event history belongs to another thread".into());
            }
            scoped = true;
            continue;
        }
        let payload = &row["payload"];
        let recorded_id = payload["id"].as_str();
        if row["type"] == "response_item"
            && (recorded_id == Some(id) || legacy_id.is_some_and(|id| recorded_id == Some(id)))
        {
            if receipt.injected
                || ["type", "role", "content"]
                    .iter()
                    .any(|key| payload[*key] != item[*key])
            {
                return Err("Native event identity has conflicting history".into());
            }
            receipt.injected = true;
        }
        if !receipt.injected || row["type"] != "event_msg" {
            continue;
        }
        match payload["type"].as_str() {
            Some("thread_goal_updated")
                if payload["threadId"] == thread_id && payload["goal"]["status"] == "active" =>
            {
                receipt.activated = true
            }
            Some("task_started") if receipt.activated && receipt.turn_id.is_none() => {
                receipt.turn_id = Some(
                    payload["turn_id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or("Native event turn identity is missing")?
                        .to_owned(),
                );
            }
            Some("task_complete")
                if payload["turn_id"].as_str() == receipt.turn_id.as_deref()
                    && receipt.turn_id.is_some() =>
            {
                receipt.completed = true
            }
            _ => {}
        }
    }
    if !scoped {
        return Err("Native event history is empty".into());
    }
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item() -> Value {
        json!({"type":"message","id":"event-operation","role":"user","content":[{"type":"input_text","text":"Untrusted source facts"}]})
    }
    fn rows(tail: &[Value]) -> String {
        std::iter::once(json!({"type":"session_meta","payload":{"id":"thread-original"}}))
            .chain(tail.iter().cloned())
            .map(|row| format!("{row}\n"))
            .collect()
    }

    #[test]
    fn native_event_receipt_distinguishes_injection_activation_and_original_turn() {
        let injected = json!({"type":"response_item","payload":item()});
        let started =
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"first-turn"}});
        let activated = json!({"type":"event_msg","payload":{"type":"thread_goal_updated","threadId":"thread-original","goal":{"status":"active"}}});
        let complete =
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"first-turn"}});
        let later = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"later-goal-turn"}});
        for (tail, expected) in [
            (vec![], EventReceipt::default()),
            (
                vec![injected.clone()],
                EventReceipt {
                    injected: true,
                    ..Default::default()
                },
            ),
            (
                vec![injected, activated, started, complete, later],
                EventReceipt {
                    injected: true,
                    activated: true,
                    turn_id: Some("first-turn".into()),
                    completed: true,
                },
            ),
        ] {
            assert_eq!(
                read_rows(rows(&tail).as_bytes(), "thread-original", &item()).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn native_event_receipt_recognizes_legacy_injection_without_permitting_a_duplicate() {
        let mut current = item();
        current["id"] = json!("msg_wework_event_4af404a14e6a5e37428a4d00a0ab1a45");
        let mut legacy = current.clone();
        legacy["id"] = json!("wework_event_4af404a14e6a5e37428a4d00a0ab1a45");
        let legacy = json!({"type":"response_item","payload":legacy});
        let receipt = read_rows(
            rows(std::slice::from_ref(&legacy)).as_bytes(),
            "thread-original",
            &current,
        )
        .unwrap();
        assert!(receipt.injected);
        let matching = json!({"type":"response_item","payload":current});
        assert!(read_rows(
            rows(&[legacy, matching]).as_bytes(),
            "thread-original",
            &current
        )
        .is_err());
    }

    #[test]
    fn native_event_receipt_rejects_wrong_scope_duplicate_tampered_and_partial_records() {
        let injected = json!({"type":"response_item","payload":item()});
        assert!(read_rows(rows(&[]).as_bytes(), "another-thread", &item()).is_err());
        assert!(read_rows(
            rows(&[injected.clone(), injected.clone()]).as_bytes(),
            "thread-original",
            &item()
        )
        .is_err());
        let mut tampered = injected.clone();
        tampered["payload"]["content"][0]["text"] = json!("Different work");
        assert!(read_rows(rows(&[tampered]).as_bytes(), "thread-original", &item()).is_err());
        let partial = format!("{}{{\"type\":", rows(&[injected]));
        assert!(read_rows(partial.as_bytes(), "thread-original", &item()).is_err());
    }

    #[test]
    fn native_event_receipt_rejects_paths_outside_the_native_home() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(read(home.path(), outside.path(), "thread-original", &item()).is_err());
        let directory = home.path().join("sessions");
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("original.jsonl");
        std::fs::write(&path, rows(&[])).unwrap();
        assert_eq!(
            read(home.path(), &path, "thread-original", &item()).unwrap(),
            EventReceipt::default()
        );
    }
}
