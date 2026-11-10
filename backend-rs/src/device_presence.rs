// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Persistent device presence is independent of the expiring online cache.

pub(crate) fn latest_online_time(stored: Option<&str>, observed: Option<&str>) -> Option<String> {
    [stored, observed]
        .into_iter()
        .flatten()
        .filter_map(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .max()
        .map(|at| at.with_timezone(&chrono::Utc).to_rfc3339())
}
