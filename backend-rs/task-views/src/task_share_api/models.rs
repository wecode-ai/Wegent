// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Request and response models for the task share endpoint.

use serde::Serialize;

/// `TaskShareResponse` (`app/schemas/shared_task.py`): the two fields in the
/// source's declaration order, `share_url` then `share_token`. FastAPI renders
/// it through the default `JSONResponse`, whose compact separators and field
/// order this struct reproduces.
#[derive(Debug, Serialize)]
pub(crate) struct TaskShareResponse {
    pub share_url: String,
    pub share_token: String,
}
