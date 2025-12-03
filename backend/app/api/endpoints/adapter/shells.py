# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging
import os
import re
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.cache import cache_manager
from app.models.kind import Kind
from app.models.public_shell import PublicShell
from app.models.user import User
from app.schemas.kind import Shell as ShellCRD

router = APIRouter()
logger = logging.getLogger(__name__)

# Redis key prefix and TTL for validation status
VALIDATION_STATUS_KEY_PREFIX = "shell_validation:"
VALIDATION_STATUS_TTL = 300  # 5 minutes


# Request/Response Models
class UnifiedShell(BaseModel):
    """Unified shell representation for API responses"""

    name: str
    type: str  # 'public' or 'user'
    displayName: Optional[str] = None
    shellType: str  # Agent type: 'ClaudeCode', 'Agno', 'Dify', etc.
    baseImage: Optional[str] = None
    baseShellRef: Optional[str] = None
    supportModel: Optional[List[str]] = None
    executionType: Optional[str] = (
        None  # 'local_engine' or 'external_api' (from labels)
    )


class ShellCreateRequest(BaseModel):
    """Request body for creating a user shell"""

    name: str
    displayName: Optional[str] = None
    baseShellRef: str  # Required: base public shell name (e.g., "ClaudeCode")
    baseImage: str  # Required: custom base image address


class ShellUpdateRequest(BaseModel):
    """Request body for updating a user shell"""

    displayName: Optional[str] = None
    baseImage: Optional[str] = None


class ImageValidationRequest(BaseModel):
    """Request body for validating base image compatibility"""

    image: str
    shellType: str  # e.g., "ClaudeCode", "Agno"
    shellName: Optional[str] = None  # Optional shell name for tracking


class ImageCheckResult(BaseModel):
    """Individual check result"""

    name: str
    version: Optional[str] = None
    status: str  # 'pass' or 'fail'
    message: Optional[str] = None


class ImageValidationResponse(BaseModel):
    """Response for image validation - async mode returns task submission status"""

    status: str  # 'submitted', 'skipped', 'error'
    message: str
    validationId: Optional[str] = None  # UUID for polling validation status
    validationTaskId: Optional[int] = None  # Legacy field for backward compatibility
    # For immediate results (e.g., Dify skip)
    valid: Optional[bool] = None
    checks: Optional[List[ImageCheckResult]] = None
    errors: Optional[List[str]] = None


class ValidationStatusResponse(BaseModel):
    """Response for validation status query"""

    validationId: str
    status: str  # 'submitted', 'pulling_image', 'starting_container', 'running_checks', 'completed'
    stage: str  # Human-readable stage description
    progress: int  # 0-100
    valid: Optional[bool] = None
    checks: Optional[List[ImageCheckResult]] = None
    errors: Optional[List[str]] = None
    errorMessage: Optional[str] = None


class ValidationStatusUpdateRequest(BaseModel):
    """Request body for updating validation status (internal API)"""

    status: str
    stage: Optional[str] = None
    progress: Optional[int] = None
    valid: Optional[bool] = None
    checks: Optional[List[ImageCheckResult]] = None
    errors: Optional[List[str]] = None
    errorMessage: Optional[str] = None
    executor_name: Optional[str] = None  # Executor container name for cleanup


def _public_shell_to_unified(shell: PublicShell) -> UnifiedShell:
    """Convert PublicShell to UnifiedShell"""
    shell_crd = ShellCRD.model_validate(shell.json)
    labels = shell_crd.metadata.labels or {}
    return UnifiedShell(
        name=shell.name,
        type="public",
        displayName=shell_crd.metadata.displayName or shell.name,
        shellType=shell_crd.spec.shellType,
        baseImage=shell_crd.spec.baseImage,
        baseShellRef=shell_crd.spec.baseShellRef,
        supportModel=shell_crd.spec.supportModel,
        executionType=labels.get("type"),
    )


def _user_shell_to_unified(kind: Kind) -> UnifiedShell:
    """Convert Kind (user shell) to UnifiedShell"""
    shell_crd = ShellCRD.model_validate(kind.json)
    labels = shell_crd.metadata.labels or {}
    return UnifiedShell(
        name=kind.name,
        type="user",
        displayName=shell_crd.metadata.displayName or kind.name,
        shellType=shell_crd.spec.shellType,
        baseImage=shell_crd.spec.baseImage,
        baseShellRef=shell_crd.spec.baseShellRef,
        supportModel=shell_crd.spec.supportModel,
        executionType=labels.get("type"),
    )


