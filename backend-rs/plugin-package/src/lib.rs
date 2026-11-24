// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Plugin package inspection shared by upstream mirroring and bundled installation.

mod metadata;
mod package;

pub use metadata::{components, interface};
pub use package::{File, MAXIMUM, Package, equivalent, normalize, prepare};
