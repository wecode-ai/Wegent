// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::TaskRuntimeError;

pub(super) const MAX_TAG_LENGTH: usize = 32;

pub(super) fn validate_tag(tag: &str) -> Result<(), TaskRuntimeError> {
    if tag.is_empty() || tag != tag.trim() || tag.chars().count() > MAX_TAG_LENGTH {
        return Err(TaskRuntimeError::Invalid(format!(
            "Tag names must be trimmed and contain 1 to {MAX_TAG_LENGTH} characters"
        )));
    }
    Ok(())
}
