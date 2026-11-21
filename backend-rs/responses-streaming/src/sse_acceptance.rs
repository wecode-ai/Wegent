// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! A first parsed event acknowledges a pipeline only while its owner is live.

use brz_redis::Redis;
use std::sync::Mutex;
use tokio::sync::oneshot;

use wegent_execution_completion::lease_receipt::LeaseReceipt;

pub struct DispatchAcceptance {
    sender: Mutex<Option<oneshot::Sender<Result<(), String>>>>,
    pub receipt: Option<LeaseReceipt>,
}

impl DispatchAcceptance {
    pub fn new(sender: oneshot::Sender<Result<(), String>>) -> Self {
        Self {
            sender: Mutex::new(Some(sender)),
            receipt: None,
        }
    }

    pub fn resolve(&self, result: Result<(), String>) -> bool {
        if let Some(sender) = self.sender.lock().expect("dispatch acceptance lock").take() {
            let _ = sender.send(result);
            true
        } else {
            false
        }
    }

    pub async fn accept(&self, redis: &impl Redis) -> Result<(), String> {
        if self
            .sender
            .lock()
            .expect("dispatch acceptance lock")
            .is_none()
        {
            return Ok(());
        }
        let receipt = self
            .receipt
            .as_ref()
            .ok_or("Pipeline execution ownership is missing")?;
        if !receipt
            .accept(redis)
            .await
            .map_err(|error| error.to_string())?
        {
            return Err("Pipeline execution ownership was lost before acceptance".into());
        }
        self.resolve(Ok(()));
        Ok(())
    }
}
