// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/// `BaseRole` string -> `ROLE_HIERARCHY` level; an unknown string is `None`,
/// mirroring the source `BaseRole(role)` `ValueError`.
pub fn role_level(role: &str) -> Option<u8> {
    match role {
        "Owner" => Some(0),
        "Maintainer" => Some(1),
        "Developer" => Some(2),
        "Reporter" => Some(3),
        "Viewer" => Some(4),
        "RestrictedAnalyst" => Some(5),
        _ => None,
    }
}
