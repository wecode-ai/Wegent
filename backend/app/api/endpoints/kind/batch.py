# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Batch operation API endpoints
"""
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.security import get_current_user
from app.models.user import User
from app.schemas.kind import BatchResponse
from app.services.k_batch import batch_service

router = APIRouter()


@router.post("/namespaces/{namespace:path}/apply", response_model=BatchResponse)
async def apply_resources(
    namespace: str,
    resources: List[Dict[str, Any]],
    current_user: User = Depends(get_current_user),
):
    """Apply multiple resources (create or update)"""
    # Ensure namespace for all resources
    for resource in resources:
        resource["metadata"]["namespace"] = namespace

    results = batch_service.apply_resources(current_user.id, resources)

    success_count = sum(1 for r in results if r["success"])
    total_count = len(results)

    return BatchResponse(
        success=success_count == total_count,
        message=f"Applied {success_count}/{total_count} resources",
        results=results,
    )


@router.post("/namespaces/{namespace:path}/delete", response_model=BatchResponse)
async def delete_resources(
    namespace: str,
    resources: List[Dict[str, Any]],
    current_user: User = Depends(get_current_user),
):
    """Delete multiple resources"""
    # Ensure namespace for all resources
    for resource in resources:
        resource["metadata"]["namespace"] = namespace

    results = batch_service.delete_resources(current_user.id, resources)

    success_count = sum(1 for r in results if r["success"])
    total_count = len(results)

    return BatchResponse(
        success=success_count == total_count,
        message=f"Deleted {success_count}/{total_count} resources",
        results=results,
    )
