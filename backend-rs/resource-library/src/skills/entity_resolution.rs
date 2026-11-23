// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Employee identity resolution through the application-supplied provider.
use crate::ResourceLibraryState;

pub struct EntityResolution<'a> {
    pub state: &'a ResourceLibraryState,
    pub user_id: i32,
}
