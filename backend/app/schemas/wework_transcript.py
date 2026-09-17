# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API contracts for Wework transcript synchronization."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

MAX_ENCRYPTED_TRANSCRIPT_SEGMENT_BYTES = 256 * 1024 * 1024 + 33


class TranscriptSegmentRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    client_id: str = Field(alias="clientId", min_length=1, max_length=100)
    base_sequence: int = Field(alias="baseSequence", ge=0)
    fencing_token: int = Field(alias="fencingToken", ge=1)
    title: str | None = Field(default=None, max_length=512)
    sequence: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int = Field(
        alias="sizeBytes",
        gt=0,
        le=MAX_ENCRYPTED_TRANSCRIPT_SEGMENT_BYTES,
    )
    format: str = Field(
        pattern=r"^codex-(delta|snapshot)\.v1\.tgz\.aes256gcm$",
        max_length=32,
    )


class TranscriptSegmentCommitRequest(TranscriptSegmentRequest):
    turn_id: str = Field(alias="turnId", min_length=1, max_length=100)
    summary: dict[str, Any]


class TranscriptLeaseRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    client_id: str = Field(alias="clientId", min_length=1, max_length=100)
    ttl_seconds: int = Field(default=60, alias="ttlSeconds", ge=15, le=300)
    title: str | None = Field(default=None, max_length=512)
    parent_transcript_id: str | None = Field(
        default=None,
        alias="parentTranscriptId",
        min_length=1,
        max_length=100,
    )
    forked_at_sequence: int | None = Field(
        default=None,
        alias="forkedAtSequence",
        ge=0,
    )


class TranscriptLeaseReleaseRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    client_id: str = Field(alias="clientId", min_length=1, max_length=100)
    fencing_token: int = Field(alias="fencingToken", ge=1)


class TranscriptArchiveRequest(TranscriptLeaseReleaseRequest):
    pass


class TranscriptLeaseResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    transcript_id: str = Field(alias="transcriptId")
    client_id: str = Field(alias="clientId")
    fencing_token: int = Field(alias="fencingToken")
    expires_at: datetime = Field(alias="expiresAt")
    current_sequence: int = Field(alias="currentSequence")


class TranscriptEncryptionKeyResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    algorithm: str
    key: str


class TranscriptTurnResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    turn_id: str = Field(alias="turnId")
    sequence: int
    payload: dict[str, Any]
    created_at: datetime = Field(alias="createdAt")


class TranscriptArchiveResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: int
    from_sequence: int = Field(alias="fromSequence")
    to_sequence: int = Field(alias="toSequence")
    sha256: str
    size_bytes: int = Field(alias="sizeBytes")
    format: str
    created_at: datetime = Field(alias="createdAt")


class TranscriptResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    transcript_id: str = Field(alias="transcriptId")
    parent_transcript_id: str | None = Field(alias="parentTranscriptId")
    forked_at_sequence: int | None = Field(alias="forkedAtSequence")
    title: str
    state: str
    current_sequence: int = Field(alias="currentSequence")
    archived_through_sequence: int = Field(alias="archivedThroughSequence")
    writer_client_id: str | None = Field(alias="writerClientId")
    writer_lease_expires_at: datetime | None = Field(alias="writerLeaseExpiresAt")
    archives: list[TranscriptArchiveResponse] = Field(default_factory=list)
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")
    archived_at: datetime | None = Field(alias="archivedAt")


class TranscriptListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    items: list[TranscriptResponse]


class TranscriptTurnsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    turns: list[TranscriptTurnResponse]
    current_sequence: int = Field(alias="currentSequence")
    archived_through_sequence: int = Field(alias="archivedThroughSequence")
    has_more: bool = Field(alias="hasMore")


class TranscriptAppendResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    current_sequence: int = Field(alias="currentSequence")
    appended: int
