// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}/attachments` — list one loop item's
//! attachments.
//!
//! Mirrors `app.api.endpoints.deliveries.list_loop_item_attachments`:
//! `loop_item_attachment_provider_router.list(db, item_id, current_user.id)`
//! then `LoopItemAttachmentResponse.model_validate(item)` per row.
//!
//! `LoopItemAttachmentProviderRouter.list` branches on
//! `external_loop_item_provider.is_external_item(db, item_id)`:
//! - external (`KEY-number` id whose project is github/gitlab backed):
//!   `external_loop_item_provider.list_attachments` — a 409 for non-gitlab
//!   providers, otherwise the provider issue attachment projection;
//! - local: `loop_item_service.list_attachments` — the item access check
//!   (`loop_item_service.get`) followed by the `loop_items` attachment rows
//!   ordered by `created_at DESC`.
//!
//! The recorded case is a local item with no attachments, so the response is
//! `[]`.

mod content;
pub(crate) mod handler;

mod external;
pub(crate) mod repository;
mod response;
