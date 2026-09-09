# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Opaque, stateless handles for runtime conversations and user turns.

Handles carry no permissions. Every use resolves the address through the caller's
owned Runtime work listing before sending any RPC.
"""

import base64
import binascii
import json
from dataclasses import dataclass

from fastapi import HTTPException


def _encode(prefix: str, parts: list[str]) -> str:
    payload = json.dumps(parts, separators=(",", ":"), ensure_ascii=False).encode()
    return prefix + base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _decode(identifier: str, prefix: str, count: int) -> list[str]:
    try:
        if not identifier.startswith(prefix) or len(identifier) > 8192:
            raise ValueError("Invalid handle")
        value = identifier[len(prefix) :]
        parts = json.loads(
            base64.b64decode(
                value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
            )
        )
        if not isinstance(parts, list) or len(parts) != count:
            raise ValueError("Invalid handle")
        if any(not isinstance(part, str) or not part for part in parts):
            raise ValueError("Invalid handle")
        return parts
    except (ValueError, UnicodeDecodeError, binascii.Error) as exc:
        raise HTTPException(400, "Invalid Wework resource ID") from exc


def conversation_id(device_id: str, task_id: str) -> str:
    return _encode("conv_", [device_id, task_id])


def conversation_address(identifier: str) -> tuple[str, str]:
    device, task = _decode(identifier, "conv_", 2)
    return device, task


@dataclass(frozen=True)
class ResponseIdentity:
    device_id: str
    task_id: str
    message_id: str

    @property
    def id(self) -> str:
        return _encode("resp_", [self.device_id, self.task_id, self.message_id])

    @property
    def conversation_id(self) -> str:
        return conversation_id(self.device_id, self.task_id)

    @classmethod
    def parse(cls, identifier: str) -> "ResponseIdentity":
        return cls(*_decode(identifier, "resp_", 3))
