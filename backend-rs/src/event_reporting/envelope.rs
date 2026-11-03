// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use chrono::{SecondsFormat, Utc};
use serde::Serialize;

use super::config::ReporterConfig;
use super::contract::EventKind;
use super::fact::{EntityId, FactDraft, Scalar, WireInteger};
use super::generated_contract;

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
    kb_id: Option<EntityValue<'a>>,
    document_id: Option<EntityValue<'a>>,
    status: &'static str,
    error_code: Option<&'a str>,
    duration_ms: Option<IntegerValue>,
    data: serde_json::Map<String, serde_json::Value>,
    service_version: Option<&'a str>,
    service_instance: &'a str,
}

#[derive(Serialize)]
#[serde(untagged)]
enum EntityValue<'a> {
    Signed(i64),
    Unsigned(u64),
    Text(&'a str),
}

#[derive(Clone, Copy, Serialize)]
#[serde(untagged)]
enum IntegerValue {
    Signed(i64),
    Unsigned(u64),
}

pub(crate) fn encode(
    kind: EventKind,
    fact: &FactDraft,
    config: &ReporterConfig,
) -> Result<Vec<u8>, EncodeError> {
    debug_assert!(generated_contract::EVENT_TYPES.contains(&kind.as_str()));
    debug_assert!(generated_contract::STATUSES.contains(&fact.status.as_str()));
    let mut data = serde_json::Map::new();
    for (field, value) in &fact.data {
        debug_assert!(generated_contract::FIELDS.contains(&field.as_str()));
        data.insert(field.as_str().to_owned(), scalar_json(value));
    }
    let envelope = Envelope {
        schema_version: 1,
        event_id: uuid_v4()?,
        fact_key: build_fact_key(kind.as_str(), &fact.fact_key_parts),
        event_type: kind.as_str(),
        occurred_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, false),
        service_name: &config.service_name,
        deployment_environment: &config.environment,
        host_ip: config.host_ip.as_deref(),
        kb_id: fact.kb_id.as_ref().map(entity_value),
        document_id: fact.document_id.as_ref().map(entity_value),
        status: fact.status.as_str(),
        error_code: fact.error_code.as_ref().map(|value| value.as_str()),
        duration_ms: fact.duration_ms.map(integer_value),
        data,
        service_version: config.service_version.as_deref(),
        service_instance: &config.service_instance,
    };
    let encoded = serde_json::to_vec(&envelope).map_err(|_| EncodeError::Serialization)?;
    if encoded.len() > config.event_max_bytes {
        return Err(EncodeError::EventTooLarge);
    }
    Ok(encoded)
}

fn entity_value(value: &EntityId) -> EntityValue<'_> {
    match value {
        EntityId::Integer(value) => match value {
            WireInteger::Signed(value) => EntityValue::Signed(*value),
            WireInteger::Unsigned(value) => EntityValue::Unsigned(*value),
        },
        EntityId::Text(value) => EntityValue::Text(value.as_str()),
    }
}

fn integer_value(value: WireInteger) -> IntegerValue {
    match value {
        WireInteger::Signed(value) => IntegerValue::Signed(value),
        WireInteger::Unsigned(value) => IntegerValue::Unsigned(value),
    }
}

fn scalar_json(value: &Scalar) -> serde_json::Value {
    match value {
        Scalar::Null => serde_json::Value::Null,
        Scalar::Bool(value) => serde_json::Value::Bool(*value),
        Scalar::Integer(value) => match value {
            WireInteger::Signed(value) => (*value).into(),
            WireInteger::Unsigned(value) => (*value).into(),
        },
        Scalar::FiniteF64(value) => serde_json::json!(value),
        Scalar::Text(value) => value.as_str().into(),
        Scalar::IdList(values) => values.iter().map(scalar_json).collect(),
    }
}

fn build_fact_key(namespace: &str, parts: &[Scalar]) -> String {
    let encoded = parts
        .iter()
        .filter_map(fact_key_value)
        .map(|part| percent_encode(&part))
        .collect::<Vec<_>>();
    if encoded.is_empty() {
        format!("v1|{namespace}")
    } else {
        format!("v1|{namespace}|{}", encoded.join("|"))
    }
}

fn fact_key_value(value: &Scalar) -> Option<String> {
    match value {
        Scalar::Null => None,
        Scalar::Bool(true) => Some("True".to_owned()),
        Scalar::Bool(false) => Some("False".to_owned()),
        Scalar::Integer(WireInteger::Signed(value)) => Some(value.to_string()),
        Scalar::Integer(WireInteger::Unsigned(value)) => Some(value.to_string()),
        Scalar::FiniteF64(value) => serde_json::to_string(value).ok(),
        Scalar::Text(value) => Some(value.as_str().to_owned()),
        Scalar::IdList(_) => None,
    }
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
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
    use crate::event_reporting::config::ReporterConfig;
    use crate::event_reporting::{EventStatus, FactDraft, Field, Scalar};

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
    fn encodes_python_compatible_read_fact() {
        let fact = FactDraft::new(EventStatus::Success)
            .with_kb_id(11_i64)
            .with_document_id(12_i64)
            .with_field(Field::Stage, Scalar::text("content_delivery").unwrap())
            .unwrap()
            .with_field(Field::Entrypoint, Scalar::text("openapi").unwrap())
            .unwrap()
            .with_field(Field::UserId, Scalar::Null)
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(
            &encode(EventKind::KnowledgeDocumentReadFinished, &fact, &config()).unwrap(),
        )
        .unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["service_name"], "backend");
        assert_eq!(value["fact_key"], "v1|knowledge.document.read.finished");
        assert_eq!(value["data"]["user_id"], serde_json::Value::Null);
        assert!(value["event_id"].as_str().unwrap().contains('-'));
    }

    #[test]
    fn fact_key_uses_python_quote_encoding() {
        assert_eq!(
            build_fact_key(
                "knowledge.document.created",
                &[Scalar::text("a b/中文").unwrap()]
            ),
            "v1|knowledge.document.created|a%20b%2F%E4%B8%AD%E6%96%87"
        );
    }
}
