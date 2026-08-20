# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""External event provider catalog endpoint."""

from fastapi import APIRouter, Depends

from app.core.security import get_current_user
from app.models.user import User
from app.schemas.external_event import ProviderEventTypeView
from app.services.external_events.adapters import provider_event_catalog

router = APIRouter()


@router.get("/catalog", response_model=list[ProviderEventTypeView])
def list_external_event_catalog(
    current_user: User = Depends(get_current_user),
) -> list[dict[str, str]]:
    """Return every event type the provider adapters can produce."""

    return provider_event_catalog()
