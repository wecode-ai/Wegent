// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_REPLY_BYTES: usize = 60_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReplyEvent {
    pub invocation_id: String,
    pub delivery_id: String,
    pub seq: u64,
    #[serde(rename = "type")]
    pub kind: ReplyKind,
    pub text: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ReplyKind {
    Accepted,
    Progress,
    Append,
    Succeeded,
    Failed,
}

pub(super) struct Projection {
    pub text: String,
    pub status: &'static str,
    pub metadata: Value,
}

pub(super) fn apply(
    event: &ReplyEvent,
    content: &str,
    status: &str,
    mut metadata: Value,
) -> Result<Option<Projection>, &'static str> {
    let last = metadata["externalReplySequence"].as_u64().unwrap_or(0);
    if event.seq == 0 {
        return Err("Sequence numbers start at one");
    }
    if event.seq <= last {
        return Ok(None);
    }
    if event.seq != last + 1 {
        return Err("Reply sequence has a gap");
    }
    if matches!(status, "completed" | "failed") {
        return Err("The invocation has finished");
    }
    let mut text = content.to_owned();
    let status = match (event.kind, event.text.as_deref()) {
        (ReplyKind::Accepted, None) if last == 0 => "streaming",
        (ReplyKind::Progress, Some(progress)) if progress.len() <= 2048 => {
            metadata["externalProgress"] = json!(progress);
            "streaming"
        }
        (ReplyKind::Append, Some(delta)) if delta.len() <= 16_384 => {
            text.push_str(delta);
            "streaming"
        }
        (ReplyKind::Succeeded, final_text) => {
            if let Some(final_text) = final_text {
                text = final_text.to_owned();
            }
            "completed"
        }
        (ReplyKind::Failed, reason) => {
            if let Some(reason) = reason.filter(|reason| reason.len() <= 2048) {
                metadata["externalProgress"] = json!(reason);
            }
            "failed"
        }
        _ => return Err("Invalid reply event"),
    };
    if text.len() > MAX_REPLY_BYTES {
        return Err("Reply exceeds the maximum size");
    }
    advance_revision(&mut metadata);
    metadata["externalReplySequence"] = json!(event.seq);
    metadata["run_status"] = json!(status);
    Ok(Some(Projection {
        text,
        status,
        metadata,
    }))
}

pub(super) fn advance_revision(metadata: &mut Value) {
    let revision = metadata["externalReplyRevision"]
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    metadata["externalReplyRevision"] = json!(revision.saturating_add(1).to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_replays_acknowledged_chunks_without_appending_twice() {
        let mut event = ReplyEvent {
            invocation_id: "invocation".into(),
            delivery_id: "delivery".into(),
            seq: 1,
            kind: ReplyKind::Append,
            text: Some("你好".into()),
        };
        let first = apply(&event, "", "pending", json!({})).unwrap().unwrap();
        assert_eq!(first.text, "你好");
        assert!(
            apply(&event, &first.text, first.status, first.metadata.clone())
                .unwrap()
                .is_none()
        );
        event.seq = 3;
        assert!(apply(&event, &first.text, first.status, first.metadata.clone()).is_err());
        event.seq = 2;
        event.kind = ReplyKind::Succeeded;
        event.text = None;
        let finished = apply(&event, &first.text, first.status, first.metadata)
            .unwrap()
            .unwrap();
        assert_eq!(finished.text, "你好");
        assert_eq!(finished.status, "completed");
    }
}
