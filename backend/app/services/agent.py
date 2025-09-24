# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.agent import Agent
from app.models.user import User
from app.schemas.agent import AgentCreate, AgentUpdate
from app.services.base import BaseService


class AgentService(BaseService[Agent, AgentCreate, AgentUpdate]):
    """
    Agent service class
    """

    def create_agent(self, db: Session, *, obj_in: AgentCreate, current_user: User) -> Agent:
        """
        Create an Agent entry
        """
        existed = db.query(Agent).filter(Agent.name == obj_in.name).first()
        if existed:
            raise HTTPException(status_code=400, detail="Agent name already exists")

        db_obj = Agent(
            name=obj_in.name,
            config=obj_in.config,
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return db_obj

    def get_agents(
        self, db: Session, *, skip: int = 0, limit: int = 100, current_user: User
    ) -> List[Agent]:
        """
        Get agents (paginated)
        """
        return (
            db.query(Agent)
            .order_by(Agent.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    def count_agents(self, db: Session, *, current_user: User) -> int:
        """
        Count all agents
        """
        return db.query(Agent).count()

    def get_by_id(self, db: Session, *, agent_id: int, current_user: User) -> Optional[Agent]:
        """
        Get agent by ID
        """
        agent = db.query(Agent).filter(Agent.id == agent_id).first()
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")
        return agent

    def update_agent(
        self, db: Session, *, agent_id: int, obj_in: AgentUpdate, current_user: User
    ) -> Agent:
        """
        Update agent by ID
        """
        agent = self.get_by_id(db, agent_id=agent_id, current_user=current_user)

        update_data = obj_in.model_dump(exclude_unset=True)

        # If updating name, ensure uniqueness
        if "name" in update_data and update_data["name"] != agent.name:
            existed = db.query(Agent).filter(Agent.name == update_data["name"]).first()
            if existed:
                raise HTTPException(status_code=400, detail="Agent name already exists")

        for field, value in update_data.items():
            setattr(agent, field, value)

        db.add(agent)
        db.commit()
        db.refresh(agent)
        return agent

    def delete_agent(self, db: Session, *, agent_id: int, current_user: User) -> None:
        """
        Delete agent
        """
        agent = self.get_by_id(db, agent_id=agent_id, current_user=current_user)
        db.delete(agent)
        db.commit()


agent_service = AgentService(Agent)