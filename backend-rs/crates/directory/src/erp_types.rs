// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Employee profile values shared by directory providers.
use serde::Deserialize;

/// Employee profile fields returned by `ErpProvider::search_employee`
/// (`EmployeeInfo` from the configured store).
///
/// Fields decode like `EmployeeInfo.model_validate` with this port's
/// tolerance: a JSON string maps to `Some` (empty strings decode to `None`,
/// matching the source's empty-check consumers), and any other JSON shape
/// (missing, `null`) maps to `None`; wrong types reject the projection.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct EmployeeInfo {
    #[serde(default, deserialize_with = "brz_json::adapters::nonempty_string")]
    pub ssn: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::nonempty_string")]
    #[allow(dead_code)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::nonempty_string")]
    #[allow(dead_code)]
    pub email: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::nonempty_string")]
    #[allow(dead_code)]
    pub department: Option<String>,
}
