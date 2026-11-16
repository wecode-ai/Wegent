# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP response policy for content deletion and cleanup confirmation."""

from fastapi import HTTPException, Response
from fastapi.responses import JSONResponse

from app.schemas.knowledge import BatchDeletionResult
from app.services.knowledge.deletion_cleanup import IndexCleanupConfirmationRequired
from app.services.rag.remote_gateway import RemoteRagGatewayError
from shared.knowledge_cleanup import EXTERNAL_CLEANUP_ERROR, ContentDeletionOutcome


def confirmation_required_response(
    error: IndexCleanupConfirmationRequired,
) -> HTTPException:
    """Expose a safe continuation verdict, never raw SDK response data."""
    return HTTPException(
        status_code=502,
        detail={
            "code": EXTERNAL_CLEANUP_ERROR,
            "message": str(error),
            **error.outcome.model_dump(),
        },
    )


def deletion_response(
    outcome: ContentDeletionOutcome | None, include_result: bool
) -> Response:
    if not include_result:
        return Response(status_code=204)
    if outcome is None:
        raise RuntimeError("Content deletion outcome is required")
    return JSONResponse(outcome.model_dump())


def cleanup_failure_response(error: RemoteRagGatewayError) -> HTTPException:
    """An upstream service token failure must not log the Wegent caller out."""
    if error.status_code == 401:
        code = "cleanup_service_authentication_failed"
        return HTTPException(
            status_code=502,
            detail={
                "code": code,
                "message": "Index cleanup service authentication failed",
                **ContentDeletionOutcome(
                    index_cleanup="unconfirmed", error_code=code
                ).model_dump(),
            },
        )
    return HTTPException(status_code=error.status_code or 502, detail=str(error))


def check_batch_deletion_response(
    result: BatchDeletionResult, include_result: bool
) -> None:
    """Legacy errors are derived from item codes, never human-readable messages."""
    if include_result or result.success_count or not result.failed_count:
        return
    codes = {item.error_code for item in result.items}
    status = 502
    if codes == {"document_not_found"}:
        status = 404
    elif codes and codes <= {"permission_denied", "deletion_rejected"}:
        status = 403
    raise HTTPException(status_code=status, detail=result.message)
