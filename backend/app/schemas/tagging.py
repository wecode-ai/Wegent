# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared tag normalization for loop items and cloud projects."""

from typing import Annotated

from pydantic import Field

MAX_TAGS_PER_ITEM = 20
MAX_TAG_LENGTH = 32
TagName = Annotated[str, Field(min_length=1, max_length=MAX_TAG_LENGTH)]


def normalize_tags(value: object) -> list[str]:
    """Trim, dedupe, and cap tag lists; non-list input becomes empty."""
    if not isinstance(value, list):
        return []
    tags: list[str] = []
    for raw in value:
        tag = str(raw).strip()
        if tag and tag not in tags:
            tags.append(tag)
    return tags[:MAX_TAGS_PER_ITEM]
