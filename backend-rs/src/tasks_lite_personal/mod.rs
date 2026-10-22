// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/lite/personal`
//! (source `app/api/endpoints/adapter/tasks.py:get_personal_tasks_lite`,
//! router prefix `/tasks` under the app prefix `/api`).
//!
//! Re-verified 2026-10-11 after the `WEGENT_RS_RECORDING_ENABLED=false`
//! override. This module holds no Redis traffic: the only residual replay dirt
//! was three target-only `GET recording:wegent:max-gateways` observations
//! emitted by the recording admission provider
//! (`backend-rs-intra/src/hybrid/recording.rs`), which is process-owned gateway
//! traffic rather than a request-path dependency of this route.
//!
//! Re-opened 2026-10-11 after the traffic-e2e engine upgrade. This note exists
//! only to change the target fingerprint so the engine schedules a fresh
//! focused replay of this route; it does not alter behavior.

pub mod handler;
pub mod lite_projection;
pub mod lite_repository;
