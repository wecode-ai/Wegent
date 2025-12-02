# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.public_model import PublicModel
from app.models.public_shell import PublicShell
from app.models.user import User
from app.schemas.kind import Model, Shell
from app.schemas.model import ModelBulkCreateItem, ModelCreate, ModelUpdate
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

    def create_model(
        self, db: Session, *, obj_in: ModelCreate, current_user: User
    ) -> Dict[str, Any]:
        """
        Create a Public Model entry
        """
        # Ensure unique name in default namespace
        existed = (
            db.query(PublicModel)
            .filter(PublicModel.name == obj_in.name, PublicModel.namespace == "default")
            .first()
        )
        if existed:
            raise HTTPException(status_code=400, detail="Model name already exists")

        # Convert config to JSON format matching kinds table structure
        json_data = {
            "kind": "Model",
            "spec": {"modelConfig": obj_in.config},
            "status": {"state": "Available"},
            "metadata": {"name": obj_in.name, "namespace": "default"},
            "apiVersion": "agent.wecode.io/v1",
        }

        db_obj = PublicModel(
            name=obj_in.name,
            namespace="default",
            json=json_data,
            is_active=obj_in.is_active if obj_in.is_active is not None else True,
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return ModelAdapter.to_model_dict(db_obj)

    def bulk_create_models(
        self, db: Session, *, items: List[ModelBulkCreateItem], current_user: User
    ) -> Dict[str, Any]:
        """
        Bulk upsert public models.
        """
        created: List[PublicModel] = []
        updated: List[PublicModel] = []
        skipped: List[Dict[str, Any]] = []

        for it in items:
            try:
                existed = (
                    db.query(PublicModel)
                    .filter(
                        PublicModel.name == it.name, PublicModel.namespace == "default"
                    )
                    .first()
                )
                if existed:
                    if existed:
                        # Update existing model
                        if isinstance(existed.json, dict):
                            model_crd = Model.model_validate(existed.json)
                            # Update env section
                            model_crd.spec.modelConfig["env"] = (
                                dict(it.env) if isinstance(it.env, dict) else {}
                            )
                            existed.json = model_crd.model_dump()
                        else:
                            # Fallback for invalid JSON
                            json_data = {
                                "kind": "Model",
                                "spec": {
                                    "modelConfig": {
                                        "env": (
                                            dict(it.env)
                                            if isinstance(it.env, dict)
                                            else {}
                                        )
                                    }
                                },
                                "status": {"state": "Available"},
                                "metadata": {"name": it.name, "namespace": "default"},
                                "apiVersion": "agent.wecode.io/v1",
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
                        "spec": {"modelConfig": {"env": it.env}},
                        "status": {"state": "Available"},
                        "metadata": {"name": it.name, "namespace": "default"},
                        "apiVersion": "agent.wecode.io/v1",
                    }

                    db_obj = PublicModel(
                        name=it.name,
                        namespace="default",
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
        return (
            db.query(PublicModel).filter(PublicModel.is_active == True).count()
        )  # noqa: E712

    def list_model_names(
        self, db: Session, *, current_user: User, shell_type: str
    ) -> List[Dict[str, str]]:
        """
        List available model names based on shell type and shell supportModel filter.
        Queries both user's own models (kinds table) and public models (public_models table).

        Shell type to model provider mapping:
        - Agno -> openai
        - ClaudeCode -> claude

        Returns list of dicts with 'name' and 'displayName' fields.
        """
        # Get shell configuration from public_shells table
        shell_row = (
            db.query(PublicShell.json).filter(PublicShell.name == shell_type).first()
        )
        if not shell_row:
            raise HTTPException(status_code=400, detail="Shell type not found")

        shell_json = shell_row[0] if isinstance(shell_row[0], dict) else {}

        # Extract supportModel from shell spec
        supportModel: List[str] = []
        if isinstance(shell_json, dict):
            shell_crd = Shell.model_validate(shell_json)
            supportModel = shell_crd.spec.supportModel or []
            supportModel = [str(x) for x in supportModel if x]

        # Determine required model provider based on shell_type
        # Agno uses openai protocol, ClaudeCode uses claude protocol
        shell_provider_map = {"Agno": "openai", "ClaudeCode": "claude"}
        required_provider = shell_provider_map.get(shell_type)

        # If supportModel is specified, use it; otherwise filter by agent's required provider
        use_support_model_filter = len(supportModel) > 0
        allowed = set(supportModel)

        def get_model_provider(json_data: Optional[Dict]) -> Optional[str]:
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

        def get_model_display_name(json_data: Optional[Dict]) -> Optional[str]:
            """Extract displayName from model metadata"""
            if not isinstance(json_data, dict):
                return None
            try:
                model_crd = Model.model_validate(json_data)
                return model_crd.metadata.displayName
            except:
                return None

        def is_model_compatible(json_data: Optional[Dict]) -> bool:
            provider = get_model_provider(json_data)
            if use_support_model_filter:
                # Use supportModel filter from shell spec
                return provider in allowed
            elif required_provider:
                # Filter by agent's required provider
                return provider == required_provider
            else:
                # No filter, allow all
                return True

        # Use dict to store name -> displayName mapping (to handle duplicates)
        result_models: Dict[str, Optional[str]] = {}

        # Query user's own models from kinds table
        user_models = (
            db.query(Kind)
            .filter(
                Kind.user_id == current_user.id,
                Kind.kind == "Model",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .all()
        )

        for m in user_models:
            if is_model_compatible(m.json):
                display_name = get_model_display_name(m.json)
                result_models[m.name] = display_name

        # Query public models from public_models table
        public_models = (
            db.query(PublicModel).filter(PublicModel.is_active == True).all()
        )

        for m in public_models:
            if is_model_compatible(m.json):
                # Only add if not already present (user models take precedence)
                if m.name not in result_models:
                    display_name = get_model_display_name(m.json)
                    result_models[m.name] = display_name

        return [
            {"name": name, "displayName": display_name}
            for name, display_name in sorted(result_models.items())
        ]

    def get_by_id(
        self, db: Session, *, model_id: int, current_user: User
    ) -> Dict[str, Any]:
        """
        Get public model by ID (only active)
        """
        model = (
            db.query(PublicModel)
            .filter(
                PublicModel.id == model_id, PublicModel.is_active == True
            )  # noqa: E712
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
            .filter(
                PublicModel.id == model_id, PublicModel.is_active == True
            )  # noqa: E712
            .first()
        )
        if not model:
            raise HTTPException(status_code=404, detail="Model not found")

        update_data = obj_in.model_dump(exclude_unset=True)

        # If updating name, ensure uniqueness
        if "name" in update_data and update_data["name"] != model.name:
            existed = (
                db.query(PublicModel)
                .filter(
                    PublicModel.name == update_data["name"],
                    PublicModel.namespace == "default",
                )
                .first()
            )
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
            .filter(
                PublicModel.id == model_id, PublicModel.is_active == True
            )  # noqa: E712
            .first()
        )
        if not model:
            raise HTTPException(status_code=404, detail="Model not found")
        db.delete(model)
        db.commit()


public_model_service = PublicModelService(PublicModel)
