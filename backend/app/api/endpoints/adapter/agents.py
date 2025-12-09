# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.user import User
from app.schemas.agent import (
    AgentCreate,
    AgentDetail,
    AgentInDB,
    AgentListResponse,
    AgentUpdate,
)

router = APIRouter()


@router.get("", response_model=AgentListResponse)
def list_agents(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get Agent list (paginated) - User's personal shells/agents only
    """
    skip = (page - 1) * limit

    # Query user's personal shells from kinds table
    query = db.query(Kind).filter(
        Kind.user_id == current_user.id,
        Kind.kind == "Shell",
        Kind.namespace == "default",
        Kind.is_active == True,
    )

    total = query.count()
    shells = query.offset(skip).limit(limit).all()

    # Convert to AgentInDB format (legacy schema)
    items = []
    for shell in shells:
        # Extract shell info from CRD
        shell_type = shell.json.get("spec", {}).get("shellType", "")
        items.append(
            AgentInDB(
                id=shell.id,
                name=shell.name,
                agent_name=shell_type,  # shellType maps to agent_name
                is_active=shell.is_active,
                created_at=shell.created_at,
                updated_at=shell.updated_at,
            )
        )

    return {"total": total, "items": items}


@router.post("", response_model=AgentInDB, status_code=status.HTTP_201_CREATED)
def create_agent(
    agent_create: AgentCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create new Agent (Shell in CRD terms)
    """
    # Check if agent/shell already exists
    existing = (
        db.query(Kind)
        .filter(
            Kind.user_id == current_user.id,
            Kind.kind == "Shell",
            Kind.name == agent_create.name,
            Kind.namespace == "default",
            Kind.is_active == True,
        )
        .first()
    )

    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Shell '{agent_create.name}' already exists",
        )

    # Create shell in Kind table
    shell_json = {
        "kind": "Shell",
        "apiVersion": "agent.wecode.io/v1",
        "metadata": {
            "name": agent_create.name,
            "namespace": "default",
        },
        "spec": {
            "shellType": agent_create.agent_name,
            "supportModel": [],
            "baseImage": "",
        },
        "status": {"state": "Available"},
    }

    db_obj = Kind(
        user_id=current_user.id,
        kind="Shell",
        name=agent_create.name,
        namespace="default",
        json=shell_json,
        is_active=True,
    )
    db.add(db_obj)
    db.commit()
    db.refresh(db_obj)

    return AgentInDB(
        id=db_obj.id,
        name=db_obj.name,
        agent_name=agent_create.agent_name,
        is_active=db_obj.is_active,
        created_at=db_obj.created_at,
        updated_at=db_obj.updated_at,
    )


@router.get("/{agent_id}", response_model=AgentDetail)
def get_agent(
    agent_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get specified Agent details
    """
    shell = (
        db.query(Kind)
        .filter(
            Kind.id == agent_id,
            Kind.user_id == current_user.id,
            Kind.kind == "Shell",
            Kind.is_active == True,
        )
        .first()
    )

    if not shell:
        raise HTTPException(status_code=404, detail="Agent not found")

    shell_type = shell.json.get("spec", {}).get("shellType", "")
    return AgentDetail(
        id=shell.id,
        name=shell.name,
        agent_name=shell_type,
        is_active=shell.is_active,
        created_at=shell.created_at,
        updated_at=shell.updated_at,
    )


@router.put("/{agent_id}", response_model=AgentInDB)
def update_agent(
    agent_id: int,
    agent_update: AgentUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update Agent information
    """
    shell = (
        db.query(Kind)
        .filter(
            Kind.id == agent_id,
            Kind.user_id == current_user.id,
            Kind.kind == "Shell",
            Kind.is_active == True,
        )
        .first()
    )

    if not shell:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Update shell
    if agent_update.name is not None:
        # Check name uniqueness
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == current_user.id,
                Kind.kind == "Shell",
                Kind.name == agent_update.name,
                Kind.namespace == "default",
                Kind.is_active == True,
                Kind.id != agent_id,
            )
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Shell '{agent_update.name}' already exists",
            )

        shell.name = agent_update.name
        shell.json["metadata"]["name"] = agent_update.name

    if agent_update.agent_name is not None:
        shell.json["spec"]["shellType"] = agent_update.agent_name

    if agent_update.is_active is not None:
        shell.is_active = agent_update.is_active

    from datetime import datetime
    from sqlalchemy.orm.attributes import flag_modified

    flag_modified(shell, "json")
    shell.updated_at = datetime.now()
    db.commit()
    db.refresh(shell)

    shell_type = shell.json.get("spec", {}).get("shellType", "")
    return AgentInDB(
        id=shell.id,
        name=shell.name,
        agent_name=shell_type,
        is_active=shell.is_active,
        created_at=shell.created_at,
        updated_at=shell.updated_at,
    )


@router.delete("/{agent_id}")
def delete_agent(
    agent_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete Agent (soft delete)
    """
    shell = (
        db.query(Kind)
        .filter(
            Kind.id == agent_id,
            Kind.user_id == current_user.id,
            Kind.kind == "Shell",
            Kind.is_active == True,
        )
        .first()
    )

    if not shell:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Soft delete
    shell.is_active = False
    from datetime import datetime

    shell.updated_at = datetime.now()
    db.commit()

    return {"message": "Agent deleted successfully"}
