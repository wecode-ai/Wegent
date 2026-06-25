// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin, time::Duration};

use reqwest::Client;

use crate::{emitter::EventEnvelope, runner::EventSink};

const DEFAULT_TIMEOUT_SECONDS: u64 = 10;

#[derive(Debug, Clone)]
pub struct CallbackSink {
    callback_url: String,
    client: Client,
}

impl CallbackSink {
    pub fn new(callback_url: impl Into<String>) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECONDS))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            callback_url: callback_url.into(),
            client,
        })
    }
}

impl EventSink for CallbackSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let callback_url = self.callback_url.trim().to_owned();
        let client = self.client.clone();
        Box::pin(async move {
            if callback_url.is_empty() {
                return Ok(());
            }

            client
                .post(callback_url)
                .json(&event)
                .send()
                .await
                .map_err(|error| error.to_string())?
                .error_for_status()
                .map_err(|error| error.to_string())?;
            Ok(())
        })
    }
}
