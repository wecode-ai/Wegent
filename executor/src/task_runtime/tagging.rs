// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::TaskRuntimeError;

pub(super) const MAX_TAG_LENGTH: usize = 32;

pub(super) fn validate_tag(tag: &str) -> Result<(), TaskRuntimeError> {
    if tag.trim().is_empty() || tag.chars().count() > MAX_TAG_LENGTH {
        return Err(TaskRuntimeError::Invalid(format!(
            "Tag names must contain 1 to {MAX_TAG_LENGTH} characters"
        )));
    }
    Ok(())
}
