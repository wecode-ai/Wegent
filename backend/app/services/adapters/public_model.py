# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional, Dict, Any
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.public_model import PublicModel
from app.models.public_shell import PublicShell
from app.models.user import User
from app.schemas.model import ModelCreate, ModelUpdate, ModelBulkCreateItem
from app.schemas.kind import Model, Shell
from app.services.base import BaseService


class ModelAdapter:
    """
    Adapter to convert PublicModel to Model-like object for API compatibility
    """
    
    @staticmethod
    def to_model_dict(public_model: PublicModel) -> Dict[str, Any]:
        """
        Convert PublicModel to Model-like dictionary
        """
        # Extract config from json.spec.modelConfig
        config = {}
        if isinstance(public_model.json, dict):
            model_crd = Model.model_validate(public_model.json)
            config = model_crd.spec.modelConfig
        
        return {
            "id": public_model.id,
            "name": public_model.name,
            "config": config,
            "is_active": public_model.is_active,
            "created_at": public_model.created_at,
            "updated_at": public_model.updated_at,
        }


class MockModel:
    """
    Mock Model class that behaves like the original Model for API compatibility
    """
    
    def __init__(self, data: Dict[str, Any]):
        for key, value in data.items():
            setattr(self, key, value)


class PublicModelService(BaseService[PublicModel, ModelCreate, ModelUpdate]):
    """
    Public Model service class - adapter for public_models table
    """

    def create_model(self, db: Session, *, obj_in: ModelCreate, current_user: User) -> Dict[str, Any]:
        """
        Create a Public Model entry
        """
        # Ensure unique name in default namespace
        existed = db.query(PublicModel).filter(
            PublicModel.name == obj_in.name,
            PublicModel.namespace == 'default'
        ).first()
        if existed:
            raise HTTPException(status_code=400, detail="Model name already exists")

        # Convert config to JSON format matching kinds table structure
        json_data = {
            "kind": "Model",
            "spec": {
                "modelConfig": obj_in.config
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

        db_obj = PublicModel(
            name=obj_in.name,
            namespace='default',
            json=json_data,
            is_active=obj_in.is_active if obj_in.is_active is not None else True,
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return ModelAdapter.to_model_dict(db_obj)

    def bulk_create_models(self, db: Session, *, items: List[ModelBulkCreateItem], current_user: User) -> Dict[str, Any]:
        """
        Bulk upsert public models.
        """
        created: List[PublicModel] = []
        updated: List[PublicModel] = []
        skipped: List[Dict[str, Any]] = []
        
        for it in items:
            try:
                existed = db.query(PublicModel).filter(
                    PublicModel.name == it.name,
                    PublicModel.namespace == 'default'
                ).first()
                if existed:
                    if existed:
                        # Update existing model
                        if isinstance(existed.json, dict):
                            model_crd = Model.model_validate(existed.json)
                            # Update env section
                            model_crd.spec.modelConfig["env"] = dict(it.env) if isinstance(it.env, dict) else {}
                            existed.json = model_crd.model_dump()
                        else:
                            # Fallback for invalid JSON
                            json_data = {
                                "kind": "Model",
                                "spec": {
                                    "modelConfig": {
                                        "env": dict(it.env) if isinstance(it.env, dict) else {}
                                    }
                                },
                                "status": {"state": "Available"},
                                "metadata": {"name": it.name, "namespace": "default"},
                                "apiVersion": "agent.wecode.io/v1"
                            }
                            existed.json = json_data
                    # Update is_active only if explicitly provided
                    if getattr(it, "is_active", None) is not None:
                        existed.is_active = it.is_active  # type: ignore[attr-defined]
                    
                    db.add(existed)
                    db.commit()
                    db.refresh(existed)
                    updated.append(existed)
                else:
                    # Create new
                    json_data = {
                        "kind": "Model",
                        "spec": {
                            "modelConfig": {
                                "env": it.env
                            }
                        },
                        "status": {
                            "state": "Available"
                        },
                        "metadata": {
                            "name": it.name,
                            "namespace": "default"
                        },
                        "apiVersion": "agent.wecode.io/v1"
                    }
                    
                    db_obj = PublicModel(
                        name=it.name,
                        namespace='default',
                        json=json_data,
                        is_active=getattr(it, "is_active", True),  # type: ignore[attr-defined]
                    )
                    db.add(db_obj)
                    db.commit()
                    db.refresh(db_obj)
                    created.append(db_obj)
            except Exception as e:
                db.rollback()
                skipped.append({"name": it.name, "reason": f"DB error: {str(e)}"})
        
        return {"created": created, "updated": updated, "skipped": skipped}

    def get_models(
        self, db: Session, *, skip: int = 0, limit: int = 100, current_user: User
    ) -> List[Dict[str, Any]]:
        """
        Get active public models (paginated)
        """
        public_models = (
            db.query(PublicModel)
            .filter(PublicModel.is_active == True)  # noqa: E712
            .order_by(PublicModel.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return [ModelAdapter.to_model_dict(pm) for pm in public_models]

    def count_active_models(self, db: Session, *, current_user: User) -> int:
        """
        Count active public models
        """
        return db.query(PublicModel).filter(PublicModel.is_active == True).count()  # noqa: E712

    def list_model_names(self, db: Session, *, current_user: User, agent_name: str) -> List[Dict[str, str]]:
        """
        List available model names based on shell supportModel filter
        """
        # Get shell configuration from public_shells table
        shell_row = db.query(PublicShell.json).filter(PublicShell.name == agent_name).first()
        if not shell_row:
            raise HTTPException(status_code=400, detail="Agent not found")
        
        shell_json = shell_row[0] if isinstance(shell_row[0], dict) else {}
        
        # Extract supportModel from shell spec
        supportModel: List[str] = []
        if isinstance(shell_json, dict):
            shell_crd = Shell.model_validate(shell_json)
            supportModel = shell_crd.spec.supportModel or []
            supportModel = [str(x) for x in supportModel if x]

        allow_all = len(supportModel) == 0
        models = db.query(PublicModel).filter(PublicModel.is_active == True).all()

        if allow_all:
            return [{"name": m.name} for m in models]

        allowed = set(supportModel)
        
        def get_model_provider(m: PublicModel) -> Optional[str]:
            json_data = getattr(m, "json", None)
            if not isinstance(json_data, dict):
                return None
            try:
                model_crd = Model.model_validate(json_data)
                env = model_crd.spec.modelConfig.get("env", {})
                if not isinstance(env, dict):
                    return None
                return env.get("model")
            except:
                return None

        return [{"name": m.name} for m in models if (get_model_provider(m) in allowed)]

    def get_by_id(self, db: Session, *, model_id: int, current_user: User) -> Dict[str, Any]:
        """
        Get public model by ID (only active)
        """
        model = (
            db.query(PublicModel)
            .filter(PublicModel.id == model_id, PublicModel.is_active == True)  # noqa: E712
            .first()
        )
        if not model:
            raise HTTPException(status_code=404, detail="Model not found")
        return ModelAdapter.to_model_dict(model)

    def update_model(
        self, db: Session, *, model_id: int, obj_in: ModelUpdate, current_user: User
    ) -> Dict[str, Any]:
        """
        Update public model by ID
        """
        # Get the actual PublicModel object for update
        model = (
            db.query(PublicModel)
            .filter(PublicModel.id == model_id, PublicModel.is_active == True)  # noqa: E712
            .first()
        )
        if not model:
            raise HTTPException(status_code=404, detail="Model not found")

        update_data = obj_in.model_dump(exclude_unset=True)

        # If updating name, ensure uniqueness
        if "name" in update_data and update_data["name"] != model.name:
            existed = db.query(PublicModel).filter(
                PublicModel.name == update_data["name"],
                PublicModel.namespace == 'default'
            ).first()
            if existed:
                raise HTTPException(status_code=400, detail="Model name already exists")

        # Update fields
        for field, value in update_data.items():
            if field == "name":
                setattr(model, field, value)
                # Also update metadata in json
                if isinstance(model.json, dict):
                    model_crd = Model.model_validate(model.json)
                    model_crd.metadata.name = value
                    model.json = model_crd.model_dump()
            elif field == "config":
                # Update modelConfig in json
                if isinstance(model.json, dict):
                    model_crd = Model.model_validate(model.json)
                    model_crd.spec.modelConfig = value
                    model.json = model_crd.model_dump()
            else:
                setattr(model, field, value)

        db.add(model)
        db.commit()
        db.refresh(model)
        return ModelAdapter.to_model_dict(model)

    def delete_model(self, db: Session, *, model_id: int, current_user: User) -> None:
        """
        Delete public model
        """
        # Get the actual PublicModel object for deletion
        model = (
            db.query(PublicModel)
            .filter(PublicModel.id == model_id, PublicModel.is_active == True)  # noqa: E712
            .first()
        )
        if not model:
            raise HTTPException(status_code=404, detail="Model not found")
        db.delete(model)
        db.commit()


public_model_service = PublicModelService(PublicModel)