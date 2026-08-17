# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Internal API key lookup endpoint for service-to-service verification.

Other trusted services (e.g. chat_shell) sometimes need to know whether a raw
API key value is valid and, if so, which user owns it - without duplicating
the hashing/expiry/active-state rules already implemented in
``app.core.auth_utils.verify_api_key``. This endpoint exposes that check over
the internal network, authenticated by ``INTERNAL_SERVICE_TOKEN``.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.auth_utils import verify_api_key
from app.schemas.api_key import APIKeyLookupRequest, APIKeyLookupResponse
from app.services.auth.internal_service_token import verify_internal_service_token

router = APIRouter(
    prefix="/api-keys",
    tags=["api-keys-internal"],
    dependencies=[Depends(verify_internal_service_token)],
)


@router.post("/lookup", response_model=APIKeyLookupResponse)
def lookup_api_key(
    request: APIKeyLookupRequest, db: Session = Depends(get_db)
) -> APIKeyLookupResponse:
    """Look up the owner of a raw API key, if it is currently valid.

    Applies the same rules as executor authentication (active, not expired,
    personal key type, active user) - see ``verify_api_key``. Does not update
    ``last_used_at``, since this is a lookup rather than an authenticated use
    of the key.
    """
    user = verify_api_key(db, request.api_key, update_last_used_at=False)
    if not user:
        return APIKeyLookupResponse(exists=False)

    return APIKeyLookupResponse(exists=True, user_name=user.user_name)
