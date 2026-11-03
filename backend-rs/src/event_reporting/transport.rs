// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::Instant;

use async_trait::async_trait;
use bytes::Bytes;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TransportErrorKind {
    Configuration,
    Authentication,
    Authorization,
    QueueFull,
    Retriable,
    Fatal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TransportError {
    pub(crate) kind: TransportErrorKind,
}

impl TransportError {
    pub(crate) const fn new(kind: TransportErrorKind) -> Self {
        Self { kind }
    }
}

#[async_trait]
pub(crate) trait EventTransport: Send + Sync {
    async fn send(&self, payload: Bytes) -> Result<(), TransportError>;
    async fn stop(&self, deadline: Instant) -> Result<(), TransportError>;
}
