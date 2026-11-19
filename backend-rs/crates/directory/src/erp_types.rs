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
/// Outcome of one directory employee search.
///
/// `NotFound` is a successful directory response with no matching employee;
/// the negative cache (`erp:no_profile:<user_id>`) is written only for that
/// outcome. Transport failures, non-success statuses, invalid payloads and an
/// unconfigured directory are `Unavailable`, so a transient failure is never
/// cached as "employee does not exist".
#[derive(Debug, Clone)]
pub enum EmployeeSearchOutcome {
    /// A directory response that names an employee.
    Found(EmployeeInfo),
    /// The directory answered successfully and no employee matched.
    NotFound,
    /// The search could not be performed or its answer is not trustworthy.
    Unavailable,
}

impl EmployeeSearchOutcome {
    /// Collapse to the historical `Option`: only `Found` is `Some`.
    #[must_use]
    pub fn into_option(self) -> Option<EmployeeInfo> {
        match self {
            Self::Found(employee) => Some(employee),
            Self::NotFound | Self::Unavailable => None,
        }
    }
}

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