@router.get("/unified", response_model=dict)
def list_unified_shells(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
        Get unified list of all available shells (both public and user-defined).

        Each shell includes a 'type' field ('public' or 'user') to identify its source.
    Response:
    {
      "data": [
        {
          "name": "shell-name",
          "type": "public" | "user",
          "displayName": "Human Readable Name",
          "shellType": "ClaudeCode",
          "baseImage": "ghcr.io/...",
          "executionType": "local_engine" | "external_api"
        }
      ]
    }
        }
    """
    result = []

    # Get public shells
    public_shells = (
        db.query(PublicShell)
        .filter(PublicShell.is_active == True)  # noqa: E712
        .order_by(PublicShell.name.asc())
        .all()
    )
    for shell in public_shells:
        try:
            result.append(_public_shell_to_unified(shell))
        except Exception as e:
            logger.warning(f"Failed to parse public shell {shell.name}: {e}")

    # Get user-defined shells
    user_shells = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Shell",
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .order_by(Kind.name.asc())
        .all()
    )
    for shell in user_shells:
        try:
            result.append(_user_shell_to_unified(shell))
        except Exception as e:
            logger.warning(f"Failed to parse user shell {shell.name}: {e}")

    return {"data": [s.model_dump() for s in result]}


@router.get("/unified/{shell_name}", response_model=dict)
def get_unified_shell(
    shell_name: str,
    shell_type: Optional[str] = Query(
        None, description="Shell type ('public' or 'user')"
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get a specific shell by name, optionally with type hint.

    If shell_type is not provided, it will try to find the shell
    in the following order:
    1. User's own shells (type='user')
    2. Public shells (type='public')
    """
    # Try user shells first if no type specified or type is 'user'
    if shell_type in (None, "user"):
        user_shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == current_user.id,
                Kind.kind == "Shell",
                Kind.name == shell_name,
                Kind.namespace == "default",
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )
        if user_shell:
            return _user_shell_to_unified(user_shell).model_dump()
        if shell_type == "user":
            raise HTTPException(status_code=404, detail="User shell not found")

    # Try public shells
    public_shell = (
        db.query(PublicShell)
        .filter(
            PublicShell.name == shell_name,
            PublicShell.is_active == True,  # noqa: E712
        )
        .first()
    )
    if public_shell:
        return _public_shell_to_unified(public_shell).model_dump()

    raise HTTPException(status_code=404, detail="Shell not found")


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
def create_shell(
    request: ShellCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create a user-defined shell.

    The shell must be based on an existing public shell (baseShellRef).
    """
    # Validate name format
    name_regex = r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$"
    if not re.match(name_regex, request.name):
        raise HTTPException(
            status_code=400,
            detail="Shell name must contain only lowercase letters, numbers, and hyphens",
        )

    # Check if name already exists for this user
    existing = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Shell",
            Kind.name == request.name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="Shell name already exists")

    # Validate baseShellRef - must be a public shell with local_engine type
    base_shell = (
        db.query(PublicShell)
        .filter(
            PublicShell.name == request.baseShellRef,
            PublicShell.is_active == True,  # noqa: E712
        )
        .first()
    )
    if not base_shell:
        raise HTTPException(
            status_code=400, detail=f"Base shell '{request.baseShellRef}' not found"
        )

    base_shell_crd = ShellCRD.model_validate(base_shell.json)
    base_labels = base_shell_crd.metadata.labels or {}
    if base_labels.get("type") != "local_engine":
        raise HTTPException(
            status_code=400,
            detail="Base shell must be a local_engine type (not external_api)",
        )

    # Validate baseImage format
    # Docker image name formats:
    # - image (e.g., ubuntu)
    # - image:tag (e.g., ubuntu:22.04)
    # - registry/image:tag (e.g., docker.io/library/ubuntu:22.04)
    # - registry:port/image:tag (e.g., localhost:5000/myimage:latest)
    # Pattern breakdown:
    # - Optional registry with optional port: ([a-z0-9.-]+(:[0-9]+)?/)?
    # - Image path (one or more segments): [a-z0-9._-]+(/[a-z0-9._-]+)*
    # - Optional tag: (:[a-z0-9._-]+)?
    # - Optional digest: (@sha256:[a-f0-9]+)?
    docker_image_pattern = r"^([a-z0-9.-]+(:[0-9]+)?/)?[a-z0-9._-]+(/[a-z0-9._-]+)*(:[a-z0-9._-]+)?(@sha256:[a-f0-9]+)?$"
    if not request.baseImage or not re.match(
        docker_image_pattern, request.baseImage, re.IGNORECASE
    ):
        raise HTTPException(
            status_code=400,
            detail="Invalid base image format. Expected formats: image, image:tag, registry/image:tag, or registry:port/image:tag",
        )

    # Create Shell CRD
    shell_crd = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Shell",
        "metadata": {
            "name": request.name,
            "namespace": "default",
            "displayName": request.displayName,
            "labels": {"type": "local_engine"},  # User shells inherit local_engine type
        },
        "spec": {
            "shellType": base_shell_crd.spec.shellType,  # Inherit shellType from base shell
            "supportModel": base_shell_crd.spec.supportModel or [],
            "baseImage": request.baseImage,
            "baseShellRef": request.baseShellRef,
        },
        "status": {"state": "Available"},
    }

    db_obj = Kind(
        user_id=current_user.id,
        kind="Shell",
        name=request.name,
        namespace="default",
        json=shell_crd,
        is_active=True,
    )
    db.add(db_obj)
    db.commit()
    db.refresh(db_obj)

    return _user_shell_to_unified(db_obj).model_dump()


@router.put("/{shell_name}", response_model=dict)
def update_shell(
    shell_name: str,
    request: ShellUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Update a user-defined shell.

    Only user-defined shells can be updated. Public shells are read-only.
    """
    # Get user shell
    shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )
    if not shell:
        raise HTTPException(status_code=404, detail="User shell not found")

    # Parse existing CRD
    shell_crd = ShellCRD.model_validate(shell.json)

    # Update fields
    if request.displayName is not None:
        shell_crd.metadata.displayName = request.displayName

    if request.baseImage is not None:
        # Validate baseImage format
        # Docker image name formats:
        # - image (e.g., ubuntu)
        # - image:tag (e.g., ubuntu:22.04)
        # - registry/image:tag (e.g., docker.io/library/ubuntu:22.04)
        # - registry:port/image:tag (e.g., localhost:5000/myimage:latest)
        docker_image_pattern = r"^([a-z0-9.-]+(:[0-9]+)?/)?[a-z0-9._-]+(/[a-z0-9._-]+)*(:[a-z0-9._-]+)?(@sha256:[a-f0-9]+)?$"
        if not re.match(
            docker_image_pattern,
            request.baseImage,
            re.IGNORECASE,
        ):
            raise HTTPException(
                status_code=400,
                detail="Invalid base image format. Expected formats: image, image:tag, registry/image:tag, or registry:port/image:tag",
            )
        shell_crd.spec.baseImage = request.baseImage

    # Save changes
    shell.json = shell_crd.model_dump(mode="json")
    db.add(shell)
    db.commit()
    db.refresh(shell)

    return _user_shell_to_unified(shell).model_dump()


