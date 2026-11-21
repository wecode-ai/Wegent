// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `TaskCompletedEvent` handlers registered at startup
//! (`app/main.py:419-446`).
pub(crate) mod channel;
pub(crate) mod code_wiki;
pub(crate) mod pet;
pub(crate) mod project_automation;
pub(crate) mod subscription;

use chrono::{Local, NaiveDateTime};

/// `datetime.now()`: the process-local naive clock the source stamps into its
/// JSON payloads and `DATETIME` columns.
pub(crate) fn now_local() -> NaiveDateTime {
    Local::now().naive_local()
}

/// The `%Y-%m-%d %H:%M:%S%.f` DATETIME rendering of a local timestamp.
pub(crate) fn local_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}
