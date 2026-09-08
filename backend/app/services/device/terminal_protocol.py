# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Versioned terminal wire parsing shared by browser and executor relays."""

import re
from dataclasses import dataclass
from typing import Optional

CONSUMER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
V2_FIELDS = {"consumer_id", "sequence", "last_acked_sequence"}


def get_protocol_version(data: dict, default: int = 1) -> Optional[int]:
    """Only integer versions are valid; missing request versions mean v1."""
    value = data.get("protocol_version", default) if isinstance(data, dict) else None
    return value if type(value) is int and value in (1, 2) else None


def get_consumer_id(data: dict) -> str:
    value = data.get("consumer_id") if isinstance(data, dict) else None
    if not isinstance(value, str):
        return ""
    value = value.strip()
    return value if CONSUMER_ID_PATTERN.fullmatch(value) else ""


def get_sequence(data: dict, key: str, minimum: int = 1) -> Optional[int]:
    value = data.get(key) if isinstance(data, dict) else None
    return value if type(value) is int and value >= minimum else None


@dataclass(frozen=True)
class TerminalAttachRequest:
    protocol_version: int
    consumer_id: str = ""
    last_acked_sequence: int = 0

    @classmethod
    def parse(cls, data: dict) -> "TerminalAttachRequest":
        version = get_protocol_version(data)
        if version is None:
            raise ValueError("Invalid terminal protocol_version")
        if version == 1:
            return cls(protocol_version=1)
        consumer_id = get_consumer_id(data)
        if not consumer_id:
            raise ValueError("Invalid consumer_id")
        sequence = get_sequence(data, "last_acked_sequence", minimum=0)
        if sequence is None:
            raise ValueError("Invalid last_acked_sequence")
        return cls(version, consumer_id, sequence)

    def offer(self, *, v2_enabled: bool, pinned: Optional[int]) -> int:
        if pinned is not None and pinned != self.protocol_version:
            raise ValueError("Terminal protocol is pinned; recreate terminal session")
        version = pinned or (self.protocol_version if v2_enabled else 1)
        if version == 1 and self.last_acked_sequence > 0:
            raise ValueError(
                "Cannot downgrade terminal resume; recreate terminal session"
            )
        return version

    def select(self, response: dict, offered: int, pinned: Optional[int]) -> int:
        version = get_protocol_version(response)
        if version is None or version > offered:
            raise ValueError("Invalid executor terminal protocol_version")
        if pinned is not None and version != pinned:
            raise ValueError("Terminal protocol is pinned; recreate terminal session")
        if version == 1 and self.last_acked_sequence > 0:
            raise ValueError(
                "Cannot downgrade terminal resume; recreate terminal session"
            )
        return version

    def payload(self, session_id: str, offered: int) -> dict:
        payload = {"session_id": session_id, "protocol_version": offered}
        if offered == 2:
            payload.update(
                consumer_id=self.consumer_id,
                last_acked_sequence=self.last_acked_sequence,
            )
        return payload


def parse_terminal_event(data: dict, *, output: bool) -> dict:
    """Accept complete legacy events, never reinterpret malformed v2 as v1."""
    if not isinstance(data, dict):
        raise ValueError("Invalid terminal event")
    has_v2_fields = bool(V2_FIELDS.intersection(data))
    version = get_protocol_version(data, default=2 if has_v2_fields else 1)
    if version is None or (version == 1 and has_v2_fields):
        raise ValueError("Invalid terminal protocol_version")

    if version == 2 and (output or "sequence" in data):
        if get_sequence(data, "sequence") is None:
            raise ValueError("Invalid terminal sequence")
    if output:
        if not isinstance(data.get("data"), str):
            raise ValueError("Invalid terminal output")
        allowed = {"session_id", "data", "protocol_version"}
    else:
        if "exit_code" not in data or (
            data["exit_code"] is not None and type(data["exit_code"]) is not int
        ):
            raise ValueError("Invalid terminal exit_code")
        if "error" in data and not isinstance(data["error"], str):
            raise ValueError("Invalid terminal error")
        allowed = {"session_id", "exit_code", "error", "protocol_version"}
    payload = dict(data)
    if version == 2:
        consumer_id = get_consumer_id(data)
        if not consumer_id:
            raise ValueError("Invalid terminal consumer")
        payload["consumer_id"] = consumer_id
        allowed.update({"consumer_id", "sequence"})
    if data.keys() - allowed:
        raise ValueError("Invalid terminal event fields")
    return payload
