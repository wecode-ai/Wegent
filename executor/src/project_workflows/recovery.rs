// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySummary {
    pub advanced: u64,
    pub failed: u64,
}
