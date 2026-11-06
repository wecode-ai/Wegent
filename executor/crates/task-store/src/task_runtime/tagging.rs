// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::TaskRuntimeError;
use std::collections::HashSet;

pub(super) const MAX_TAG_LENGTH: usize = 32;
pub(super) const MAX_TAGS_PER_ITEM: usize = 20;

pub(super) fn validate_tags(tags: &[String]) -> Result<(), TaskRuntimeError> {
    if tags.iter().collect::<HashSet<_>>().len() > MAX_TAGS_PER_ITEM {
        return Err(TaskRuntimeError::Invalid(format!(
            "Cannot have more than {MAX_TAGS_PER_ITEM} tags"
        )));
    }
    tags.iter().try_for_each(|tag| validate_tag(tag))
}

pub(super) fn validate_tag(tag: &str) -> Result<(), TaskRuntimeError> {
    if tag.is_empty() || tag != tag.trim() || tag.chars().count() > MAX_TAG_LENGTH {
        return Err(TaskRuntimeError::Invalid(format!(
            "Tag names must be trimmed and contain 1 to {MAX_TAG_LENGTH} characters"
        )));
    }
    Ok(())
}
