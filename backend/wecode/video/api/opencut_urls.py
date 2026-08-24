# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Signed callback and editor URLs for the OpenCut bridge."""

import os
from time import time
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException
from jose import JWTError, jwt

from app.core.config import settings

OPENCUT_TOKEN_KIND = "aigc-video-opencut"
OPENCUT_TOKEN_TTL_SECONDS = 24 * 60 * 60


def _opencut_public_url() -> str:
    return (
        os.environ.get("WEGENT_OPENCUT_URL", "https://timeline-cut.weibo.com")
        .strip()
        .rstrip("/")
    )


def create_opencut_urls(
    *,
    callback_base: str,
    session_id: str,
    artifact_id: str,
    uid: str,
    user_id: int,
) -> dict[str, str]:
    token = jwt.encode(
        {
            "kind": OPENCUT_TOKEN_KIND,
            "session_id": str(session_id),
            "artifact_id": str(artifact_id),
            "uid": str(uid),
            "user_id": int(user_id),
            "exp": int(time()) + OPENCUT_TOKEN_TTL_SECONDS,
        },
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )
    encoded_session = quote(str(session_id), safe="")
    encoded_token = quote(token, safe="")
    import_url = (
        f"{callback_base}/api/aigc-video/material-video/opencut/import/"
        f"{encoded_session}?token={encoded_token}"
    )
    return_url = (
        f"{callback_base}/api/aigc-video/material-video/opencut/save/"
        f"{encoded_session}?token={encoded_token}"
    )
    open_url = (
        f"{_opencut_public_url()}/storycut/import"
        f"?url={quote(import_url, safe='')}"
        f"&returnUrl={quote(return_url, safe='')}"
        "&embed=wegent"
    )
    return {
        "open_url": open_url,
        "import_url": import_url,
        "return_url": return_url,
        "token": token,
    }


def verify_opencut_token(token: str, session_id: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid OpenCut token") from exc
    if (
        payload.get("kind") != OPENCUT_TOKEN_KIND
        or str(payload.get("session_id") or "") != str(session_id)
        or not payload.get("artifact_id")
        or not payload.get("uid")
    ):
        raise HTTPException(status_code=401, detail="Invalid OpenCut token")
    return payload
