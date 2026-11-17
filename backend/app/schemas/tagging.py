# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared tag normalization for loop items and cloud projects."""

from typing import Annotated

from pydantic import AfterValidator, BeforeValidator, Field

MAX_TAGS_PER_ITEM = 20
MAX_TAG_LENGTH = 32


def require_canonical_tag(value: str) -> str:
    """References must use the same canonical identity as normalized Issue tags."""
    if not value or value != value.strip():
        raise ValueError("Tag names must be nonblank and trimmed")
    return value


TagName = Annotated[
    str,
    Field(min_length=1, max_length=MAX_TAG_LENGTH),
    AfterValidator(require_canonical_tag),
]


def normalize_tags(value: object) -> list[str]:
    """Trim and dedupe without discarding tags before write validation."""
    if not isinstance(value, list):
        return []
    tags: list[str] = []
    for raw in value:
        tag = str(raw).strip()
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def normalize_tag_write(value: object) -> list[str]:
    """Reject malformed replacements before normalizing their tag values."""
    if not isinstance(value, list):
        raise ValueError("Tags must be an array")
    return normalize_tags(value)


NormalizedTags = Annotated[
    list[TagName],
    BeforeValidator(normalize_tag_write),
    Field(max_length=MAX_TAGS_PER_ITEM),
]
