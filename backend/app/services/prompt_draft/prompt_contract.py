# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import re

PROMPT_SECTION_TITLES = (
    "你的工作方式",
    "处理任务时请遵循以下原则",
    "输出要求",
)


def _strip_list_marker(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        return ""
    return re.sub(r"^(?:[-*•]|\d+[.)])\s*", "", stripped).strip()


def _split_section_items(content: str) -> list[str]:
    normalized = content.strip()
    if not normalized:
        return []

    items: list[str] = []
    lines = [line.strip() for line in normalized.splitlines() if line.strip()]
    bullet_lines = [line for line in lines if re.match(r"^(?:[-*•]|\d+[.)])\s*", line)]

    if bullet_lines:
        for line in bullet_lines:
            item = _strip_list_marker(line)
            if item and item not in items:
                items.append(item)
        return items

    for match in re.finditer(r"[^；;。]+[；;。]?", normalized):
        item = _strip_list_marker(match.group(0))
        if item and item not in items:
            items.append(item)
    return items


def build_markdown_prompt(
    intro: str,
    work_modes: list[str],
    principles: list[str],
    output_requirements: list[str],
) -> str:
    sections = [
        ("你的工作方式", work_modes),
        ("处理任务时请遵循以下原则", principles),
        ("输出要求", output_requirements),
    ]
    lines = [intro.strip()]
    for title, items in sections:
        lines.extend(["", f"## {title}"])
        lines.extend(f"- {item}" for item in items if item.strip())
    return "\n".join(lines).strip()


def normalize_prompt_markdown(prompt: str) -> str:
    normalized = prompt.strip()
    if not normalized:
        return normalized
    if all(f"## {title}" in normalized for title in PROMPT_SECTION_TITLES):
        return normalized

    intro_match = re.search(
        r"^(.*?)(?=(?:##\s*)?你的工作方式[:：])",
        normalized,
        re.DOTALL,
    )
    if not intro_match:
        return normalized

    intro = " ".join(intro_match.group(1).split())
    if not intro.startswith("你是"):
        return normalized

    section_pattern = re.compile(
        r"(?:##\s*)?"
        r"(你的工作方式|处理任务时请遵循以下原则|输出要求)"
        r"[:：]\s*(.*?)(?=(?:##\s*)?(?:你的工作方式|处理任务时请遵循以下原则|输出要求)[:：]|$)",
        re.DOTALL,
    )
    extracted_sections = {
        title: content for title, content in section_pattern.findall(normalized)
    }
    if len(extracted_sections) != len(PROMPT_SECTION_TITLES):
        return normalized

    items_per_section = [
        _split_section_items(extracted_sections[title])
        for title in PROMPT_SECTION_TITLES
    ]
    if any(not items for items in items_per_section):
        return normalized

    return build_markdown_prompt(
        intro=intro,
        work_modes=items_per_section[0],
        principles=items_per_section[1],
        output_requirements=items_per_section[2],
    )


__all__ = [
    "PROMPT_SECTION_TITLES",
    "build_markdown_prompt",
    "normalize_prompt_markdown",
]
