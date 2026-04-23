# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Transition page item constants."""

ITEM_PAGE = "page"
ITEM_GROUP = "group"
ITEM_GROUP_MEMBER = "group_member"
ITEM_BLOCK = "block"
ITEM_USER_CONTENT = "user_content"
ITEM_OVERRIDE = "override"

STATUS_DRAFT = "draft"
STATUS_PUBLISHED = "published"
STATUS_ARCHIVED = "archived"

STAGE_ALWAYS = "always"
STAGE_BEFORE_START = "before_start"
STAGE_ACTIVE = "active"
STAGE_AFTER_END = "after_end"

BUTTON_PRIMARY = "primary"
BUTTON_SECONDARY = "secondary"
BUTTON_OUTLINE = "outline"

ALLOWED_BUTTON_VARIANTS = {BUTTON_PRIMARY, BUTTON_SECONDARY, BUTTON_OUTLINE}
ALLOWED_BUTTON_TARGETS = {"_self", "_blank"}
ALLOWED_STAGES = {STAGE_ALWAYS, STAGE_BEFORE_START, STAGE_ACTIVE, STAGE_AFTER_END}
ALLOWED_ITEM_TYPES = {
    ITEM_PAGE,
    ITEM_GROUP,
    ITEM_GROUP_MEMBER,
    ITEM_BLOCK,
    ITEM_USER_CONTENT,
    ITEM_OVERRIDE,
}
ALLOWED_STATUSES = {STATUS_DRAFT, STATUS_PUBLISHED, STATUS_ARCHIVED}


def user_key(user_id: int) -> str:
    return f"user:{user_id}"


def page_global_key(slug: str) -> str:
    return f"transition-page:{slug}"
