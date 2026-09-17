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
/// (missing, `null`, number) maps to `None`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct EmployeeInfo {
    #[serde(default, deserialize_with = "string_or_none")]
    pub ssn: Option<String>,
    #[serde(default, deserialize_with = "string_or_none")]
    #[allow(dead_code)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "string_or_none")]
    #[allow(dead_code)]
    pub email: Option<String>,
    #[serde(default, deserialize_with = "string_or_none")]
    #[allow(dead_code)]
    pub department: Option<String>,
}

/// Decode one employee field: a non-empty JSON string is kept; missing,
/// `null`, empty strings, and non-string shapes decode to `None` (the
/// consumer contract of the old `employee_info` helper).
fn string_or_none<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<String> = Option::<String>::deserialize(deserializer)?;
    Ok(value.filter(|text| !text.is_empty()))
}
