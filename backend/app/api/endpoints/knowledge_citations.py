"""Read committed answer evidence with current answer and source authorization."""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.services.knowledge.answer_evidence import read_citation
from shared.telemetry.decorators import trace_sync

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/citations/{citation_id}")
@trace_sync("read_answer_citation", "knowledge.api")
def get_citation(
    response: Response,
    citation_id: Annotated[int, Path(gt=0, le=9223372036854775807)],
    answer_id: Annotated[int, Query(gt=0)],
    generation_id: Annotated[str, Query(pattern=r"^[a-f0-9]{32}$")],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return read_citation(db, current_user.id, citation_id, answer_id, generation_id)
    except HTTPException as exc:
        exc.headers = {**(exc.headers or {}), "Cache-Control": "private, no-store"}
        raise
    except Exception as exc:
        logger.error("Citation read failed: error_type=%s", type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail={"code": "CITATION_READ_FAILED"},
            headers={"Cache-Control": "private, no-store"},
        ) from None
