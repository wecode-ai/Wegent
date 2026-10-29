# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read device transcript chunks while retaining the canonical HTTP contract."""

import asyncio
import base64
import binascii
import gzip
import hashlib
import io
import json
import zlib
from collections.abc import Awaitable, Callable
from typing import Any

from app.schemas.runtime_transcript_transport import (
    TRANSCRIPT_CHUNK_BYTES,
    RuntimeTranscriptChunkResponse,
    RuntimeTranscriptTransferRequest,
)
from app.schemas.runtime_work import RuntimeTranscriptRequest, RuntimeTranscriptResponse

# Bound both accumulated transport data and decompressed device-controlled JSON.
MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024
TranscriptPacket = RuntimeTranscriptResponse | RuntimeTranscriptChunkResponse
TranscriptRead = Callable[[RuntimeTranscriptRequest], Awaitable[TranscriptPacket]]


class RuntimeTranscriptTransferError(ValueError):
    """A stable diagnostic reason without device-controlled transcript contents."""


async def read_complete_transcript(
    address: RuntimeTranscriptRequest, read: TranscriptRead
) -> RuntimeTranscriptResponse:
    """Assemble a validated v2 snapshot, reauthorizing through each read callback."""
    request = address.model_copy(
        update={"transcript_protocol_version": 2, "transcript_transfer": None}
    )
    packet = await read(request)
    # The v2 protocol permits older Executors to return their canonical response.
    if isinstance(packet, RuntimeTranscriptResponse):
        return packet
    snapshot = packet.transfer.snapshot_id
    total = packet.transfer.total_bytes
    if total > MAX_TRANSCRIPT_BYTES:
        raise RuntimeTranscriptTransferError("encoded_size_limit")
    data = bytearray()
    while True:
        if not isinstance(packet, RuntimeTranscriptChunkResponse):
            raise RuntimeTranscriptTransferError("invalid_continuation")
        transfer = packet.transfer
        if (
            transfer.snapshot_id != snapshot
            or transfer.total_bytes != total
            or transfer.offset != len(data)
        ):
            raise RuntimeTranscriptTransferError("inconsistent_snapshot")
        chunk = _decode_chunk(transfer.payload)
        data.extend(chunk)
        if len(data) > total:
            raise RuntimeTranscriptTransferError("invalid_chunk_size")
        if transfer.next_offset is None:
            if len(data) != total:
                raise RuntimeTranscriptTransferError("incomplete_snapshot")
            break
        if transfer.next_offset != len(data):
            raise RuntimeTranscriptTransferError("invalid_chunk_offset")
        continuation = RuntimeTranscriptTransferRequest(
            snapshotId=snapshot, offset=len(data)
        )
        # The supplied reader rechecks the caller's authorization for every chunk.
        packet = await read(
            request.model_copy(update={"transcript_transfer": continuation})
        )
    return await asyncio.to_thread(_unpack_transcript, bytes(data), snapshot)


def _decode_chunk(payload: str) -> bytes:
    """Decode strict Base64 and enforce the nonempty per-packet byte limit."""
    try:
        chunk = base64.b64decode(payload, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise RuntimeTranscriptTransferError("invalid_base64") from exc
    if not chunk or len(chunk) > TRANSCRIPT_CHUNK_BYTES:
        raise RuntimeTranscriptTransferError("invalid_chunk_size")
    return chunk


def _unpack_transcript(data: bytes, snapshot: str) -> RuntimeTranscriptResponse:
    """Verify the snapshot digest and decode bounded JSON with restored strings."""
    if hashlib.sha256(data).hexdigest() != snapshot:
        raise RuntimeTranscriptTransferError("snapshot_digest_mismatch")
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
            raw = stream.read(MAX_TRANSCRIPT_BYTES + 1)
        if len(raw) > MAX_TRANSCRIPT_BYTES:
            raise RuntimeTranscriptTransferError("decoded_size_limit")
        packed = json.loads(raw)
    except (OSError, EOFError, ValueError, RecursionError, zlib.error) as exc:
        if isinstance(exc, RuntimeTranscriptTransferError):
            raise
        raise RuntimeTranscriptTransferError("invalid_snapshot_encoding") from exc
    if not isinstance(packed, dict) or not isinstance(packed.get("transcript"), dict):
        raise RuntimeTranscriptTransferError("invalid_snapshot_structure")
    strings = packed.get("strings")
    references = packed.get("references")
    if (
        not isinstance(strings, list)
        or not all(isinstance(value, str) for value in strings)
        or not isinstance(references, list)
    ):
        raise RuntimeTranscriptTransferError("invalid_snapshot_structure")
    transcript = packed["transcript"]
    for reference in references:
        _restore_reference(transcript, strings, reference)
    return RuntimeTranscriptResponse.model_validate(transcript)


def _restore_reference(
    transcript: dict[str, Any], strings: list[str], reference: Any
) -> None:
    """Restore a string only into an existing empty slot with a valid typed path."""
    if not isinstance(reference, dict):
        raise RuntimeTranscriptTransferError("invalid_string_reference")
    path, index = reference.get("path"), reference.get("index")
    if (
        not isinstance(path, list)
        or not path
        or type(index) is not int
        or not 0 <= index < len(strings)
    ):
        raise RuntimeTranscriptTransferError("invalid_string_reference")
    target: Any = transcript
    for position, key in enumerate(path):
        if isinstance(target, dict) and isinstance(key, str) and key in target:
            pass
        elif isinstance(target, list) and type(key) is int and 0 <= key < len(target):
            pass
        else:
            raise RuntimeTranscriptTransferError("invalid_string_reference")
        if position == len(path) - 1:
            if target[key] is not None:
                raise RuntimeTranscriptTransferError("occupied_string_reference")
            target[key] = strings[index]
        else:
            target = target[key]
