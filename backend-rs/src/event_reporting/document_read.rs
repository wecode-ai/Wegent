// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use chrono::{SecondsFormat, Utc};
use serde::Serialize;

use super::config::ReporterConfig;

const EVENT_TYPE: &str = "knowledge.document.read.finished";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentReadEvent {
    pub kb_id: Option<i64>,
    pub document_id: i64,
    pub outcome: DocumentReadOutcome,
    pub offset: Option<i64>,
    pub returned_length: Option<i64>,
    pub total_length: Option<i64>,
    pub has_more: Option<bool>,
    pub actor_user_id: i64,
    pub effective_reader_id: i64,
    pub entrypoint: &'static str,
    pub task_id: Option<i64>,
    pub subtask_id: Option<i64>,
    pub invocation_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DocumentReadOutcome {
    Success,
    Failure(&'static str),
}

#[derive(Debug)]
pub(crate) enum EncodeError {
    RandomId,
    Serialization,
    EventTooLarge,
}

#[derive(Serialize)]
struct Envelope<'a> {
    schema_version: u8,
    event_id: String,
    fact_key: String,
    event_type: &'static str,
    occurred_at: String,
    service_name: &'a str,
    deployment_environment: &'a str,
    host_ip: Option<&'a str>,
    kb_id: Option<i64>,
    document_id: i64,
    status: &'static str,
    error_code: Option<&'static str>,
    duration_ms: Option<u64>,
    data: ReadData<'a>,
    service_version: Option<&'a str>,
    service_instance: &'a str,
}

#[derive(Serialize)]
struct ReadData<'a> {
    stage: &'static str,
    entrypoint: &'a str,
    user_id: i64,
    actor_user_id: i64,
    actor_type: &'static str,
    effective_reader_id: i64,
    task_id: Option<i64>,
    subtask_id: Option<i64>,
    invocation_id: Option<&'a str>,
    usage_stage: &'static str,
    metric_definition_version: &'static str,
    offset: Option<i64>,
    returned_length: Option<i64>,
    total_length: Option<i64>,
    has_more: Option<bool>,
}

pub(crate) fn encode(
    event: &DocumentReadEvent,
    config: &ReporterConfig,
) -> Result<Vec<u8>, EncodeError> {
    let fact_key = format!("v1|{EVENT_TYPE}");
    let (status, error_code) = match event.outcome {
        DocumentReadOutcome::Success => ("success", None),
        DocumentReadOutcome::Failure(error_code) => ("failed", Some(error_code)),
    };
    let envelope = Envelope {
        schema_version: 1,
        event_id: uuid_v4()?,
        fact_key,
        event_type: EVENT_TYPE,
        occurred_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, false),
        service_name: &config.service_name,
        deployment_environment: &config.environment,
        host_ip: config.host_ip.as_deref(),
        kb_id: event.kb_id,
        document_id: event.document_id,
        status,
        error_code,
        duration_ms: None,
        data: ReadData {
            stage: "content_delivery",
            entrypoint: event.entrypoint,
            user_id: event.effective_reader_id,
            actor_user_id: event.actor_user_id,
            actor_type: "user",
            effective_reader_id: event.effective_reader_id,
            task_id: event.task_id,
            subtask_id: event.subtask_id,
            invocation_id: event.invocation_id.as_deref(),
            usage_stage: "content_delivery",
            metric_definition_version: "usage-v1",
            offset: event.offset,
            returned_length: event.returned_length,
            total_length: event.total_length,
            has_more: event.has_more,
        },
        service_version: config.service_version.as_deref(),
        service_instance: &config.service_instance,
    };
    let encoded = serde_json::to_vec(&envelope).map_err(|_| EncodeError::Serialization)?;
    if encoded.len() > config.event_max_bytes {
        return Err(EncodeError::EventTooLarge);
    }
    Ok(encoded)
}

fn uuid_v4() -> Result<String, EncodeError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| EncodeError::RandomId)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    ))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config() -> ReporterConfig {
        ReporterConfig::from_mapping(
            "backend",
            &HashMap::from([
                ("EVENT_REPORTING_ENABLED".into(), "true".into()),
                ("EVENT_REPORTING_BACKEND_RS_ENABLED".into(), "true".into()),
                ("EVENT_KAFKA_BOOTSTRAP_SERVERS".into(), "unused".into()),
                ("EVENT_KAFKA_ENVIRONMENT".into(), "test".into()),
                ("HOSTNAME".into(), "fixture".into()),
            ]),
        )
        .unwrap()
    }

    #[test]
    fn encodes_python_compatible_read_event() {
        let event = DocumentReadEvent {
            kb_id: Some(11),
            document_id: 12,
            outcome: DocumentReadOutcome::Success,
            offset: Some(3),
            returned_length: Some(5),
            total_length: Some(20),
            has_more: Some(true),
            actor_user_id: 41,
            effective_reader_id: 42,
            entrypoint: "knowledge_api",
            task_id: Some(1606),
            subtask_id: Some(9001),
            invocation_id: Some("read 1".into()),
        };
        let value: serde_json::Value =
            serde_json::from_slice(&encode(&event, &config()).unwrap()).unwrap();
        assert_eq!(value["event_type"], EVENT_TYPE);
        assert_eq!(value["fact_key"], "v1|knowledge.document.read.finished");
        assert_eq!(value["data"]["invocation_id"], "read 1");
        assert_eq!(value["data"]["user_id"], 42);
        assert_eq!(value["data"]["actor_user_id"], 41);
        assert_eq!(value["data"]["effective_reader_id"], 42);
        assert_eq!(value["data"]["task_id"], 1606);
        assert_eq!(value["data"]["usage_stage"], "content_delivery");
    }

    #[test]
    fn encodes_failed_read_without_fabricating_result_measurements() {
        let event = DocumentReadEvent {
            kb_id: None,
            document_id: 12,
            outcome: DocumentReadOutcome::Failure("DOCUMENT_NOT_FOUND"),
            offset: None,
            returned_length: None,
            total_length: None,
            has_more: None,
            actor_user_id: 41,
            effective_reader_id: 42,
            entrypoint: "mcp",
            task_id: Some(1606),
            subtask_id: Some(9001),
            invocation_id: Some("read-failed-1".into()),
        };

        let value: serde_json::Value =
            serde_json::from_slice(&encode(&event, &config()).unwrap()).unwrap();
        assert_eq!(value["status"], "failed");
        assert_eq!(value["error_code"], "DOCUMENT_NOT_FOUND");
        assert_eq!(value["kb_id"], serde_json::Value::Null);
        assert_eq!(value["document_id"], 12);
        assert_eq!(value["data"]["offset"], serde_json::Value::Null);
        assert_eq!(value["data"]["returned_length"], serde_json::Value::Null);
        assert_eq!(value["data"]["total_length"], serde_json::Value::Null);
        assert_eq!(value["data"]["has_more"], serde_json::Value::Null);
        assert_eq!(value["data"]["task_id"], 1606);
        assert_eq!(value["data"]["subtask_id"], 9001);
    }
}
