# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Model, Shell
from app.schemas.model import ModelBulkCreateItem, ModelCreate, ModelUpdate
from app.services.adapters.shell_utils import find_shell_json
from app.services.base import BaseService


class ModelAdapter:
    """
    Adapter to convert Kind (Model) to Model-like object for API compatibility
    """

    @staticmethod
    def to_model_dict(kind: Kind) -> Dict[str, Any]:
        """
        Convert Kind (Model) to Model-like dictionary
        """
        # Extract config and displayName from json
        config = {}
        display_name = None
        if isinstance(kind.json, dict):
            model_crd = Model.model_validate(kind.json)
            config = model_crd.spec.modelConfig
            display_name = model_crd.metadata.displayName

        return {
            "id": kind.id,
            "name": kind.name,
            "displayName": display_name,
            "config": config,
            "is_active": kind.is_active,
            "created_at": kind.created_at,
            "updated_at": kind.updated_at,
        }


class MockModel:
    """
    Mock Model class that behaves like the original Model for API compatibility
    """

    def __init__(self, data: Dict[str, Any]):
        for key, value in data.items():
            setattr(self, key, value)


class PublicModelService(BaseService[Kind, ModelCreate, ModelUpdate]):
    """
    Public Model service class - queries kinds table with user_id=0
    """

    def create_model(
        self, db: Session, *, obj_in: ModelCreate, current_user: User
    ) -> Dict[str, Any]:
        """
        Create a Public Model entry in kinds table
        """
        # Ensure unique name in default namespace
        existed = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.name == obj_in.name,
                Kind.namespace == "default",
            )
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

        db_obj = Kind(
            user_id=0,
            kind="Model",
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
        Bulk upsert public models in kinds table.
        """
        created: List[Kind] = []
        updated: List[Kind] = []
        skipped: List[Dict[str, Any]] = []

        for it in items:
            try:
                existed = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.kind == "Model",
                        Kind.name == it.name,
                        Kind.namespace == "default",
                    )
                    .first()
                )
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
                                        dict(it.env) if isinstance(it.env, dict) else {}
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

                    db_obj = Kind(
                        user_id=0,
                        kind="Model",
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
        Get active public models from kinds table (paginated)
        """
        public_models = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.namespace == "default",
                Kind.is_active == True,  # noqa: E712
            )
            .order_by(Kind.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return [ModelAdapter.to_model_dict(pm) for pm in public_models]

    def count_active_models(self, db: Session, *, current_user: User) -> int:
        """
        Count active public models in kinds table
        """
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .count()
        )  # noqa: E712

    def list_model_names(
        self, db: Session, *, current_user: User, shell_type: str
    ) -> List[Dict[str, str]]:
        """
        List available model names based on shell type and shell supportModel filter.
        Queries both user's own models and public models from kinds table.

        Logic:
        - If supportModel is empty, all models are supported
        - If supportModel is not empty, only models matching the specified providers are supported

        Returns list of dicts with 'name' and 'displayName' fields.
        """
        shell_json = find_shell_json(db, shell_type, current_user.id)
        if not shell_json:
            raise HTTPException(status_code=400, detail="Shell type not found")

        supportModel: List[str] = []
        if isinstance(shell_json, dict):
            shell_crd = Shell.model_validate(shell_json)
            supportModel = shell_crd.spec.supportModel or []
            supportModel = [str(x) for x in supportModel if x]

        # If supportModel is empty, all models are supported
        # If supportModel is not empty, only filter by specified providers
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
            else:
                # supportModel is empty, all models are supported
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

        # Query public models from kinds table
        public_models = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .all()
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
        Get public model by ID from kinds table (only active)
        """
        model = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.id == model_id,
                Kind.namespace == "default",
                Kind.is_active == True,
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
        Update public model by ID in kinds table
        """
        # Get the actual Kind object for update
        model = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.id == model_id,
                Kind.namespace == "default",
                Kind.is_active == True,
            )  # noqa: E712
            .first()
        )
        if not model:
            raise HTTPException(status_code=404, detail="Model not found")

        update_data = obj_in.model_dump(exclude_unset=True)

        # If updating name, ensure uniqueness
        if "name" in update_data and update_data["name"] != model.name:
            existed = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Model",
                    Kind.name == update_data["name"],
                    Kind.namespace == "default",
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
        Delete public model from kinds table
        """
        # Get the actual Kind object for deletion
        model = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.id == model_id,
                Kind.namespace == "default",
                Kind.is_active == True,
            )  # noqa: E712
            .first()
        )
        if not model:
            raise HTTPException(status_code=404, detail="Model not found")
        db.delete(model)
        db.commit()


public_model_service = PublicModelService(Kind)
