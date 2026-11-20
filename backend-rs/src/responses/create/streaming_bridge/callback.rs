// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Establish the callback reader before a turn can publish its first event.

use std::future::Future;

use crate::http_compat::FastApiError;

use super::super::callback_source::{CallbackEventSource, CallbackSubscriptions};
use super::failure::BridgeFailure;

pub(super) async fn subscribe_before_dispatch<F, Fut>(
    provider: &dyn CallbackSubscriptions,
    channel: &str,
    subscription: &mut Option<Box<dyn CallbackEventSource>>,
    dispatch: F,
) -> Result<(), BridgeFailure>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), FastApiError>>,
{
    let reader = provider.subscribe(channel).await.map_err(|error| {
        BridgeFailure::generic(format!(
            "Failed to subscribe to callback stream channel: {}",
            error.message
        ))
    })?;
    // Keep the reader owned by the bridge during submission and on cancellation.
    *subscription = Some(reader);
    dispatch()
        .await
        .map_err(|error| BridgeFailure::dispatch(&error))
}
