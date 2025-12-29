# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Container instance management APIs for persistent containers
"""
import logging
import os
from datetime import datetime
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.container_instance import ContainerInstance
from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Shell as ShellCRD

router = APIRouter()
logger = logging.getLogger(__name__)

EXECUTOR_MANAGER_URL = os.getenv("EXECUTOR_MANAGER_URL", "http://localhost:8001")


# Response Models
class ContainerInstanceResponse(BaseModel):
    """Container instance response"""

    id: int
    user_id: int
    shell_id: int
    shell_name: Optional[str] = None
    container_id: Optional[str] = None
    access_url: Optional[str] = None
    status: str
    repo_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    last_task_at: Optional[datetime] = None
    error_message: Optional[str] = None


class ContainerCreateRequest(BaseModel):
    """Request to create a persistent container"""

    shell_name: str
    repo_url: Optional[str] = None  # Optional repository to clone


class ContainerActionResponse(BaseModel):
    """Response for container actions"""

    success: bool
    message: str
    container_id: Optional[str] = None


def _get_shell_by_name(
    db: Session, shell_name: str, user_id: int
) -> tuple[Kind, ShellCRD]:
    """Get shell by name with permission check"""
    from app.services.group_permission import get_user_groups

    # Try personal namespace first
    shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )

    # If not found, try group namespaces
    if not shell:
        user_groups = get_user_groups(db, user_id)
        for group_name in user_groups:
            shell = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Shell",
                    Kind.name == shell_name,
                    Kind.namespace == group_name,
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )
            if shell:
                break

    # Try public shells
    if not shell:
        shell = (
            db.query(Kind)
            .filter(
                Kind.kind == "Shell",
                Kind.name == shell_name,
                Kind.user_id == 0,  # Public shells have user_id=0
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )

    if not shell:
        raise HTTPException(status_code=404, detail=f"Shell '{shell_name}' not found")

    shell_crd = ShellCRD.model_validate(shell.json)
    return shell, shell_crd


@router.get("", response_model=List[ContainerInstanceResponse])
def list_container_instances(
    status: Optional[str] = Query(None, description="Filter by status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    List all container instances for current user.
    """
    query = db.query(ContainerInstance).filter(
        ContainerInstance.user_id == current_user.id
    )

    if status:
        query = query.filter(ContainerInstance.status == status)

    instances = query.order_by(ContainerInstance.created_at.desc()).all()

    # Enrich with shell names
    result = []
    for instance in instances:
        shell = db.query(Kind).filter(Kind.id == instance.shell_id).first()
        shell_name = shell.name if shell else None
        result.append(
            ContainerInstanceResponse(
                id=instance.id,
                user_id=instance.user_id,
                shell_id=instance.shell_id,
                shell_name=shell_name,
                container_id=instance.container_id,
                access_url=instance.access_url,
                status=instance.status,
                repo_url=instance.repo_url,
                created_at=instance.created_at,
                updated_at=instance.updated_at,
                last_task_at=instance.last_task_at,
                error_message=instance.error_message,
            )
        )

    return result


@router.get("/{instance_id}", response_model=ContainerInstanceResponse)
def get_container_instance(
    instance_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific container instance.
    """
    instance = (
        db.query(ContainerInstance)
        .filter(
            ContainerInstance.id == instance_id,
            ContainerInstance.user_id == current_user.id,
        )
        .first()
    )

    if not instance:
        raise HTTPException(status_code=404, detail="Container instance not found")

    shell = db.query(Kind).filter(Kind.id == instance.shell_id).first()
    shell_name = shell.name if shell else None

    return ContainerInstanceResponse(
        id=instance.id,
        user_id=instance.user_id,
        shell_id=instance.shell_id,
        shell_name=shell_name,
        container_id=instance.container_id,
        access_url=instance.access_url,
        status=instance.status,
        repo_url=instance.repo_url,
        created_at=instance.created_at,
        updated_at=instance.updated_at,
        last_task_at=instance.last_task_at,
        error_message=instance.error_message,
    )


@router.post("", response_model=ContainerInstanceResponse)
async def create_container_instance(
    request: ContainerCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a new persistent container instance.

    This will:
    1. Create a record in the database
    2. Send request to executor_manager to start the container
    3. Update the record with container info when ready
    """
    # Get shell and validate it supports persistent mode
    shell, shell_crd = _get_shell_by_name(db, request.shell_name, current_user.id)

    if shell_crd.spec.workspaceType != "persistent":
        raise HTTPException(
            status_code=400,
            detail="Shell does not support persistent containers. Set workspaceType to 'persistent'",
        )

    # Check if user already has a container for this shell
    existing = (
        db.query(ContainerInstance)
        .filter(
            ContainerInstance.user_id == current_user.id,
            ContainerInstance.shell_id == shell.id,
            ContainerInstance.status.in_(["pending", "creating", "running"]),
        )
        .first()
    )

    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"You already have a container for this shell (status: {existing.status})",
        )

    # Create database record
    instance = ContainerInstance(
        user_id=current_user.id,
        shell_id=shell.id,
        status="pending",
        repo_url=request.repo_url,
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    db.add(instance)
    db.commit()
    db.refresh(instance)

    # Send request to executor_manager to create container
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{EXECUTOR_MANAGER_URL}/executor-manager/containers/create",
                json={
                    "instance_id": instance.id,
                    "user_id": current_user.id,
                    "user_name": current_user.username,
                    "shell_name": request.shell_name,
                    "shell_type": shell_crd.spec.shellType,
                    "base_image": shell_crd.spec.baseImage,
                    "repo_url": request.repo_url,
                    "resources": (
                        shell_crd.spec.resources.model_dump()
                        if shell_crd.spec.resources
                        else None
                    ),
                },
            )
            if response.status_code != 200:
                # Update status to error
                instance.status = "error"
                instance.error_message = f"Failed to create container: {response.text}"
                db.commit()
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to create container: {response.text}",
                )

            result = response.json()
            instance.status = "creating"
            if result.get("container_id"):
                instance.container_id = result["container_id"]
            db.commit()
            db.refresh(instance)

    except httpx.RequestError as e:
        instance.status = "error"
        instance.error_message = f"Request error: {str(e)}"
        db.commit()
        raise HTTPException(
            status_code=500, detail=f"Failed to connect to executor manager: {str(e)}"
        )

    return ContainerInstanceResponse(
        id=instance.id,
        user_id=instance.user_id,
        shell_id=instance.shell_id,
        shell_name=request.shell_name,
        container_id=instance.container_id,
        access_url=instance.access_url,
        status=instance.status,
        repo_url=instance.repo_url,
        created_at=instance.created_at,
        updated_at=instance.updated_at,
        last_task_at=instance.last_task_at,
        error_message=instance.error_message,
    )


