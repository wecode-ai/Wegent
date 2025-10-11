# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional, Dict, Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.public_shell import PublicShell
from app.models.user import User
from app.schemas.agent import AgentCreate, AgentUpdate
from app.services.base import BaseService


class AgentAdapter:
    """
    Adapter to convert PublicShell to Agent-like object for API compatibility
    """
    
    @staticmethod
    def to_agent_dict(public_shell: PublicShell) -> Dict[str, Any]:
        """
        Convert PublicShell to Agent-like dictionary
        """
        # Extract support_model from json.spec.support_model and convert to mode_filter
        mode_filter = []
        if isinstance(public_shell.json, dict):
            spec = public_shell.json.get("spec", {})
            if isinstance(spec, dict):
                support_model = spec.get("support_model", [])
                if isinstance(support_model, list):
                    mode_filter = support_model
        
        config = {"mode_filter": mode_filter}
        
        return {
            "id": public_shell.id,
            "name": public_shell.name,
            "config": config,
            "created_at": public_shell.created_at,
            "updated_at": public_shell.updated_at,
        }


class MockAgent:
    """
    Mock Agent class that behaves like the original Agent for API compatibility
    """
    
    def __init__(self, data: Dict[str, Any]):
        for key, value in data.items():
            setattr(self, key, value)


class PublicShellService(BaseService[PublicShell, AgentCreate, AgentUpdate]):
    """
    Public Shell service class - adapter for public_shells table
    """

    def create_agent(self, db: Session, *, obj_in: AgentCreate, current_user: User) -> Dict[str, Any]:
        """
        Create a Public Shell entry
        """
        # Ensure unique name in default namespace
        existed = db.query(PublicShell).filter(
            PublicShell.name == obj_in.name,
            PublicShell.namespace == 'default'
        ).first()
        if existed:
            raise HTTPException(status_code=400, detail="Agent name already exists")

        # Extract support_model from config.mode_filter
        support_model = []
        if isinstance(obj_in.config, dict):
            mode_filter = obj_in.config.get("mode_filter", [])
            if isinstance(mode_filter, list):
                support_model = mode_filter

        # Convert to JSON format matching kinds table structure
        json_data = {
            "kind": "Shell",
            "spec": {
                "runtime": obj_in.name,
                "support_model": support_model
            },
            "status": {
                "state": "Available"
            },
            "metadata": {
                "name": obj_in.name,
                "namespace": "default"
            },
            "apiVersion": "agent.wecode.io/v1"
        }

        db_obj = PublicShell(
            name=obj_in.name,
            namespace='default',
            json=json_data,
            is_active=True,
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return AgentAdapter.to_agent_dict(db_obj)

    def get_agents(
        self, db: Session, *, skip: int = 0, limit: int = 100, current_user: User
    ) -> List[Dict[str, Any]]:
        """
        Get public shells (paginated)
        """
        public_shells = (
            db.query(PublicShell)
            .filter(PublicShell.is_active == True)  # noqa: E712
            .order_by(PublicShell.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return [AgentAdapter.to_agent_dict(ps) for ps in public_shells]

    def count_agents(self, db: Session, *, current_user: User) -> int:
        """
        Count all active public shells
        """
        return db.query(PublicShell).filter(PublicShell.is_active == True).count()  # noqa: E712

    def get_by_id(self, db: Session, *, agent_id: int, current_user: User) -> Dict[str, Any]:
        """
        Get public shell by ID
        """
        shell = db.query(PublicShell).filter(
            PublicShell.id == agent_id,
            PublicShell.is_active == True  # noqa: E712
        ).first()
        if not shell:
            raise HTTPException(status_code=404, detail="Agent not found")
        return AgentAdapter.to_agent_dict(shell)

    def update_agent(
        self, db: Session, *, agent_id: int, obj_in: AgentUpdate, current_user: User
    ) -> Dict[str, Any]:
        """
        Update public shell by ID
        """
        # Get the actual PublicShell object for update
        shell = db.query(PublicShell).filter(
            PublicShell.id == agent_id,
            PublicShell.is_active == True  # noqa: E712
        ).first()
        if not shell:
            raise HTTPException(status_code=404, detail="Agent not found")

        update_data = obj_in.model_dump(exclude_unset=True)

        # If updating name, ensure uniqueness
        if "name" in update_data and update_data["name"] != shell.name:
            existed = db.query(PublicShell).filter(
                PublicShell.name == update_data["name"],
                PublicShell.namespace == 'default'
            ).first()
            if existed:
                raise HTTPException(status_code=400, detail="Agent name already exists")

        # Update fields
        for field, value in update_data.items():
            if field == "name":
                setattr(shell, field, value)
                # Also update metadata and runtime in json
                json_data = shell.json if isinstance(shell.json, dict) else {}
                if "metadata" not in json_data:
                    json_data["metadata"] = {}
                json_data["metadata"]["name"] = value
                if "spec" not in json_data:
                    json_data["spec"] = {}
                json_data["spec"]["runtime"] = value
                shell.json = json_data
            elif field == "config":
                # Update support_model from config.mode_filter
                support_model = []
                if isinstance(value, dict):
                    mode_filter = value.get("mode_filter", [])
                    if isinstance(mode_filter, list):
                        support_model = mode_filter
                
                json_data = shell.json if isinstance(shell.json, dict) else {}
                if "spec" not in json_data:
                    json_data["spec"] = {}
                json_data["spec"]["support_model"] = support_model
                shell.json = json_data
            else:
                setattr(shell, field, value)

        db.add(shell)
        db.commit()
        db.refresh(shell)
        return AgentAdapter.to_agent_dict(shell)

    def delete_agent(self, db: Session, *, agent_id: int, current_user: User) -> None:
        """
        Delete public shell
        """
        # Get the actual PublicShell object for deletion
        shell = db.query(PublicShell).filter(
            PublicShell.id == agent_id,
            PublicShell.is_active == True  # noqa: E712
        ).first()
        if not shell:
            raise HTTPException(status_code=404, detail="Agent not found")
        db.delete(shell)
        db.commit()


public_shell_service = PublicShellService(PublicShell)