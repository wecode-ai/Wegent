# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

TITLE_MAX_LENGTH = 18
PROMPT_META_PHRASES = (
    "会话提炼助手",
    "用户会话记录",
    "给定的用户会话记录",
    "上述会话",
    "prompt草案",
    "提炼可复用",
)
TITLE_META_PHRASES = (
    "会话提炼",
    "会话记录",
    "prompt草案",
    "生成提示词",
    "提示词生成",
)


def normalize_match_text(text: str) -> str:
    return "".join(ch.lower() for ch in text if not ch.isspace())


def looks_like_meta_prompt(prompt: str) -> bool:
    normalized = normalize_match_text(prompt)
    return any(
        normalize_match_text(phrase) in normalized for phrase in PROMPT_META_PHRASES
    )


def looks_like_meta_title(title: str) -> bool:
    normalized = normalize_match_text(title)
    if any(normalize_match_text(phrase) in normalized for phrase in TITLE_META_PHRASES):
        return True
    for prefix_length in range(4, min(9, len(normalized)) + 1):
        prefix = normalized[:prefix_length]
        if prefix and normalized.count(prefix) >= 2:
            return True
    return False


def normalize_title_text(title: str) -> str:
    normalized = title.strip().strip('"').strip("'")
    if len(normalized) > TITLE_MAX_LENGTH:
        normalized = normalized[:TITLE_MAX_LENGTH]
    return normalized


def validate_title_contract(title: str) -> None:
    if not title:
        raise ValueError("invalid_model_output")
    if looks_like_meta_title(title):
        raise ValueError("invalid_title_contract")
