# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated generic storage endpoints for DSH plugins."""

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.dsh_plugin_storage import (
    DshSharedStorageResponse,
    DshStorageDescriptor,
    DshStorageGlobalWrite,
    DshStorageRecordWrite,
    DshStorageSnapshot,
)
from app.services.dsh_plugin_storage import dsh_plugin_storage_service

router = APIRouter()


@router.post("/units/{unit}/load", response_model=DshStorageSnapshot)
def load_unit(
    unit: str,
    descriptor: DshStorageDescriptor,
    package_name: str = Query(alias="package"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return dsh_plugin_storage_service.load_unit(
        db, current_user.id, package_name, unit, descriptor
    )


@router.put(
    "/units/{unit}/tables/{table}/records/{key}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def put_record(
    unit: str,
    table: str,
    key: str,
    request: DshStorageRecordWrite,
    package_name: str = Query(alias="package"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    dsh_plugin_storage_service.put_record(
        db,
        current_user.id,
        package_name,
        unit,
        table,
        key,
        request,
        request.value,
        request.shared,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/units/{unit}/tables/{table}/records/{key}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_record(
    unit: str,
    table: str,
    key: str,
    descriptor: DshStorageDescriptor,
    package_name: str = Query(alias="package"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    dsh_plugin_storage_service.delete_record(
        db, current_user.id, package_name, unit, table, key, descriptor
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/units/{unit}/global", status_code=status.HTTP_204_NO_CONTENT)
def set_global(
    unit: str,
    request: DshStorageGlobalWrite,
    package_name: str = Query(alias="package"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    dsh_plugin_storage_service.set_global(
        db, current_user.id, package_name, unit, request, request.value
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/units/{unit}/tables/{table}/shared",
    response_model=DshSharedStorageResponse,
)
def scan_shared_records(
    unit: str,
    table: str,
    package_name: str = Query(alias="package"),
    limit: int = Query(default=500, ge=1, le=500),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    del current_user
    return {
        "records": dsh_plugin_storage_service.scan_shared(
            db, package_name, unit, table, limit
        )
    }
