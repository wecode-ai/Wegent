# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reject corrupt, unbounded, or destructive device transcript transfers."""

import base64
import gzip
import hashlib
import json
from unittest.mock import AsyncMock

import pytest

from app.schemas.runtime_transcript_transport import RuntimeTranscriptChunkResponse
from app.schemas.runtime_work import RuntimeTranscriptRequest, RuntimeTranscriptResponse
from app.services import runtime_transcript_reader as reader


def packed_transcript(reference: dict | None = None) -> dict:
    """Build a packed transcript with one replaceable string-reference fixture."""
    return {
        "transcript": {
            "taskId": "task-1",
            "workspacePath": "/workspace",
            "runtime": "codex",
            "messages": [],
            "turns": [{"output": None}],
        },
        "strings": ["complete output"],
        "references": [
            (
                reference
                if reference is not None
                else {"path": ["turns", 0, "output"], "index": 0}
            )
        ],
    }


def packet_for(data: bytes) -> RuntimeTranscriptChunkResponse:
    """Wrap supplied bytes in a single packet with their matching snapshot digest."""
    return RuntimeTranscriptChunkResponse.model_validate(
        {
            "success": True,
            "transcriptProtocolVersion": 2,
            "transfer": {
                "snapshotId": hashlib.sha256(data).hexdigest(),
                "encoding": "gzip+base64+json",
                "offset": 0,
                "nextOffset": None,
                "totalBytes": len(data),
                "payload": base64.b64encode(data).decode(),
            },
        }
    )


async def read_packet(
    packet: RuntimeTranscriptChunkResponse,
) -> RuntimeTranscriptResponse:
    """Exercise snapshot reconstruction through a single mocked device read."""
    request = RuntimeTranscriptRequest(deviceId="device-1", taskId="task-1")
    return await reader.read_complete_transcript(
        request, AsyncMock(return_value=packet)
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reference",
    [
        {"path": ["turns", 0, "output"], "index": True},
        {"path": ["turns", 0, "output"], "index": -1},
        {"path": ["turns", 0, "output"], "index": 1},
        {"path": [], "index": 0},
        {"path": ["turns", -1, "output"], "index": 0},
        {"path": ["turns", True, "output"], "index": 0},
        {"path": ["turns", 0, "missing"], "index": 0},
        {"path": ["taskId"], "index": 0},
    ],
)
async def test_reference_cannot_overwrite_or_address_unrelated_data(reference):
    """Reject invalid reference types, out-of-range paths and occupied slots."""
    packet = packet_for(
        gzip.compress(json.dumps(packed_transcript(reference)).encode())
    )

    with pytest.raises(reader.RuntimeTranscriptTransferError):
        await read_packet(packet)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data",
    [b"not gzip", gzip.compress(b"not JSON"), gzip.compress(b"[" * 2000 + b"]" * 1999)],
)
async def test_invalid_snapshot_encoding_is_rejected(data):
    """Normalize gzip and JSON decoding failures to the stable encoding error."""
    with pytest.raises(
        reader.RuntimeTranscriptTransferError, match="invalid_snapshot_encoding"
    ):
        await read_packet(packet_for(data))


@pytest.mark.asyncio
async def test_json_recursion_error_is_rejected(monkeypatch):
    """Normalize parser recursion failures independently of Python depth limits."""
    packet = packet_for(gzip.compress(b"{}"))

    def reject_deep_json(_raw):
        """Simulate the JSON decoder reaching its nesting limit."""
        raise RecursionError("JSON nesting exceeds the parser limit")

    monkeypatch.setattr(reader.json, "loads", reject_deep_json)

    with pytest.raises(
        reader.RuntimeTranscriptTransferError, match="invalid_snapshot_encoding"
    ):
        await read_packet(packet)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "packed", [{}, [], {"transcript": {}, "strings": [3], "references": []}]
)
async def test_invalid_snapshot_structure_is_rejected(packed):
    """Reject decoded JSON that does not satisfy the packed transcript contract."""
    packet = packet_for(gzip.compress(json.dumps(packed).encode()))

    with pytest.raises(
        reader.RuntimeTranscriptTransferError, match="invalid_snapshot_structure"
    ):
        await read_packet(packet)


@pytest.mark.asyncio
async def test_compressed_size_is_bounded_before_fetching_more_chunks(monkeypatch):
    """Reject an oversized advertised snapshot before requesting continuations."""
    packet = packet_for(gzip.compress(json.dumps(packed_transcript()).encode()))
    monkeypatch.setattr(reader, "MAX_TRANSCRIPT_BYTES", packet.transfer.total_bytes - 1)

    with pytest.raises(
        reader.RuntimeTranscriptTransferError, match="encoded_size_limit"
    ):
        await read_packet(packet)


@pytest.mark.asyncio
async def test_decompressed_size_is_bounded(monkeypatch):
    """Bound decoded JSON even when its compressed representation is small."""
    packed = packed_transcript()
    packed["strings"] = ["x" * 10_000]
    packet = packet_for(gzip.compress(json.dumps(packed).encode()))
    monkeypatch.setattr(reader, "MAX_TRANSCRIPT_BYTES", 1_000)

    with pytest.raises(
        reader.RuntimeTranscriptTransferError, match="decoded_size_limit"
    ):
        await read_packet(packet)
