# SPDX-License-Identifier: Apache-2.0
"""Bounded frames over a host-owned descriptor; never a model-visible channel."""

from __future__ import annotations

import json
import os
import socket
import stat
import struct
import sys
from typing import Any, BinaryIO

MAX_FRAME_BYTES = 65536


class AuthError(RuntimeError):
    """A failure whose message contains no credential material."""


def open_pipe(mode: str) -> BinaryIO:
    try:
        if mode not in {"rb", "wb", "rwb"}:
            raise ValueError
        if "WEGENT_PLUGIN_AUTH_PORT" in os.environ:
            return _open_socket(mode)
        fd = int(os.environ["WEGENT_PLUGIN_AUTH_FD"])
        if fd < 3:
            raise ValueError
        info = os.fstat(fd)
        if not (stat.S_ISFIFO(info.st_mode) or stat.S_ISSOCK(info.st_mode)):
            raise ValueError
        if mode == "rwb" and not stat.S_ISSOCK(info.st_mode):
            raise ValueError
        os.set_inheritable(fd, False)
        return os.fdopen(fd, "r+b" if mode == "rwb" else mode)
    except (KeyError, ValueError, OSError):
        raise AuthError("A dedicated broker pipe is required") from None


def _open_socket(mode: str) -> BinaryIO:
    """Cross-platform native transport; stdin carries a one-use capability only."""
    if "WEGENT_PLUGIN_AUTH_FD" in os.environ:
        raise AuthError("Ambiguous broker transport")
    port = int(os.environ.pop("WEGENT_PLUGIN_AUTH_PORT"))
    if not 1 <= port <= 65535:
        raise AuthError("Invalid broker transport")
    nonce = _read_exact(sys.stdin.buffer, 32)
    with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
        connection.set_inheritable(False)
        connection.sendall(nonce)
        return connection.makefile(mode)


def _read_exact(stream: BinaryIO, length: int) -> bytes:
    result = bytearray()
    while len(result) < length:
        chunk = stream.read(length - len(result))
        if not chunk:
            raise AuthError("Incomplete credential frame")
        result.extend(chunk)
    return bytes(result)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def read_frame(stream: BinaryIO) -> dict[str, Any]:
    size = struct.unpack("!I", _read_exact(stream, 4))[0]
    if not 1 <= size <= MAX_FRAME_BYTES:
        raise AuthError("Invalid credential frame size")
    raw = _read_exact(stream, size)
    try:
        payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
        if not isinstance(payload, dict):
            raise ValueError
        # Reject NaN/Infinity, including nested values accepted by json.loads.
        json.dumps(payload, allow_nan=False)
        return payload
    except (ValueError, TypeError, RecursionError):
        raise AuthError("Invalid credential frame") from None


def write_frame(stream: BinaryIO, payload: dict[str, Any]) -> None:
    try:
        raw = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    except (ValueError, TypeError, RecursionError):
        raise AuthError("Invalid credential frame") from None
    if not 1 <= len(raw) <= MAX_FRAME_BYTES:
        raise AuthError("Invalid credential frame size")
    data = struct.pack("!I", len(raw)) + raw
    offset = 0
    while offset < len(data):
        count = stream.write(data[offset:])
        if count is None or count <= 0:
            raise AuthError("Incomplete credential frame")
        offset += count
    stream.flush()
