"""Wire models for the Executor's lossless transcript transfer protocol."""

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class RuntimeTranscriptTransferRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    snapshot_id: str = Field(..., alias="snapshotId", pattern=r"^[a-f0-9]{64}$")
    offset: int = Field(..., gt=0)


class RuntimeTranscriptChunk(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    snapshot_id: str = Field(..., alias="snapshotId", pattern=r"^[a-f0-9]{64}$")
    encoding: Literal["gzip+base64+json"]
    total_bytes: int = Field(..., alias="totalBytes", gt=0)
    offset: int = Field(..., ge=0)
    next_offset: Optional[int] = Field(..., alias="nextOffset", gt=0)
    payload: str = Field(..., min_length=1)


class RuntimeTranscriptTransferResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    success: Literal[True]
    transcript_protocol_version: Literal[2] = Field(
        ..., alias="transcriptProtocolVersion"
    )
    transfer: RuntimeTranscriptChunk
