# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Internal API key lookup endpoint for service-to-service verification.

Other trusted services (e.g. chat_shell) sometimes need to know whether a raw
API key value is valid and, if so, which identity it represents. This reuses
the hashing/expiry/active-state rules already implemented in
``app.core.auth_utils.find_valid_api_key``. This endpoint exposes that check over
the internal network, authenticated by ``INTERNAL_SERVICE_TOKEN``.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.auth_utils import find_valid_api_key, verify_api_key
from app.models.api_key import KEY_TYPE_PERSONAL, KEY_TYPE_SERVICE
from app.schemas.api_key import APIKeyLookupRequest, APIKeyLookupResponse
from app.services.auth.internal_service_token import verify_internal_service_token
from shared.telemetry.decorators import trace_sync

router = APIRouter(
    prefix="/api-keys",
    tags=["api-keys-internal"],
    dependencies=[Depends(verify_internal_service_token)],
)


# MIGRATION-CANDIDATE(api="POST /api/internal/api-keys/lookup"): remove after final confirmation.
# @router.post("/lookup", response_model=APIKeyLookupResponse)
@trace_sync("lookup_api_key", "api_keys.internal")
def lookup_api_key(
    request: APIKeyLookupRequest, db: Session = Depends(get_db)
) -> APIKeyLookupResponse:
    """Resolve a valid service key's name before looking up a personal owner.

    Service key identities do not depend on their creator. Personal keys still
    require an active owner. Neither lookup updates ``last_used_at``.
    """
    service_key = find_valid_api_key(db, request.api_key, key_type=KEY_TYPE_SERVICE)
    if service_key:
        return APIKeyLookupResponse(
            exists=True, user_name=service_key.name, key_type=KEY_TYPE_SERVICE
        )

    user = verify_api_key(db, request.api_key, update_last_used_at=False)
    if not user:
        return APIKeyLookupResponse(exists=False)

    return APIKeyLookupResponse(
        exists=True, user_name=user.user_name, key_type=KEY_TYPE_PERSONAL
    )
