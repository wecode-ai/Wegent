// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fmt;
use std::time::Duration;

#[cfg(test)]
use std::collections::HashMap;

const DEFAULT_QUEUE_MAX_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_EVENT_MAX_BYTES: usize = 8 * 1024;
const MAX_QUEUE_EVENTS: usize = 2_048;

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
    pub(crate) read_events_enabled: bool,
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
    InvalidMemoryLimit,
    InvalidTimeout,
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
        let enabled = parse_bool(lookup("EVENT_REPORTING_ENABLED"), false)?
            && parse_bool(lookup("EVENT_REPORTING_BACKEND_RS_ENABLED"), false)?;
        let request_timeout = duration(&lookup, "EVENT_KAFKA_REQUEST_TIMEOUT_MS", 5_000)?;
        let delivery_timeout = duration(&lookup, "EVENT_KAFKA_DELIVERY_TIMEOUT_MS", 5_000)?;
        let shutdown_timeout = duration(&lookup, "EVENT_KAFKA_SHUTDOWN_TIMEOUT_MS", 8_000)?;
        let hostname = text(&lookup, "HOSTNAME", "local");
        let config = Self {
            enabled,
            read_events_enabled: parse_bool(lookup("EVENT_KAFKA_ADV_READ_WIKI_ENABLED"), false)?,
            bootstrap_servers: text(&lookup, "EVENT_KAFKA_BOOTSTRAP_SERVERS", ""),
            topic: text(&lookup, "EVENT_KAFKA_TOPIC", "knowledge-events-v1"),
            environment: text(&lookup, "EVENT_KAFKA_ENVIRONMENT", ""),
            client_id: text(
                &lookup,
                "EVENT_KAFKA_CLIENT_ID",
                "backend-rs-event-reporter",
            ),
            acks: text(&lookup, "EVENT_KAFKA_ACKS", "all"),
            compression_type: text(&lookup, "EVENT_KAFKA_COMPRESSION_TYPE", "lz4"),
            linger_ms: number(&lookup, "EVENT_KAFKA_LINGER_MS", 20)?,
            request_timeout,
            delivery_timeout,
            queue_max_bytes: number(
                &lookup,
                "EVENT_KAFKA_QUEUE_MAX_BYTES",
                DEFAULT_QUEUE_MAX_BYTES,
            )?,
            event_max_bytes: number(
                &lookup,
                "EVENT_KAFKA_EVENT_MAX_BYTES",
                DEFAULT_EVENT_MAX_BYTES,
            )?,
            shutdown_timeout,
            security_protocol: text(&lookup, "EVENT_KAFKA_SECURITY_PROTOCOL", "PLAINTEXT"),
            sasl_mechanism: text(&lookup, "EVENT_KAFKA_SASL_MECHANISM", "PLAIN"),
            sasl_username: Secret::new(text(&lookup, "EVENT_KAFKA_SASL_USERNAME", "")),
            sasl_password: Secret::new(lookup("EVENT_KAFKA_SASL_PASSWORD").unwrap_or_default()),
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
        if self.queue_max_bytes == 0
            || self.event_max_bytes == 0
            || self.event_max_bytes > self.queue_max_bytes
            || self.event_max_bytes > 64 * 1024
            || self.queue_max_bytes > 256 * 1024 * 1024
        {
            return Err(ConfigErrorCode::InvalidMemoryLimit);
        }
        if self.request_timeout.is_zero()
            || self.delivery_timeout.is_zero()
            || self.shutdown_timeout.is_zero()
        {
            return Err(ConfigErrorCode::InvalidTimeout);
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

    pub(crate) fn queue_capacity(&self) -> usize {
        (self.queue_max_bytes / self.event_max_bytes).clamp(1, MAX_QUEUE_EVENTS)
    }
}

fn text(lookup: &impl Fn(&str) -> Option<String>, name: &str, default: &str) -> String {
    lookup(name)
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .unwrap_or_else(|| default.to_owned())
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

fn number<T>(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &str,
    default: T,
) -> Result<T, ConfigErrorCode>
where
    T: std::str::FromStr,
{
    lookup(name).map_or(Ok(default), |value| {
        value
            .trim()
            .parse()
            .map_err(|_| ConfigErrorCode::InvalidEventConfiguration)
    })
}

fn duration(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &str,
    default_ms: u64,
) -> Result<Duration, ConfigErrorCode> {
    Ok(Duration::from_millis(number(lookup, name, default_ms)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled() -> HashMap<String, String> {
        HashMap::from([
            ("EVENT_REPORTING_ENABLED".into(), "true".into()),
            ("EVENT_REPORTING_BACKEND_RS_ENABLED".into(), "true".into()),
            ("EVENT_KAFKA_BOOTSTRAP_SERVERS".into(), "unused:9092".into()),
            ("EVENT_KAFKA_ENVIRONMENT".into(), "test".into()),
        ])
    }

    #[test]
    fn rust_switch_is_independent() {
        let mut values = enabled();
        values.insert("EVENT_REPORTING_BACKEND_RS_ENABLED".into(), "false".into());
        assert!(
            !ReporterConfig::from_mapping("backend", &values)
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn debug_redacts_credentials() {
        let mut values = enabled();
        values.insert("EVENT_KAFKA_SECURITY_PROTOCOL".into(), "SASL_SSL".into());
        values.insert("EVENT_KAFKA_SASL_USERNAME".into(), "alice".into());
        values.insert("EVENT_KAFKA_SASL_PASSWORD".into(), "private".into());
        let rendered = format!(
            "{:?}",
            ReporterConfig::from_mapping("backend", &values).unwrap()
        );
        assert!(!rendered.contains("alice"));
        assert!(!rendered.contains("private"));
    }
}
