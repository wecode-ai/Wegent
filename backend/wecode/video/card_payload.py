# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Normalize private QIA card payloads for the public CardBlock protocol."""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse


def _absolute_video_detail_url(value: Any, frontend_url: str) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None

    candidate = value.strip()
    parsed = urlparse(candidate)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return candidate
    if parsed.scheme or parsed.netloc:
        return None

    query = parse_qs(parsed.query)
    if parsed.path != "/chat" or query.get("mode") != ["video"]:
        return None

    frontend = urlparse(frontend_url.strip())
    if (
        frontend.scheme not in {"http", "https"}
        or not frontend.netloc
        or frontend.username
        or frontend.password
    ):
        return None
    return urljoin(f"{frontend_url.rstrip('/')}/", candidate.lstrip("/"))


def _public_buttons(content: Any) -> list[dict[str, Any]]:
    buttons: list[dict[str, Any]] = []
    if not isinstance(content, list):
        return buttons

    for section in content:
        if not isinstance(section, dict) or section.get("type") != "button":
            continue
        values = section.get("value")
        if not isinstance(values, list):
            continue
        for index, item in enumerate(values):
            if not isinstance(item, dict):
                continue
            button: dict[str, Any] = {
                "button_id": str(item.get("button_id") or f"button-{index}"),
                "button_name": str(item.get("button_name") or ""),
                "button_type": str(item.get("button_type") or "chat"),
            }
            for key in ("link", "url"):
                value = item.get(key)
                if isinstance(value, str):
                    button[key] = value
            credit_params = item.get("credit_params")
            if isinstance(credit_params, dict):
                button["credit_params"] = dict(credit_params)
            buttons.append(button)
    return buttons


def normalize_qia_card_data(
    raw: dict[str, Any],
    *,
    frontend_url: str,
) -> dict[str, Any]:
    """Convert QIA card fields into safe, renderer-ready public data."""
    card = dict(raw)

    if "link" in card:
        detail_url = _absolute_video_detail_url(card.get("link"), frontend_url)
        if detail_url:
            card["link"] = detail_url
        else:
            card.pop("link", None)

    buttons = _public_buttons(card.pop("content", None))
    if buttons:
        card["buttons"] = buttons
    return card
