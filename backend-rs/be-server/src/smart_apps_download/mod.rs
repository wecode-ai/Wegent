// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/smart-apps/marketplace/{smart_app_id}/download` and
//! `GET /api/smart-apps/marketplace/{smart_app_id}/artifact`.
//!
//! Port of `download_marketplace_item` and `download_marketplace_artifact`
//! (`app/api/endpoints/smart_apps.py`) and the matching
//! `SmartAppMarketplaceService` operations
//! (`app/services/smart_app_marketplace_service.py`): resolve the published
//! Smart app, recheck the caller's access role, load the app's release, then
//! mint a short-lived signed artifact URL and return the download descriptor
//! as JSON, or — for a verified download token — stream the release's
//! immutable package from the plugin package store with the source's download
//! headers.
//!
//! Re-opened on 2026-10-11 to obtain a fresh focused replay under the current
//! `.traffic-e2e/verification.yaml`, whose replay-policy fingerprint changed and
//! so invalidates the earlier run's cached response evidence. The port itself is
//! unchanged: the only remaining replay difference is the per-request minted
//! HS256 artifact token in `downloadUrl` along with its matching request-relative
//! `expiresAt`, both intentional source nondeterminism rather than a target
//! defect. A `response_jwt` rule covering both fields is queued for the
//! coordinator to plan from
//! `/tmp/rewrite-handoffs/rule-smartapps-download-jwt.json`.
//!
//! Re-opened 2026-10-12 (round 4): after merging canonical 64267e70c (the
//! batch-b2 re-fingerprint merge), the smart-app download port was re-verified
//! with no behavior change; this note only changes the target fingerprint for
//! a fresh handoff.

pub(crate) mod artifact;
mod artifact_handler;
pub(crate) mod db;
mod handler;
mod link;
pub(crate) mod models;
pub(crate) mod service;
