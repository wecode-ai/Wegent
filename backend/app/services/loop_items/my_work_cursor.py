# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Opaque My Work ordering keys; authorization is re-evaluated for every page."""

import base64
import binascii
import json
import re
from datetime import datetime

from fastapi import HTTPException


def encode_my_work_cursor(updated_at: str, item_id: str, user_id: int) -> str:
    payload = json.dumps(
        {
            "v": 1,
            "user_id": user_id,
            "updated_at": updated_at,
            "id": item_id,
        },
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def decode_my_work_cursor(cursor: str | None, user_id: int) -> tuple[str, str] | None:
    if cursor is None:
        return None
    try:
        if not cursor or len(cursor) > 2048:
            raise ValueError("Invalid cursor length")
        payload = json.loads(
            base64.b64decode(
                cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True
            )
        )
        if not isinstance(payload, dict) or set(payload) != {
            "v",
            "user_id",
            "updated_at",
            "id",
        }:
            raise ValueError("Unexpected cursor fields")
        updated_at = datetime.fromisoformat(payload["updated_at"])
        item_id = payload["id"]
        if (
            type(payload["v"]) is not int
            or payload["v"] != 1
            or type(payload["user_id"]) is not int
            or payload["user_id"] != user_id
            or updated_at.tzinfo is not None
            or updated_at.year < 1000
            or not re.fullmatch(
                r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?",
                payload["updated_at"],
            )
            or not isinstance(item_id, str)
            or not item_id
            or len(item_id) > 64
            or "\0" in item_id
        ):
            raise ValueError("Invalid ordering key")
    except (binascii.Error, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Invalid My Work cursor") from exc
    return payload["updated_at"], item_id
