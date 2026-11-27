# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Standalone browser result page for connector authorization."""

from pathlib import Path
from string import Template

from fastapi.responses import HTMLResponse

from app.services.connector_oauth import ConnectorOAuthOutcome

_PAGE = Template(Path(__file__).with_suffix(".html").read_text(encoding="utf-8"))
_LANGUAGE_TAGS = {"en": "en", "zh": "zh-CN"}
_COPY = {
    "en": {
        "success": "Connector connected",
        "declined": "Authorization declined",
        "return": "You can close this window and return to Wegent.",
        "retry": "Close this window and return to Wegent to try again.",
        "close": "Close window",
    },
    "zh-CN": {
        "success": "连接器已连接",
        "declined": "授权已拒绝",
        "return": "你可以关闭此窗口，返回 Wegent 继续使用。",
        "retry": "请关闭此窗口，返回 Wegent 后重新授权。",
        "close": "关闭窗口",
    },
}


def _preferred_language(accept_language: str) -> str:
    candidates = []
    for item in accept_language.lower().split(","):
        tag, _, weight = item.partition(";")
        language = _LANGUAGE_TAGS.get(tag.strip().partition("-")[0])
        if not language:
            continue
        weight = weight.strip()
        try:
            quality = float(weight[2:]) if weight.startswith("q=") else 1
        except ValueError:
            continue
        if 0 < quality <= 1:
            candidates.append((quality, language))
    return max(candidates, key=lambda candidate: candidate[0], default=(0, "en"))[1]


def connector_oauth_result_page(
    outcome: ConnectorOAuthOutcome, accept_language: str
) -> HTMLResponse:
    language = _preferred_language(accept_language)
    copy = _COPY[language]
    success = outcome == "success"
    return HTMLResponse(
        _PAGE.substitute(
            language=language,
            outcome=outcome,
            symbol="✓" if success else "!",
            title=copy[outcome],
            instruction=copy["return" if success else "retry"],
            close_label=copy["close"],
        ),
        headers={
            "Cache-Control": "no-store",
            "Content-Language": language,
            "Referrer-Policy": "no-referrer",
        },
    )