@router.delete("/{shell_name}")
def delete_shell(
    shell_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Delete a user-defined shell.

    Only user-defined shells can be deleted. Public shells cannot be deleted.
    """
    # Get user shell
    shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )
    if not shell:
        raise HTTPException(status_code=404, detail="User shell not found")

    # Hard delete
    db.delete(shell)
    db.commit()

    return {"message": "Shell deleted successfully"}


@router.post("/validate-image", response_model=ImageValidationResponse)
async def validate_image(
    request: ImageValidationRequest,
    current_user: User = Depends(security.get_current_user),
):
    """
    Validate if a base image is compatible with a specific shell type.

    This endpoint submits an async validation task to Executor Manager:
    - The validation runs inside the target image container
    - Results are returned via callback mechanism
    - Frontend should poll GET /api/shells/validation-status/{validation_id} to get results

    Validation checks:
    - ClaudeCode: Node.js 20.x, claude-code CLI, SQLite 3.50+, Python 3.12
    - Agno: Python 3.12
    - Dify: No check needed (external_api type, returns immediately)

    Note: Validation is asynchronous to support various deployment modes
    (Docker, Kubernetes) and to perform validation inside the actual container.
    """
    import os

    import httpx

    shell_type = request.shellType
    image = request.image

    # Dify doesn't need validation - return immediately
    if shell_type == "Dify":
        return ImageValidationResponse(
            status="skipped",
            message="Dify is an external_api type and doesn't require image validation",
            valid=True,
            checks=[],
            errors=[],
        )

    # Generate UUID for validation tracking
    validation_id = str(uuid.uuid4())

    # Initialize validation status in Redis
    initial_status = {
        "validation_id": validation_id,
        "status": "submitted",
        "stage": "Validation task submitted",
        "progress": 10,
        "valid": None,
        "checks": None,
        "errors": None,
        "error_message": None,
        "image": image,
        "shell_type": shell_type,
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
    }

    try:
        # Store initial status in Redis
        cache_key = f"{VALIDATION_STATUS_KEY_PREFIX}{validation_id}"
        await cache_manager.set(cache_key, initial_status, expire=VALIDATION_STATUS_TTL)
        logger.info(f"Initialized validation status in Redis: {validation_id}")
    except Exception as e:
        logger.error(f"Failed to initialize validation status in Redis: {e}")
        # Continue even if Redis fails - validation can still work

    # Get executor manager URL from environment
    executor_manager_url = os.getenv("EXECUTOR_MANAGER_URL", "http://localhost:8001")
    validate_url = f"{executor_manager_url}/executor-manager/images/validate"

    try:
        logger.info(f"Submitting image validation task to executor manager: {image}")

        # Call executor manager's validate-image API with validation_id
        # Use AsyncClient to avoid blocking the event loop
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                validate_url,
                json={
                    "image": image,
                    "shell_type": shell_type,
                    "user_name": current_user.user_name,
                    "shell_name": request.shellName or "",
                    "validation_id": validation_id,  # Pass UUID to executor manager
                },
            )

        if response.status_code != 200:
            logger.error(
                f"Executor manager validation request failed: {response.status_code} {response.text}"
            )
            # Update Redis status to error
            await _update_validation_status(
                validation_id,
                status="completed",
                stage="Error",
                progress=100,
                valid=False,
                error_message=f"Failed to submit validation task: {response.text}",
            )
            return ImageValidationResponse(
                status="error",
                message=f"Failed to submit validation task: {response.text}",
                validationId=validation_id,
                valid=False,
                errors=[f"Executor manager error: {response.text}"],
            )

        result = response.json()
        logger.info(f"Validation task submission result: status={result.get('status')}")

        # Return the submission status with validation_id for polling
        return ImageValidationResponse(
            status=result.get("status", "error"),
            message=result.get("message", ""),
            validationId=validation_id,
            validationTaskId=result.get("validation_task_id"),
            valid=result.get("valid"),
            checks=None,
            errors=result.get("errors"),
        )

    except httpx.TimeoutException:
        logger.error(f"Timeout submitting validation task for image: {image}")
        await _update_validation_status(
            validation_id,
            status="completed",
            stage="Error",
            progress=100,
            valid=False,
            error_message="Request timed out while submitting validation task",
        )
        return ImageValidationResponse(
            status="error",
            message="Request timed out while submitting validation task",
            validationId=validation_id,
            valid=False,
            errors=["Validation request timed out"],
        )
    except httpx.RequestError as e:
        logger.error(f"Error calling executor manager: {e}")
        await _update_validation_status(
            validation_id,
            status="completed",
            stage="Error",
            progress=100,
            valid=False,
            error_message=f"Failed to connect to executor manager: {str(e)}",
        )
        return ImageValidationResponse(
            status="error",
            message=f"Failed to connect to executor manager: {str(e)}",
            validationId=validation_id,
            valid=False,
            errors=[f"Connection error: {str(e)}"],
        )
    except Exception as e:
        logger.error(f"Image validation error: {e}")
        await _update_validation_status(
            validation_id,
            status="completed",
            stage="Error",
            progress=100,
            valid=False,
            error_message=f"Validation error: {str(e)}",
        )
        return ImageValidationResponse(
            status="error",
            message=f"Validation error: {str(e)}",
            validationId=validation_id,
            valid=False,
            errors=[str(e)],
        )


async def _update_validation_status(
    validation_id: str,
    status: str,
    stage: Optional[str] = None,
    progress: Optional[int] = None,
    valid: Optional[bool] = None,
    checks: Optional[List[dict]] = None,
    errors: Optional[List[str]] = None,
    error_message: Optional[str] = None,
) -> bool:
    """Helper function to update validation status in Redis"""
    try:
        cache_key = f"{VALIDATION_STATUS_KEY_PREFIX}{validation_id}"
        existing = await cache_manager.get(cache_key)

        if existing is None:
            # Create new status if not exists
            existing = {
                "validation_id": validation_id,
                "status": "submitted",
                "stage": "Validation task submitted",
                "progress": 10,
                "valid": None,
                "checks": None,
                "errors": None,
                "error_message": None,
                "created_at": datetime.utcnow().isoformat(),
            }

        # Update fields
        existing["status"] = status
        if stage is not None:
            existing["stage"] = stage
        if progress is not None:
            existing["progress"] = progress
        if valid is not None:
            existing["valid"] = valid
        if checks is not None:
            existing["checks"] = checks
        if errors is not None:
            existing["errors"] = errors
        if error_message is not None:
            existing["error_message"] = error_message
        existing["updated_at"] = datetime.utcnow().isoformat()

        await cache_manager.set(cache_key, existing, expire=VALIDATION_STATUS_TTL)
        logger.info(f"Updated validation status: {validation_id} -> {status}")
        return True
    except Exception as e:
        logger.error(f"Failed to update validation status: {e}")
        return False


@router.get(
    "/validation-status/{validation_id}", response_model=ValidationStatusResponse
)
async def get_validation_status(
    validation_id: str,
    current_user: User = Depends(security.get_current_user),
):
    """
    Get the current status of a validation task.

    This endpoint is used by frontend to poll for validation results.
    """
    try:
        cache_key = f"{VALIDATION_STATUS_KEY_PREFIX}{validation_id}"
        status_data = await cache_manager.get(cache_key)

        if status_data is None:
            raise HTTPException(
                status_code=404,
                detail=f"Validation status not found for ID: {validation_id}",
            )

        return ValidationStatusResponse(
            validationId=validation_id,
            status=status_data.get("status", "unknown"),
            stage=status_data.get("stage", "Unknown"),
            progress=status_data.get("progress", 0),
            valid=status_data.get("valid"),
            checks=status_data.get("checks"),
            errors=status_data.get("errors"),
            errorMessage=status_data.get("error_message"),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting validation status: {e}")
        raise HTTPException(
            status_code=500, detail=f"Error getting validation status: {str(e)}"
        )


@router.post("/validation-status/{validation_id}")
async def update_validation_status(
    validation_id: str,
    request: ValidationStatusUpdateRequest,
):
    """
    Update the status of a validation task (internal API for Executor Manager callback).

    This endpoint is called by Executor Manager to update validation progress.
    Note: This is an internal API and should not be exposed publicly.

    When validation is completed (status is 'completed' or progress is 100),
    this will automatically cleanup the validation container if executor_name is provided.
    """
    try:
        success = await _update_validation_status(
            validation_id=validation_id,
            status=request.status,
            stage=request.stage,
            progress=request.progress,
            valid=request.valid,
            checks=[c.model_dump() for c in request.checks] if request.checks else None,
            errors=request.errors,
            error_message=request.errorMessage,
        )

        if not success:
            raise HTTPException(
                status_code=500, detail="Failed to update validation status"
            )

        # Cleanup validation container if validation is completed
        if request.executor_name and request.valid is True:
            await _cleanup_validation_container(request.executor_name)

        return {"status": "success", "message": "Validation status updated"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating validation status: {e}")
        raise HTTPException(
            status_code=500, detail=f"Error updating validation status: {str(e)}"
        )


async def _cleanup_validation_container(executor_name: str) -> None:
    """
    Cleanup validation container after validation is completed.

    Args:
        executor_name: Name of the executor container to delete
    """
    import httpx

    if not executor_name:
        logger.warning("No executor_name provided for cleanup")
        return

    executor_manager_url = os.getenv("EXECUTOR_MANAGER_URL", "http://localhost:8001")
    delete_url = f"{executor_manager_url}/executor-manager/executor/delete"

    try:
        logger.info(f"Cleaning up validation container: {executor_name}")
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                delete_url, json={"executor_name": executor_name}
            )

            if response.status_code == 200:
                result = response.json()
                if result.get("status") == "success":
                    logger.info(
                        f"Successfully cleaned up validation container: {executor_name}"
                    )
                else:
                    logger.warning(
                        f"Failed to cleanup validation container {executor_name}: {result.get('error_msg', 'Unknown error')}"
                    )
            else:
                logger.warning(
                    f"Failed to cleanup validation container {executor_name}: HTTP {response.status_code}"
                )
    except Exception as e:
        logger.error(f"Error cleaning up validation container {executor_name}: {e}")
        # Don't raise exception - cleanup failure should not break validation status update
