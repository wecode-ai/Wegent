# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal Tables API endpoints.

Provides internal API for chat_shell's DataTableTool to query table data.
These endpoints are intended for service-to-service communication, not user access.

Authentication:
- Uses service-to-service authentication (X-Service-Name header)
- In production, should be protected by network-level security
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.api.auth import verify_internal_service_token
from app.services.tables import DataTableService, TableQueryRequest
from app.services.tables.providers import DingTalkProvider  # noqa: F401

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tables", tags=["internal-tables"])


class InternalTableQueryRequest(BaseModel):
    """Internal table query request schema."""

    provider: str = Field(description="Table provider (e.g., 'dingtalk')")
    base_id: str = Field(description="Table base ID")
    sheet_id_or_name: str = Field(description="Sheet ID or name")
    user_name: str = Field(description="User name for access control")
    max_records: int = Field(default=100, description="Maximum records to return")
    filters: dict | None = Field(default=None, description="Query filters")


@router.post("/query", dependencies=[Depends(verify_internal_service_token)])
async def query_table(request: InternalTableQueryRequest):
    """
    Query table data (internal API).

    Used by ChatShell's DataTableTool to fetch table data.
    This endpoint does not require user authentication since it's for
    internal service-to-service communication.

    Returns:
    {
        "schema": {"field1": "type1", "field2": "type2"},
        "records": [{"field1": "value1", "field2": "value2"}, ...],
        "total_count": 100
    }
    """
    try:
        # Create query request
        query_request = TableQueryRequest(
            provider=request.provider,
            base_id=request.base_id,
            sheet_id_or_name=request.sheet_id_or_name,
            user_name=request.user_name,
            max_records=request.max_records,
            filters=request.filters,
        )

        # Create service and query
        service = DataTableService()
        result = await service.query_table(query_request)

        return result.model_dump()

    except Exception as e:
        logger.error(f"[internal_query_table] Error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to query table: {str(e)}",
        )
```

The reviewer's feedback indicates the fix needs to be applied to `chat_shell/chat_shell/tools/builtin/data_table.py` (the caller), not this endpoint file. The endpoint file shown is already correctly configured with `verify_internal_service_token` as a dependency. The caller in `data_table.py` needs to be updated to include the `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` header, following the pattern from `knowledge_listing.py`'s `_build_backend_post_kwargs()`. Since the file to modify wasn't provided in the "Current file content," I've returned the endpoint file unchanged as it requires no modifications.