@router.post("/{instance_id}/stop", response_model=ContainerActionResponse)
async def stop_container_instance(
    instance_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Stop a running container instance.
    """
    instance = (
        db.query(ContainerInstance)
        .filter(
            ContainerInstance.id == instance_id,
            ContainerInstance.user_id == current_user.id,
        )
        .first()
    )

    if not instance:
        raise HTTPException(status_code=404, detail="Container instance not found")

    if instance.status != "running":
        raise HTTPException(
            status_code=400, detail=f"Container is not running (status: {instance.status})"
        )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{EXECUTOR_MANAGER_URL}/executor-manager/containers/{instance.container_id}/stop"
            )
            if response.status_code != 200:
                raise HTTPException(
                    status_code=500, detail=f"Failed to stop container: {response.text}"
                )

            instance.status = "stopped"
            instance.updated_at = datetime.now()
            db.commit()

            return ContainerActionResponse(
                success=True,
                message="Container stopped successfully",
                container_id=instance.container_id,
            )

    except httpx.RequestError as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to connect to executor manager: {str(e)}"
        )


@router.post("/{instance_id}/start", response_model=ContainerActionResponse)
async def start_container_instance(
    instance_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Start a stopped container instance.
    """
    instance = (
        db.query(ContainerInstance)
        .filter(
            ContainerInstance.id == instance_id,
            ContainerInstance.user_id == current_user.id,
        )
        .first()
    )

    if not instance:
        raise HTTPException(status_code=404, detail="Container instance not found")

    if instance.status != "stopped":
        raise HTTPException(
            status_code=400, detail=f"Container is not stopped (status: {instance.status})"
        )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{EXECUTOR_MANAGER_URL}/executor-manager/containers/{instance.container_id}/start"
            )
            if response.status_code != 200:
                raise HTTPException(
                    status_code=500, detail=f"Failed to start container: {response.text}"
                )

            instance.status = "running"
            instance.updated_at = datetime.now()
            db.commit()

            return ContainerActionResponse(
                success=True,
                message="Container started successfully",
                container_id=instance.container_id,
            )

    except httpx.RequestError as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to connect to executor manager: {str(e)}"
        )


@router.delete("/{instance_id}", response_model=ContainerActionResponse)
async def delete_container_instance(
    instance_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a container instance.
    This will stop and remove the container if it's running.
    """
    instance = (
        db.query(ContainerInstance)
        .filter(
            ContainerInstance.id == instance_id,
            ContainerInstance.user_id == current_user.id,
        )
        .first()
    )

    if not instance:
        raise HTTPException(status_code=404, detail="Container instance not found")

    # Try to delete the container from executor manager if it exists
    if instance.container_id and instance.status in ("running", "stopped", "creating"):
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.delete(
                    f"{EXECUTOR_MANAGER_URL}/executor-manager/containers/{instance.container_id}"
                )
                if response.status_code not in (200, 404):
                    logger.warning(
                        f"Failed to delete container from executor manager: {response.text}"
                    )
        except httpx.RequestError as e:
            logger.warning(f"Failed to connect to executor manager: {str(e)}")

    # Delete from database
    db.delete(instance)
    db.commit()

    return ContainerActionResponse(
        success=True,
        message="Container instance deleted successfully",
        container_id=instance.container_id,
    )


@router.post("/callback", response_model=dict)
async def container_callback(
    instance_id: int = Query(...),
    status: str = Query(...),
    container_id: Optional[str] = Query(None),
    access_url: Optional[str] = Query(None),
    error_message: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Internal callback API for executor_manager to update container status.
    """
    instance = (
        db.query(ContainerInstance)
        .filter(ContainerInstance.id == instance_id)
        .first()
    )

    if not instance:
        raise HTTPException(status_code=404, detail="Container instance not found")

    instance.status = status
    if container_id:
        instance.container_id = container_id
    if access_url:
        instance.access_url = access_url
    if error_message:
        instance.error_message = error_message
    instance.updated_at = datetime.now()

    db.commit()

    return {"success": True, "message": "Status updated"}
