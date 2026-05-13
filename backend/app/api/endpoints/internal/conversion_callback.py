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

    # Step 2: State transition with staleness check
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

    # Step 3: Overwrite attachment with markdown
    payload = request.index_dispatch_payload
    context_service.overwrite_attachment(
        db=db,
        context_id=payload["attachment_id"],
        user_id=payload["user_id"],
        filename=request.converted_name,
        binary_data=markdown_bytes,
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
