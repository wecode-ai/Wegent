// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application-selected restrictions for externally stored attachments.
pub trait MediaPolicy: Send + Sync {
    fn download_unsupported(
        &self,
        context_type: &str,
        extension: &str,
        storage_backend: &str,
    ) -> bool;
}
pub struct DefaultMediaPolicy;
impl MediaPolicy for DefaultMediaPolicy {
    fn download_unsupported(&self, _: &str, _: &str, _: &str) -> bool {
        false
    }
}
