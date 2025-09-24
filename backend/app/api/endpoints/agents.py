# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.agent import (
    AgentCreate,
    AgentUpdate,
    AgentInDB,
    AgentListResponse,
    AgentDetail,
)
from app.services.agent import agent_service

router = APIRouter()


@router.get("", response_model=AgentListResponse)
def list_agents(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get Agent list (paginated)
    """
    skip = (page - 1) * limit
    items = agent_service.get_agents(db=db, skip=skip, limit=limit, current_user=current_user)
    total = agent_service.count_agents(db=db, current_user=current_user)
    return {"total": total, "items": items}


@router.post("", response_model=AgentInDB, status_code=status.HTTP_201_CREATED)
def create_agent(
    agent_create: AgentCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create new Agent
    """
    return agent_service.create_agent(db=db, obj_in=agent_create, current_user=current_user)


@router.get("/{agent_id}", response_model=AgentDetail)
def get_agent(
    agent_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get specified Agent details
    """
    agent = agent_service.get_by_id(db=db, agent_id=agent_id, current_user=current_user)
    return agent


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
    return agent_service.update_agent(db=db, agent_id=agent_id, obj_in=agent_update, current_user=current_user)


@router.delete("/{agent_id}")
def delete_agent(
    agent_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete Agent
    """
    agent_service.delete_agent(db=db, agent_id=agent_id, current_user=current_user)
    return {"message": "Agent deleted successfully"}