# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reject corrupt, unbounded, or destructive device transcript transfers."""

import base64
import gzip
import hashlib
import json
from unittest.mock import AsyncMock, Mock

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


def packed_repeated_output(output: str) -> dict:
    """Represent repeated tool output with one pooled string and many references."""
    packed = packed_transcript()
    packed["strings"] = [output]
    packed["transcript"]["turns"] = [{"output": None} for _ in range(16)]
    packed["references"] = [
        {"path": ["turns", index, "output"], "index": 0} for index in range(16)
    ]
    return packed


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
    [
        b"not gzip",
        gzip.compress(b"not JSON", mtime=0),
        gzip.compress(b"[" * 2000 + b"]" * 1999, mtime=0),
    ],
    ids=["invalid-gzip", "invalid-json", "unclosed-nested-json"],
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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "output", ["x" * 600, '雪🙂\\"\n' * 100], ids=["ascii", "unicode"]
)
async def test_expanded_references_are_bounded_before_restoration(output, monkeypatch):
    """Reject reference expansion before restoring strings or validating models."""
    packed = packed_repeated_output(output)
    raw = json.dumps(packed, ensure_ascii=False).encode()
    assert len(raw) < 4096
    packet = packet_for(gzip.compress(raw, mtime=0))
    monkeypatch.setattr(reader, "MAX_TRANSCRIPT_BYTES", 4096)
    restore = Mock(wraps=reader._restore_reference)
    validate = Mock(wraps=RuntimeTranscriptResponse.model_validate)
    monkeypatch.setattr(reader, "_restore_reference", restore)
    monkeypatch.setattr(RuntimeTranscriptResponse, "model_validate", validate)

    with pytest.raises(
        reader.RuntimeTranscriptTransferError, match="restored_size_limit"
    ):
        await read_packet(packet)

    restore.assert_not_called()
    validate.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("remaining_bytes", [0, -1], ids=["exact-limit", "over-limit"])
async def test_restored_size_counts_utf8_json_bytes(remaining_bytes, monkeypatch):
    """Include UTF-8 width, JSON escapes and every repeated string in the limit."""
    output = '雪🙂\\"\n' * 100
    packed = packed_repeated_output(output)
    expected = {
        **packed["transcript"],
        "turns": [{"output": output} for _ in range(16)],
    }
    restored_bytes = len(
        json.dumps(expected, ensure_ascii=False, separators=(",", ":")).encode()
    )
    raw = json.dumps(packed, ensure_ascii=False).encode()
    assert len(raw) < restored_bytes + remaining_bytes
    packet = packet_for(gzip.compress(raw, mtime=0))
    monkeypatch.setattr(
        reader, "MAX_TRANSCRIPT_BYTES", restored_bytes + remaining_bytes
    )

    if remaining_bytes < 0:
        with pytest.raises(
            reader.RuntimeTranscriptTransferError, match="restored_size_limit"
        ):
            await read_packet(packet)
    else:
        result = await read_packet(packet)
        assert result.turns == expected["turns"]
