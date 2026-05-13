"""Internal attachment download endpoint for converter service.

Allows the standalone converter microservice to download attachment
binary content via HTTP instead of direct DB access.
"""

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.models.subtask_context import ContextType, SubtaskContext
from app.services.auth.internal_service_token import verify_internal_service_token
from app.services.context.context_service import context_service

router = APIRouter(
    prefix="/attachments",
    tags=["attachments-internal"],
    dependencies=[Depends(verify_internal_service_token)],
)


@router.get("/{attachment_id}/download")
def download_attachment(attachment_id: int, db: Session = Depends(get_db)):
    """Download attachment binary content for converter service.

    Returns raw binary data as application/octet-stream.
    """
    context = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id == attachment_id,
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
        )
        .first()
    )
    if not context:
        raise HTTPException(status_code=404, detail="Attachment not found")

    binary_data = context_service.get_attachment_binary_data(db=db, context=context)
    if binary_data is None:
        raise HTTPException(status_code=404, detail="Attachment has no binary data")

    # RFC 5987: encode filename for Unicode/special chars
    # filename="..." for ASCII fallback, filename*=UTF-8''... for full encoding
    raw_name = context.original_filename
    encoded_name = quote(raw_name, safe="")
    disposition = (
        f"attachment; filename=\"{encoded_name}\"; filename*=UTF-8''{encoded_name}"
    )

    return Response(
        content=binary_data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": disposition,
        },
    )
