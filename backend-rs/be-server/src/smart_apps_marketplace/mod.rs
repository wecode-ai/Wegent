// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/smart-apps/marketplace`.
//!
//! Port of `list_marketplace` (`app/api/endpoints/smart_apps.py`) and
//! `SmartAppMarketplaceService.list_marketplace` / `_item`
//! (`app/services/smart_app_marketplace_service.py`): read every published
//! Smart app, resolve the caller's ERP-department grants once, filter by the
//! optional `q`/`source`/`tag` parameters, and render each visible entry with
//! its latest release, owner name, and presigned icon/screenshot URLs.
//!
//! The response's `iconUrl` and `screenshotUrls` are request-time MinIO SigV4
//! presignatures (`object_storage_presign_service.generate_download_url`), so
//! their `X-Amz-Date`/`X-Amz-Credential`/`X-Amz-Signature` segments are
//! intentional source nondeterminism rather than a target defect. Everything
//! else in the body is stable for the recorded dependency responses.

mod db;
mod handler;
mod models;
mod service;
