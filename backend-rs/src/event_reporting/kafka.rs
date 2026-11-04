// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use rdkafka::config::ClientConfig;
use rdkafka::error::{KafkaError, RDKafkaErrorCode};
use rdkafka::producer::{FutureProducer, FutureRecord, Producer};
use rdkafka::util::Timeout;

use super::config::ReporterConfig;
use super::transport::{EventTransport, TransportError, TransportErrorKind};

pub(crate) struct KafkaTransport {
    producer: FutureProducer,
    topic: String,
}

impl KafkaTransport {
    pub(crate) fn new(config: &ReporterConfig) -> Result<Self, TransportError> {
        let mut client = ClientConfig::new();
        client
            .set("bootstrap.servers", &config.bootstrap_servers)
            .set("client.id", &config.client_id)
            .set("acks", &config.acks)
            .set("linger.ms", config.linger_ms.to_string())
            .set(
                "request.timeout.ms",
                config.request_timeout.as_millis().to_string(),
            )
            .set(
                "message.timeout.ms",
                config.delivery_timeout.as_millis().to_string(),
            )
            .set("security.protocol", &config.security_protocol)
            .set("sasl.mechanisms", &config.sasl_mechanism)
            .set(
                "queue.buffering.max.kbytes",
                (config.queue_max_bytes / 1024).max(1).to_string(),
            );
        if !config.compression_type.is_empty() {
            client.set("compression.type", &config.compression_type);
        }
        if !config.sasl_username.is_empty() {
            client.set("sasl.username", config.sasl_username.expose());
        }
        if !config.sasl_password.is_empty() {
            client.set("sasl.password", config.sasl_password.expose());
        }
        if !config.ssl_cafile.is_empty() {
            client.set("ssl.ca.location", &config.ssl_cafile);
        }
        let producer = client
            .create::<FutureProducer>()
            .map_err(|_| TransportError::new(TransportErrorKind::Configuration))?;
        Ok(Self {
            producer,
            topic: config.topic.clone(),
        })
    }
}

#[async_trait]
impl EventTransport for KafkaTransport {
    async fn send(&self, payload: Bytes) -> Result<(), TransportError> {
        let delivery = self
            .producer
            .send_result(FutureRecord::<(), [u8]>::to(&self.topic).payload(payload.as_ref()))
            .map_err(|(error, _)| classify(&error))?;
        match delivery.await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err((error, _))) => Err(classify(&error)),
            Err(_) => Err(TransportError::new(TransportErrorKind::Fatal)),
        }
    }

    async fn stop(&self, deadline: Instant) -> Result<(), TransportError> {
        let producer = self.producer.clone();
        let remaining = deadline.saturating_duration_since(Instant::now());
        let result = tokio::task::spawn_blocking(move || {
            producer.flush(Timeout::After(remaining.max(Duration::from_millis(1))))
        })
        .await
        .map_err(|_| TransportError::new(TransportErrorKind::Fatal))?;
        result.map_err(|error| classify(&error))
    }
}

fn classify(error: &KafkaError) -> TransportError {
    let kind = match error.rdkafka_error_code() {
        Some(RDKafkaErrorCode::QueueFull) => TransportErrorKind::QueueFull,
        Some(
            RDKafkaErrorCode::Authentication
            | RDKafkaErrorCode::UnsupportedSASLMechanism
            | RDKafkaErrorCode::IllegalSASLState,
        ) => TransportErrorKind::Authentication,
        Some(RDKafkaErrorCode::TopicAuthorizationFailed)
        | Some(RDKafkaErrorCode::ClusterAuthorizationFailed) => TransportErrorKind::Authorization,
        Some(RDKafkaErrorCode::Fatal) => TransportErrorKind::Fatal,
        Some(RDKafkaErrorCode::InvalidArgument | RDKafkaErrorCode::BadCompression) => {
            TransportErrorKind::Configuration
        }
        Some(_) => TransportErrorKind::Retriable,
        None => TransportErrorKind::Retriable,
    };
    TransportError::new(kind)
}
