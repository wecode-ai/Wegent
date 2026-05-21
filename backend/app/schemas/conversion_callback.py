"""Pydantic schemas for conversion callback API.

These schemas define the request/response models for the HTTP callback
endpoints that the knowledge_doc_converter microservice uses to
communicate with the backend.
"""

from typing import Optional

from pydantic import BaseModel


class ConversionStatusRequest(BaseModel):
    """Request body for conversion status callback (started/failed)."""

    action: str  # "conversion_started" | "conversion_failed"
    document_id: int
    generation: int
    error_message: Optional[str] = None


class ConversionCompletedRequest(BaseModel):
    """Request body for conversion completion callback."""

    document_id: int
    generation: int
    converted_name: str
    converted_extension: str
    file_size: int
    markdown_bytes: str  # base64-encoded markdown content
    index_dispatch_payload: dict


class ConversionStatusResponse(BaseModel):
    """Response body for conversion status callback."""

    ok: bool
    document_exists: bool


class ConversionCompletedResponse(BaseModel):
    """Response body for conversion completion callback."""

    ok: bool
    index_task_id: Optional[str] = None
    skipped: bool = False
    skip_reason: Optional[str] = None
