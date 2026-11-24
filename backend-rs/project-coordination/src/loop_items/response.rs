// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `LoopItemResponse` body shared by the loop-item reads.
//!
//! The authoritative projection lives in
//! [`crate::loop_tasks::item_response::response_values`]; the loop-item board
//! reads only add the list envelope. The external-provider projection converts
//! its own issue DTO into the same body, so every route emits one schema.

pub use crate::loop_tasks::item_response::LoopItemResponse;
pub use crate::loop_tasks::item_response::Permissions as LoopItemPermissions;

/// The `LoopItemListResponse` body (`app.schemas.delivery.LoopItemListResponse`).
#[derive(Debug, serde::Serialize)]
pub struct LoopItemListResponse {
    pub items: Vec<LoopItemResponse>,
}
