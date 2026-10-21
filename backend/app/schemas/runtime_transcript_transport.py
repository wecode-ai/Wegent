# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Opaque transfer contracts shared by HTTP transcript requests and responses."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

TRANSCRIPT_CHUNK_BYTES = 360 * 1024


class RuntimeTranscriptTransferRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, strict=True)

    snapshot_id: str = Field(alias="snapshotId", pattern=r"^[a-f0-9]{64}$")
    offset: int = Field(gt=0, multiple_of=TRANSCRIPT_CHUNK_BYTES)


class RuntimeTranscriptTransferChunk(BaseModel):
    model_config = ConfigDict(populate_by_name=True, strict=True)

    snapshot_id: str = Field(alias="snapshotId", pattern=r"^[a-f0-9]{64}$")
    encoding: Literal["gzip+base64+json"]
    offset: int = Field(ge=0, multiple_of=TRANSCRIPT_CHUNK_BYTES)
    next_offset: int | None = Field(alias="nextOffset", gt=0)
    total_bytes: int = Field(alias="totalBytes", gt=0)
    payload: str = Field(min_length=1, max_length=TRANSCRIPT_CHUNK_BYTES * 4 // 3)

    @model_validator(mode="after")
    def validate_offsets(self) -> "RuntimeTranscriptTransferChunk":
        if self.offset >= self.total_bytes:
            raise ValueError("Transcript chunk exceeds snapshot")
        if self.next_offset is not None and not (
            self.offset < self.next_offset < self.total_bytes
        ):
            raise ValueError("Invalid transcript continuation offset")
        return self


class RuntimeTranscriptChunkResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True, strict=True)

    success: Literal[True]
    transcript_protocol_version: Literal[2] = Field(alias="transcriptProtocolVersion")
    transfer: RuntimeTranscriptTransferChunk
