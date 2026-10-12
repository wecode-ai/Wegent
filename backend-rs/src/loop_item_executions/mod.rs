// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The device-scoped loop-item execution claim used by the local App puller.
//!
//! Mirrors `app.api.endpoints.loop_item_executions.claim_my_next_execution`
//! (`POST /api/v1/loop-item-executions/claim-my-next`) and the service helpers
//! it calls in `app.services.device` and `app.services.loop_item_executions`.
//!
//! The endpoint resolves the caller's device Runtime route, verifies the
//! Runtime capacity snapshot, acquires the owner/device distributed locks, and
//! asks the queue for the next claimable local run. When the queue is empty the
//! response is JSON `null`, which is the contract the recorded traffic pins.
mod capacity;
mod claim;
mod device;
mod handler;
mod lock;
