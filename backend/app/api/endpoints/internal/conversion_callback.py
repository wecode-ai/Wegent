"""Conversion callback endpoints for knowledge_doc_converter service.

These endpoints allow the standalone converter microservice to report
conversion status changes and completed results back to the backend,
replacing the direct DB access that existed when conversion ran in-process.
"""

import base64
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.schemas.conversion_callback import (
    ConversionCompletedRequest,
    ConversionCompletedResponse,
    ConversionStatusRequest,
    ConversionStatusResponse,
)
from app.services.auth.internal_service_token import verify_internal_service_token
from app.services.context.context_service import context_service
from app.services.knowledge.index_state_machine import (
    mark_document_conversion_started,
    mark_document_conversion_succeeded,
    mark_document_index_failed,
)
from app.tasks.knowledge_tasks import index_document_task
from shared.telemetry.decorators import trace_sync

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/conversion/callback",
    tags=["conversion-callback"],
    dependencies=[Depends(verify_internal_service_token)],
)


@trace_sync("conversion_status_callback", "conversion_callback.internal")
@router.post("/status", response_model=ConversionStatusResponse)
def conversion_status_callback(
    request: ConversionStatusRequest,
    db: Session = Depends(get_db),
) -> ConversionStatusResponse:
    """Handle conversion status callbacks from converter service.

    Supports two actions:
    - conversion_started: Transition document from QUEUED to CONVERTING
    - conversion_failed: Mark document indexing as FAILED
    """
    from app.models.knowledge import KnowledgeDocument

    if request.action == "conversion_started":
        decision = mark_document_conversion_started(
            db=db, document_id=request.document_id, generation=request.generation
        )
        doc = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == request.document_id)
            .first()
        )
        return ConversionStatusResponse(
            ok=decision.should_execute,
            document_exists=doc is not None,
        )

    elif request.action == "conversion_failed":
        doc = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == request.document_id)
            .first()
        )
        if doc:
            mark_document_index_failed(
                db=db,
                document_id=request.document_id,
                generation=request.generation,
            )
        return ConversionStatusResponse(ok=True, document_exists=doc is not None)

    raise HTTPException(status_code=400, detail=f"Unknown action: {request.action}")


@trace_sync("conversion_completed_callback", "conversion_callback.internal")
@router.post("/completed", response_model=ConversionCompletedResponse)
def conversion_completed_callback(
    request: ConversionCompletedRequest,
    db: Session = Depends(get_db),
) -> ConversionCompletedResponse:
    """Handle conversion completion callback from converter service.

    Atomically performs:
    1. Validate base64 payload (fail early on bad input)
    2. State transition (CONVERTING -> QUEUED, with staleness check)
    3. Overwrite attachment with markdown content
    4. Dispatch indexing task (compensate to FAILED if dispatch fails)

    If the conversion is stale (superseded by a newer generation),
    the attachment is NOT overwritten and indexing is NOT dispatched.
    """
    # Step 1: Validate base64 payload before any DB mutation
    try:
        markdown_bytes = base64.b64decode(request.markdown_bytes, validate=True)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Invalid base64 payload for markdown_bytes",
        )

    # Step 2: Overwrite attachment BEFORE state transition
    # If overwrite fails, status remains CONVERTING and stale scanner will
    # properly mark it FAILED. This avoids metadata (file_extension, name,
    # file_size) being updated to md format while the actual attachment
    # content is still the original PDF.
    payload = request.index_dispatch_payload
    try:
        attachment_id = payload["attachment_id"]
    except KeyError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Missing key in index_dispatch_payload: {e}",
        )

    # Verify dispatch payload is bound to the correct document and KB.
    # Without this, a mis-bound callback could overwrite the right attachment
    # but then queue indexing for a different document/KB.
    from app.models.knowledge import KnowledgeDocument

    doc = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == request.document_id)
        .first()
    )
    if not doc:
        raise HTTPException(
            status_code=400,
            detail=f"Document {request.document_id} not found",
        )
    if doc.attachment_id != attachment_id:
        logger.error(
            f"[ConversionCallback] attachment_id mismatch: "
            f"document_id={request.document_id} expects attachment_id={doc.attachment_id}, "
            f"but payload provides attachment_id={attachment_id}"
        )
        raise HTTPException(
            status_code=400,
            detail="attachment_id does not belong to the target document",
        )

    payload_document_id = payload.get("document_id")
    payload_kb_id = payload.get("knowledge_base_id")
    if payload_document_id is not None and payload_document_id != doc.id:
        logger.error(
            f"[ConversionCallback] document_id mismatch in payload: "
            f"expected={doc.id}, got={payload_document_id}"
        )
        raise HTTPException(
            status_code=400,
            detail="payload document_id does not match the target document",
        )
    if payload_kb_id is not None and str(doc.kind_id) != str(payload_kb_id):
        logger.error(
            f"[ConversionCallback] knowledge_base_id mismatch in payload: "
            f"expected={doc.kind_id}, got={payload_kb_id}"
        )
        raise HTTPException(
            status_code=400,
            detail="payload knowledge_base_id does not match the target document's KB",
        )

    try:
        context_service.overwrite_attachment_internal(
            db=db,
            context_id=attachment_id,
            filename=request.converted_name,
            reason="conversion_callback",
            binary_data=markdown_bytes,
        )
    except Exception:
        logger.exception(
            f"[ConversionCallback] Attachment overwrite failed: "
            f"document_id={request.document_id}"
        )
        raise

    # Step 3: State transition with staleness check (after attachment overwrite)
    succeeded = mark_document_conversion_succeeded(
        db=db,
        document_id=request.document_id,
        generation=request.generation,
        converted_extension=request.converted_extension,
        converted_name=request.converted_name,
        converted_file_size=request.file_size,
    )
    if not succeeded:
        return ConversionCompletedResponse(
            ok=True, skipped=True, skip_reason="stale_conversion"
        )

    # Step 4: Dispatch indexing task (compensate on failure)
    try:
        async_result = index_document_task.delay(**payload)
    except Exception:
        logger.exception(
            f"[ConversionCallback] Failed to dispatch index task: "
            f"document_id={request.document_id}, compensating with FAILED status"
        )
        mark_document_index_failed(
            db=db,
            document_id=request.document_id,
            generation=request.generation,
        )
        raise

    logger.info(
        f"[ConversionCallback] Completed: document_id={request.document_id}, "
        f"index_task_id={async_result.id}"
    )
    return ConversionCompletedResponse(
        ok=True, index_task_id=async_result.id, skipped=False
    )
