# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public issue endpoint for outbound skill tokens."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user_jwt_apikey_tasktoken
from app.models.user import User
from app.schemas.token_issuer import TokenIssueRequest, TokenIssueResponse
from app.services.auth.outbound_token_service import (
    OutboundTokenValidationError,
    SigningKeyNotFoundError,
    TokenIssuerNotFoundError,
    outbound_token_service,
)

router = APIRouter(prefix="/token-issuers", tags=["token-issuers"])


@router.post("/{issuer_id}/issue", response_model=TokenIssueResponse)
async def issue_outbound_token(
    issuer_id: int,
    request: TokenIssueRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
):
    try:
        return outbound_token_service.issue_token(
            db,
            issuer_id=issuer_id,
            user=current_user,
            request=request,
        )
    except TokenIssuerNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except SigningKeyNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    except OutboundTokenValidationError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
