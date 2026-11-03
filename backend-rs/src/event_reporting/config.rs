// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fmt;
use std::time::Duration;

#[cfg(test)]
use std::collections::HashMap;

const DEFAULT_QUEUE_MAX_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_EVENT_MAX_BYTES: usize = 8 * 1024;
pub(crate) const QUEUE_MAX_EVENTS: usize = 2_048;

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct Secret(String);

impl Secret {
    fn new(value: String) -> Self {
        Self(value)
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

#[derive(Clone)]
pub(crate) struct ReporterConfig {
    pub(crate) enabled: bool,
    pub(crate) adv_attribution_enabled: bool,
    pub(crate) adv_read_wiki_enabled: bool,
    pub(crate) adv_model_storage_enabled: bool,
    pub(crate) adv_quality_detail_enabled: bool,
    pub(crate) adv_result_detail_limit: usize,
    pub(crate) bootstrap_servers: String,
    pub(crate) topic: String,
    pub(crate) environment: String,
    pub(crate) client_id: String,
    pub(crate) acks: String,
    pub(crate) compression_type: String,
    pub(crate) linger_ms: u64,
    pub(crate) request_timeout: Duration,
    pub(crate) delivery_timeout: Duration,
    pub(crate) queue_max_bytes: usize,
    pub(crate) event_max_bytes: usize,
    pub(crate) shutdown_timeout: Duration,
    pub(crate) security_protocol: String,
    pub(crate) sasl_mechanism: String,
    pub(crate) sasl_username: Secret,
    pub(crate) sasl_password: Secret,
    pub(crate) ssl_cafile: String,
    pub(crate) service_name: String,
    pub(crate) host_ip: Option<String>,
    pub(crate) service_version: Option<String>,
    pub(crate) service_instance: String,
}

impl fmt::Debug for ReporterConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReporterConfig")
            .field("enabled", &self.enabled)
            .field("topic", &self.topic)
            .field("environment", &self.environment)
            .field("client_id", &self.client_id)
            .field("security_protocol", &self.security_protocol)
            .field("sasl_username", &self.sasl_username)
            .field("sasl_password", &self.sasl_password)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigErrorCode {
    InvalidEventConfiguration,
    MissingBootstrapServers,
    MissingEnvironment,
    MissingTopic,
    InvalidQueueMaxBytes,
    InvalidEventMaxBytes,
    EventLimitExceedsQueueLimit,
    InvalidMemoryLimit,
    InvalidLingerMs,
    InvalidRequestTimeoutMs,
    InvalidDeliveryTimeoutMs,
    InvalidShutdownTimeoutMs,
    InvalidAdvResultDetailLimit,
    InvalidAcks,
    InvalidCompression,
    InvalidSecurityProtocol,
    MissingSaslCredentials,
    InvalidSaslMechanism,
    KafkaInitialization,
}

impl ReporterConfig {
    pub(crate) fn from_env(service_name: &str) -> Result<Self, ConfigErrorCode> {
        Self::from_lookup(service_name, crate::config::env_or_dotenv)
    }

    #[cfg(test)]
    pub(crate) fn from_mapping(
        service_name: &str,
        values: &HashMap<String, String>,
    ) -> Result<Self, ConfigErrorCode> {
        Self::from_lookup(service_name, |name| values.get(name).cloned())
    }

    fn from_lookup(
        service_name: &str,
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, ConfigErrorCode> {
        let globally_enabled = parse_bool(lookup("EVENT_REPORTING_ENABLED"), false)?;
        let rust_enabled = parse_bool(lookup("EVENT_REPORTING_BACKEND_RS_ENABLED"), false)?;
        let enabled = globally_enabled && rust_enabled;
        let adv_attribution_enabled =
            parse_bool(lookup("EVENT_KAFKA_ADV_ATTRIBUTION_ENABLED"), false)?;
        let adv_read_wiki_enabled = parse_bool(lookup("EVENT_KAFKA_ADV_READ_WIKI_ENABLED"), false)?;
        let adv_model_storage_enabled =
            parse_bool(lookup("EVENT_KAFKA_ADV_MODEL_STORAGE_ENABLED"), false)?;
        let adv_quality_detail_enabled =
            parse_bool(lookup("EVENT_KAFKA_ADV_QUALITY_DETAIL_ENABLED"), false)?;
        let adv_result_detail_limit =
            parse_usize(lookup("EVENT_KAFKA_ADV_RESULT_DETAIL_LIMIT"), 10)?;
        let linger_ms = parse_u64(lookup("EVENT_KAFKA_LINGER_MS"), 20)?;
        let request_timeout_ms = parse_u64(lookup("EVENT_KAFKA_REQUEST_TIMEOUT_MS"), 5_000)?;
        let delivery_timeout_ms = parse_u64(lookup("EVENT_KAFKA_DELIVERY_TIMEOUT_MS"), 5_000)?;
        let queue_max_bytes = parse_usize(
            lookup("EVENT_KAFKA_QUEUE_MAX_BYTES"),
            DEFAULT_QUEUE_MAX_BYTES,
        )?;
        let event_max_bytes = parse_usize(
            lookup("EVENT_KAFKA_EVENT_MAX_BYTES"),
            DEFAULT_EVENT_MAX_BYTES,
        )?;
        let shutdown_timeout_ms = parse_u64(lookup("EVENT_KAFKA_SHUTDOWN_TIMEOUT_MS"), 8_000)?;
        let compression_type = text(&lookup, "EVENT_KAFKA_COMPRESSION_TYPE", "lz4");
        let security_protocol = text(&lookup, "EVENT_KAFKA_SECURITY_PROTOCOL", "PLAINTEXT");
        let sasl_mechanism = text(&lookup, "EVENT_KAFKA_SASL_MECHANISM", "PLAIN");
        let hostname = text(&lookup, "HOSTNAME", "local");
        let config = Self {
            enabled,
            adv_attribution_enabled,
            adv_read_wiki_enabled,
            adv_model_storage_enabled,
            adv_quality_detail_enabled,
            adv_result_detail_limit,
            bootstrap_servers: text(&lookup, "EVENT_KAFKA_BOOTSTRAP_SERVERS", ""),
            topic: text(&lookup, "EVENT_KAFKA_TOPIC", "knowledge-events-v1"),
            environment: text(&lookup, "EVENT_KAFKA_ENVIRONMENT", ""),
            client_id: text(
                &lookup,
                "EVENT_KAFKA_CLIENT_ID",
                "backend-rs-event-reporter",
            ),
            acks: text(&lookup, "EVENT_KAFKA_ACKS", "all"),
            compression_type,
            linger_ms,
            request_timeout: Duration::from_millis(request_timeout_ms),
            delivery_timeout: Duration::from_millis(delivery_timeout_ms),
            queue_max_bytes,
            event_max_bytes,
            shutdown_timeout: Duration::from_millis(shutdown_timeout_ms),
            security_protocol,
            sasl_mechanism,
            sasl_username: Secret::new(text(&lookup, "EVENT_KAFKA_SASL_USERNAME", "")),
            sasl_password: Secret::new(raw_text(&lookup, "EVENT_KAFKA_SASL_PASSWORD")),
            ssl_cafile: text(&lookup, "EVENT_KAFKA_SSL_CAFILE", ""),
            service_name: service_name.to_owned(),
            host_ip: lookup("POD_IP")
                .filter(|value| !value.trim().is_empty())
                .or_else(|| lookup("HOST_IP").filter(|value| !value.trim().is_empty())),
            service_version: lookup("SERVICE_VERSION")
                .filter(|value| !value.trim().is_empty())
                .or_else(|| lookup("IMAGE_TAG").filter(|value| !value.trim().is_empty())),
            service_instance: format!("{hostname}:{}", std::process::id()),
        };
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), ConfigErrorCode> {
        if !self.enabled {
            return Ok(());
        }
        if self.bootstrap_servers.is_empty() {
            return Err(ConfigErrorCode::MissingBootstrapServers);
        }
        if self.environment.is_empty() {
            return Err(ConfigErrorCode::MissingEnvironment);
        }
        if self.topic.is_empty() {
            return Err(ConfigErrorCode::MissingTopic);
        }
        if self.queue_max_bytes == 0 {
            return Err(ConfigErrorCode::InvalidQueueMaxBytes);
        }
        if self.event_max_bytes == 0 {
            return Err(ConfigErrorCode::InvalidEventMaxBytes);
        }
        if self.event_max_bytes > self.queue_max_bytes {
            return Err(ConfigErrorCode::EventLimitExceedsQueueLimit);
        }
        if self.event_max_bytes > 64 * 1024 || self.queue_max_bytes > 256 * 1024 * 1024 {
            return Err(ConfigErrorCode::InvalidMemoryLimit);
        }
        if self.request_timeout.is_zero() {
            return Err(ConfigErrorCode::InvalidRequestTimeoutMs);
        }
        if self.delivery_timeout.is_zero() {
            return Err(ConfigErrorCode::InvalidDeliveryTimeoutMs);
        }
        if self.adv_result_detail_limit > 100 {
            return Err(ConfigErrorCode::InvalidAdvResultDetailLimit);
        }
        if self.acks != "all" {
            return Err(ConfigErrorCode::InvalidAcks);
        }
        if !["", "gzip", "snappy", "lz4", "zstd"].contains(&self.compression_type.as_str()) {
            return Err(ConfigErrorCode::InvalidCompression);
        }
        if !["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"]
            .contains(&self.security_protocol.as_str())
        {
            return Err(ConfigErrorCode::InvalidSecurityProtocol);
        }
        if self.security_protocol.starts_with("SASL") {
            if self.sasl_username.is_empty() || self.sasl_password.is_empty() {
                return Err(ConfigErrorCode::MissingSaslCredentials);
            }
            if !["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"].contains(&self.sasl_mechanism.as_str())
            {
                return Err(ConfigErrorCode::InvalidSaslMechanism);
            }
        }
        Ok(())
    }
}

fn text(lookup: &impl Fn(&str) -> Option<String>, name: &str, default: &str) -> String {
    lookup(name)
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .unwrap_or_else(|| default.to_owned())
}

fn raw_text(lookup: &impl Fn(&str) -> Option<String>, name: &str) -> String {
    lookup(name).unwrap_or_default()
}

fn parse_bool(value: Option<String>, default: bool) -> Result<bool, ConfigErrorCode> {
    let Some(value) = value else {
        return Ok(default);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(ConfigErrorCode::InvalidEventConfiguration),
    }
}

fn parse_u64(value: Option<String>, default: u64) -> Result<u64, ConfigErrorCode> {
    value.map_or(Ok(default), |value| {
        value
            .trim()
            .parse()
            .map_err(|_| ConfigErrorCode::InvalidEventConfiguration)
    })
}

fn parse_usize(value: Option<String>, default: usize) -> Result<usize, ConfigErrorCode> {
    value.map_or(Ok(default), |value| {
        value
            .trim()
            .parse()
            .map_err(|_| ConfigErrorCode::InvalidEventConfiguration)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled() -> HashMap<String, String> {
        HashMap::from([
            ("EVENT_REPORTING_ENABLED".to_owned(), "true".to_owned()),
            (
                "EVENT_REPORTING_BACKEND_RS_ENABLED".to_owned(),
                "true".to_owned(),
            ),
            (
                "EVENT_KAFKA_BOOTSTRAP_SERVERS".to_owned(),
                "unused:9092".to_owned(),
            ),
            ("EVENT_KAFKA_ENVIRONMENT".to_owned(), "test".to_owned()),
        ])
    }

    #[test]
    fn rust_switch_is_independent() {
        let mut values = enabled();
        values.insert(
            "EVENT_REPORTING_BACKEND_RS_ENABLED".to_owned(),
            "false".to_owned(),
        );
        assert!(
            !ReporterConfig::from_mapping("backend", &values)
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn invalid_enabled_configuration_is_non_secret() {
        let mut values = enabled();
        values.insert(
            "EVENT_KAFKA_SECURITY_PROTOCOL".to_owned(),
            "SASL_SSL".to_owned(),
        );
        values.insert("EVENT_KAFKA_SASL_USERNAME".to_owned(), "alice".to_owned());
        assert!(matches!(
            ReporterConfig::from_mapping("backend", &values),
            Err(ConfigErrorCode::MissingSaslCredentials)
        ));
    }

    #[test]
    fn debug_redacts_credentials() {
        let mut values = enabled();
        values.insert(
            "EVENT_KAFKA_SECURITY_PROTOCOL".to_owned(),
            "SASL_SSL".to_owned(),
        );
        values.insert("EVENT_KAFKA_SASL_USERNAME".to_owned(), "alice".to_owned());
        values.insert("EVENT_KAFKA_SASL_PASSWORD".to_owned(), "private".to_owned());
        let rendered = format!(
            "{:?}",
            ReporterConfig::from_mapping("backend", &values).unwrap()
        );
        assert!(!rendered.contains("alice"));
        assert!(!rendered.contains("private"));
    }

    #[test]
    fn advanced_limit_is_bounded() {
        for (value, valid) in [("0", true), ("100", true), ("101", false)] {
            let mut values = enabled();
            values.insert(
                "EVENT_KAFKA_ADV_RESULT_DETAIL_LIMIT".to_owned(),
                value.to_owned(),
            );
            assert_eq!(
                ReporterConfig::from_mapping("backend", &values).is_ok(),
                valid
            );
        }
    }
}
