# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API contracts for Wework transcript synchronization."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TranscriptSegmentRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    client_id: str = Field(alias="clientId", min_length=1, max_length=100)
    base_sequence: int = Field(alias="baseSequence", ge=0)
    fencing_token: int = Field(alias="fencingToken", ge=1)
    title: str | None = Field(default=None, max_length=512)
    sequence: int = Field(ge=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    size_bytes: int = Field(alias="sizeBytes", gt=0)
    format: str = Field(
        pattern=r"^codex-rollout-(delta|snapshot)\.v1\.tgz\.aes256gcm$",
        max_length=64,
    )


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


class TranscriptSegmentPrepareResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    upload_url: str = Field(alias="uploadUrl")
    expires_at: datetime = Field(alias="expiresAt")


class TranscriptEncryptionKeyResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    version: int
    algorithm: str
    key: str


class TranscriptArchiveResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: int
    from_sequence: int = Field(alias="fromSequence")
    to_sequence: int = Field(alias="toSequence")
    sha256: str
    size_bytes: int = Field(alias="sizeBytes")
    format: str
    download_url: str | None = Field(default=None, alias="downloadUrl")
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


class TranscriptAppendResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    current_sequence: int = Field(alias="currentSequence")
    appended: int
